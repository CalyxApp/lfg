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
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PATHS } from "./config.ts";
import { writeRepoFile, withRepoLock, gitCommitPaths } from "./files.ts";
import {
  slugify,
  buildFrontmatter,
  buildVaultContext,
  VAULT_TOOL_SCHEMAS,
  WAIT_FOR_USER_TOOL,
  runVaultTool,
} from "./vault-tools.ts";
import { buildVoiceInstructions } from "./converse-persona.ts";

// Full gpt-realtime-2.1 (Sam, 2026-07-29): the full-size sibling of the
// gpt-realtime-2.1-mini we were running — same current generation (released
// 2026-07-06), stronger tool selection + exact-entity handling for the vault/
// project work. Confirmed the current-gen id via OpenAI's changelog; the
// client_secrets mint validates the *config* schema (verified) but not the model
// string, so this stays env-overridable via CONVERSE_RT_MODEL just in case.
const MODEL = process.env.CONVERSE_RT_MODEL || "gpt-realtime-2.1";
const CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";

// Per-session debug logs (Sam wants to track every realtime call for himself).
// Under data/ which is git-ignored → local-only, never committed. Distinct from the
// manual "save as vault note" flow (that stays a curated keepsake).
const LOG_DIR = join(PATHS.data, "converse-logs");

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
// wait_for_user is voice-only (ambient-noise silence handling), appended here.
const TOOLS = [...VAULT_TOOL_SCHEMAS, WAIT_FOR_USER_TOOL];

// `repoCwd` is the workspace vault (serve.ts resolves it) — used to inject a live
// SESSION CONTEXT block (date, active projects, task windows) into the spoken
// instructions so the assistant isn't cold on turn 1. Best-effort: no repo → no
// context, session still mints. See docs/converse-voice-rt-improvements.md.
async function buildSessionConfig(repoCwd?: string) {
  const context = repoCwd ? buildVaultContext(repoCwd) : "";
  return {
    type: "realtime",
    model: MODEL,
    output_modalities: ["audio"],
    reasoning: { effort: "low" },
    // Structured, labelled persona (shared core + voice addendum) + live context.
    instructions: buildVoiceInstructions(context),
    // Bound reply length so a runaway response can't ramble; spoken turns are short
    // anyway and tool-arg JSON fits comfortably.
    max_output_tokens: 2048,
    audio: {
      input: {
        // language hint speeds up + steadies user-side transcription (Sam is English).
        transcription: { model: "gpt-4o-transcribe", language: "en" },
        // Ambient-noise suppression on OpenAI's side (Sam uses earbuds + phone) so a
        // TV / second voice is far less likely to false-trigger a barge-in.
        noise_reduction: { type: "near_field" },
        turn_detection: {
          type: "semantic_vad",
          // `low` waits longer before deciding the user is done / is interrupting —
          // fewer accidental mid-reply cut-offs in a noisy room. If noise still
          // barges in, switch to server_vad with an explicit numeric `threshold`.
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
 * `repoCwd` (the workspace vault, resolved by serve.ts) lets the session start with
 * a live SESSION CONTEXT block; omitted → the session still mints, just cold.
 */
export async function handleRtToken(req: Request, repoCwd?: string): Promise<Response> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return err(503, "OPENAI_API_KEY not set on the server");

  const user = new URL(req.url).searchParams.get("user") || "anon";
  const safetyId = createHash("sha256").update(user).digest("hex").slice(0, 64);

  const session = await buildSessionConfig(repoCwd);
  let res: Response;
  try {
    res = await fetch(CLIENT_SECRETS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "OpenAI-Safety-Identifier": safetyId,
      },
      body: JSON.stringify({ session }),
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

/** Filesystem-safe log filename from a client session id. */
function safeLogId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "session";
}

/**
 * POST /api/voice/rt/upload-file?filename=… — proxy a non-image attachment (PDF,
 * doc, etc.) to the OpenAI Files API (purpose=user_data) so the typed chat can
 * reference it by file_id. The raw file is the request body; the OPENAI_API_KEY
 * never reaches the browser. Returns { file_id, filename }. (Images don't come
 * here — they go inline as base64 image_url parts. See converse.tsx.)
 */
export async function handleFileUpload(req: Request): Promise<Response> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return err(503, "OPENAI_API_KEY not set on the server");
  const filename = new URL(req.url).searchParams.get("filename") || "upload";
  const type = req.headers.get("content-type") || "application/octet-stream";
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength === 0) return err(400, "empty file");
  if (bytes.byteLength > 32 * 1024 * 1024) return err(413, "file too large (max 32 MB)");
  try {
    const fd = new FormData();
    fd.append("purpose", "user_data");
    fd.append("file", new Blob([bytes], { type }), filename);
    const res = await fetch("https://api.openai.com/v1/files", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: fd,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      return err(res.status, `files upload ${res.status}: ${detail}`);
    }
    const data = (await res.json()) as { id?: string };
    if (!data.id) return err(502, "files upload returned no id");
    return json({ ok: true, file_id: data.id, filename });
  } catch (e) {
    return err(502, `file upload failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * POST /api/voice/rt/log — append a batch of realtime events to this session's
 * debug log. The browser holds the WebRTC connection directly to OpenAI, so the
 * server never sees the transcript/turn events otherwise; the client streams them
 * here as it goes (so a crash/close loses nothing). One append-only JSONL file per
 * session under data/converse-logs/ (git-ignored, local, for Sam's debugging).
 * Body: { sessionId, events: [...] }.
 */
export async function handleRtLog(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { sessionId?: string; events?: unknown[] } | null;
  if (!body?.sessionId || !Array.isArray(body.events)) return err(400, "expected { sessionId, events: [...] }");
  if (body.events.length === 0) return json({ ok: true, appended: 0 });
  try {
    await mkdir(LOG_DIR, { recursive: true });
    const file = join(LOG_DIR, `${safeLogId(body.sessionId)}.jsonl`);
    const lines = body.events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await appendFile(file, lines, "utf8");
    return json({ ok: true, appended: body.events.length });
  } catch (e) {
    return err(500, e instanceof Error ? e.message : String(e));
  }
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
