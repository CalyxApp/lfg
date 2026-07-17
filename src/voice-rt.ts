// Converse — realtime voice gateway (OpenAI gpt-realtime-2.1).
//
// A NEW, SEPARATE voice interface, additive to the existing ElevenLabs/LiveKit
// cascade (voice-eleven-llm.ts / voice-call.tsx) — it shares NOTHING with it but
// the tool backend. The browser holds the WebRTC peer connection directly to
// OpenAI; this module only (a) mints short-lived ephemeral tokens so the real
// OPENAI_API_KEY never reaches the browser, and (b) runs the tool calls the
// browser relays. See docs/voice-agent-architecture.md (Rev 4) in the extension repo.
//
// Auth follows the lfg convention: no middleware — the server is loopback/Tailscale
// only, and "user" is the soft ?user= identity, hashed into OpenAI-Safety-Identifier.

import { createHash } from "node:crypto";
import { gitGrep, writeRepoFile, withRepoLock, gitCommitPaths } from "./files.ts";

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

// ---- Phase-0 tool schemas advertised to the model (client-executed) ----
const TOOLS = [
  {
    type: "function",
    name: "search_workspace",
    description:
      "Search the user's notes and files for a literal phrase. Returns matching file paths and lines. Use for 'find', 'what did I write about', 'where is'.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Literal text to search for." },
        limit: { type: "number", description: "Max results (default 8)." },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "create_note",
    description: "Create a new markdown note in the workspace. Use for 'make a note', 'jot down', 'save this'.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short note title." },
        body: { type: "string", description: "Note body (markdown)." },
      },
      required: ["title"],
    },
  },
];

function buildSessionConfig() {
  return {
    type: "realtime",
    model: MODEL,
    output_modalities: ["audio"],
    reasoning: { effort: "low" },
    instructions:
      "You are Calyx's voice assistant — warm, brief, and natural. You help the user talk to their " +
      "workspace: search their notes and create notes by voice. Keep spoken replies to one or two " +
      "sentences. When you use a tool, say what you're doing in a few words. Read back the title before " +
      "you confirm a note was created. Never invent file contents — if search returns nothing, say so.",
    audio: {
      input: {
        transcription: { model: "gpt-4o-transcribe" },
        turn_detection: {
          type: "semantic_vad",
          eagerness: "auto",
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
 * Run a tool call relayed from the browser. Pure over (repoCwd, args) so serve.ts
 * can resolve the repo inline (no circular import). Returns stringifiable JSON;
 * the browser forwards the body verbatim back to the model as function_call_output.
 */
export async function runRtTool(
  name: string,
  repoCwd: string,
  args: Record<string, unknown>,
): Promise<Response> {
  try {
    switch (name) {
      case "search_workspace": {
        const query = String(args.query ?? "").trim();
        if (!query) return err(400, "query required");
        const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 25);
        const matches = gitGrep(repoCwd, query, { max: limit });
        return json({
          count: matches.length,
          results: matches.map((m) => ({ path: m.path, line: m.line, text: m.text })),
        });
      }
      case "create_note": {
        const title = String(args.title ?? "").trim();
        if (!title) return err(400, "title required");
        const body = String(args.body ?? "");
        const slug =
          title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 60) || "note";
        const rel = `notes/${slug}.md`;
        const content = `# ${title}\n\n${body}\n`;
        // Hold the repo lock across write + commit (matches /api/vault/create-task).
        const result = await withRepoLock(repoCwd, async () => {
          const w = await writeRepoFile(repoCwd, rel, content, { createOnly: false });
          const commit = gitCommitPaths(repoCwd, [w.path], `converse: note — ${title}`);
          return { path: w.path, created: w.created, commit };
        });
        return json({ ok: true, ...result });
      }
      default:
        return err(404, `unknown tool: ${name}`);
    }
  } catch (e) {
    return err(400, e instanceof Error ? e.message : String(e));
  }
}
