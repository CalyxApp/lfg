// Converse — realtime voice gateway (OpenAI gpt-realtime-2.1).
//
// A NEW, SEPARATE voice interface, additive to the existing ElevenLabs/LiveKit
// cascade (voice-eleven-llm.ts / voice-call.tsx) — it shares NOTHING with it but
// the tool backend. The browser holds the WebRTC peer connection directly to
// OpenAI; this module only (a) mints short-lived ephemeral tokens so the real
// OPENAI_API_KEY never reaches the browser, (b) runs the tool calls the browser
// relays, and (c) persists a finished conversation as an ai-voice-conversation
// note. See docs/voice-agent-architecture.md (Rev 4) in the extension repo.
//
// Auth follows the lfg convention: no middleware — the server is loopback/Tailscale
// only, and "user" is the soft ?user= identity, hashed into OpenAI-Safety-Identifier.

import { createHash } from "node:crypto";
import { writeRepoFile, withRepoLock, gitCommitPaths } from "./files.ts";
import { slugify, buildFrontmatter, VAULT_TOOL_SCHEMAS, runVaultTool } from "./vault-tools.ts";

const MODEL = "gpt-realtime-2.1-mini";
const CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";

// ---- small local Response helpers (serve.ts's json/err are module-private) ----
function json(obj: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(obj), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}
function err(status: number, message: string) {
  return json({ error: message }, { status });
}

// Vault tool suite (navigate / retrieve / introspect / create / edit) — see vault-tools.ts.
// slugify + buildFrontmatter live there too (saveConversation below reuses them).
const TOOLS = VAULT_TOOL_SCHEMAS;

function buildSessionConfig() {
  return {
    type: "realtime",
    model: MODEL,
    output_modalities: ["audio"],
    reasoning: { effort: "low" },
    instructions:
      "You are Calyx's voice assistant — warm, brief, and natural. You help the user work with their " +
      "vault of notes by voice: explore it (describe_vault, browse), find things (search, list_by_type), " +
      "read a note, create or update notes, and start whole projects (create_project). For current events or " +
      "facts outside the vault, use web_search. When you're unsure what note types, tags, or projects " +
      "exist, call describe_vault first to learn the real names before searching or creating. Keep spoken " +
      "replies to one or two sentences; when you use a tool, say what you're doing in a few words. Read a " +
      "note before answering questions about it — never invent file contents; if a search returns nothing, " +
      "say so. Confirm the title before you finish creating or changing a note.",
    audio: {
      input: {
        transcription: { model: "gpt-4o-transcribe" },
        // Server-side ambient-noise filter so background sound doesn't get read
        // as speech and barge in on the assistant. near_field = phone held close.
        noise_reduction: { type: "near_field" },
        turn_detection: {
          type: "semantic_vad",
          // "low" is less eager to treat incidental sound as the user taking a
          // turn, which cut the assistant off mid-reply. If noise still barges
          // in, switch to server_vad with an explicit numeric `threshold`.
          eagerness: "low",
          create_response: true,
          interrupt_response: true,
        },
      },
      output: { voice: "marin" },
    },
    tools: TOOLS,
    tool_choice: "auto",
  };
}

/**
 * POST /api/voice/rt/token — mint a browser ephemeral client secret bound to the
 * session config above. The real API key stays here. Returns { value, expires_at }.
 */
export async function handleRtToken(req: Request): Promise<Response> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return err(503, "OPENAI_API_KEY not set on the server");

  const user = new URL(req.url).searchParams.get("user") || "anon";
  const safetyId = createHash("sha256").update(user).digest("hex").slice(0, 64);

  let res: Response;
  try {
    res = await fetch(CLIENT_SECRETS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "OpenAI-Safety-Identifier": safetyId,
      },
      body: JSON.stringify({ session: buildSessionConfig() }),
    });
  } catch (e) {
    return err(502, `client_secrets request failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 400);
    return err(res.status, `client_secrets ${res.status}: ${detail}`);
  }

  const data = (await res.json()) as { value?: string; expires_at?: number };
  if (!data.value) return err(502, "client_secrets returned no token");
  return json({ value: data.value, expires_at: data.expires_at ?? null, model: MODEL });
}

/**
 * Run a tool call relayed from the browser. Delegates to the vault tool suite
 * (vault-tools.ts). Pure over (repoCwd, args) so serve.ts resolves the repo inline;
 * returns stringifiable JSON the browser forwards to the model as function_call_output.
 */
export async function runRtTool(
  name: string,
  repoCwd: string,
  args: Record<string, unknown>,
): Promise<Response> {
  return runVaultTool(name, repoCwd, args);
}

/**
 * Persist a finished Converse session as an `ai-voice-conversation` note. Composes
 * frontmatter (type/title/user-properties/tags) + transcript body, writes into
 * `ai-voice-conversations/<slug>.md` with slug de-dup, commits under the repo lock.
 */
export async function saveConversation(
  repoCwd: string,
  input: { title: string; transcript: string; tags?: string[]; properties?: Record<string, unknown> },
): Promise<Response> {
  const title = input.title.trim();
  if (!title || !input.transcript) return err(400, "title and transcript are required");
  const baseSlug = slugify(title);
  const frontmatter = buildFrontmatter({
    type: "ai-voice-conversation",
    title,
    ...(input.properties ?? {}),
    tags: Array.isArray(input.tags) ? input.tags : [],
  });
  const content = `${frontmatter}\n\n${input.transcript}\n`;
  try {
    const result = await withRepoLock(repoCwd, async () => {
      let written: { path: string } | null = null;
      for (let n = 1; n <= 20; n++) {
        const rel =
          n === 1 ? `ai-voice-conversations/${baseSlug}.md` : `ai-voice-conversations/${baseSlug}-${n}.md`;
        try {
          written = await writeRepoFile(repoCwd, rel, content, { createOnly: true });
          break;
        } catch (e) {
          if (e instanceof Error && e.message.includes("already exists")) continue;
          throw e;
        }
      }
      if (!written) throw new Error("could not find a free filename");
      const commit = gitCommitPaths(repoCwd, [written.path], `converse: conversation — ${title}`);
      return { path: written.path, commit };
    });
    return json({ ok: true, ...result });
  } catch (e) {
    return err(400, e instanceof Error ? e.message : String(e));
  }
}
