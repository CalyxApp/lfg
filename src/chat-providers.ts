// Chat-model providers — the TEXT side of the unified Converse chat.
//
// The unified chat↔voice surface (web/src/converse.tsx) has two engines behind
// one thread: voice mode is OpenAI gpt-realtime (voice-rt.ts, fixed), while
// typed turns go through HERE — a user-selectable chat-completions provider.
// Decision (Sam, 2026-07-22): people choose the chat model; ship OpenAI first,
// add Gemini and Claude later (they're registered below as visible-but-not-yet-
// implemented so the picker can show what's coming).
//
// Conventions copied from voice-providers.ts: API keys live in env and never
// leave this module; the only thing persisted (data/chat-settings.json) is the
// *choice* of provider+model. Tool backend is the same vault suite Converse
// uses (vault-tools.ts), so a typed "make a note about X" behaves exactly like
// the spoken one.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PATHS } from "./config.ts";
import { VAULT_TOOL_SCHEMAS, runVaultTool } from "./vault-tools.ts";

// ------------------------------------------------------------ types

export type ChatTurnMessage = { role: "user" | "assistant"; content: string };
export type ChatSettings = { provider: string; model: string };

type RunTurnOpts = {
  model: string;
  messages: ChatTurnMessage[];
  repoCwd: string; // workspace the vault tools operate on (same scoping as Converse)
};

type ChatProvider = {
  id: string;
  label: string;
  models: string[]; // first entry is the default
  available: () => boolean; // env key present
  implemented: boolean; // false → "coming soon" slot in the picker
  runTurn?: (opts: RunTurnOpts) => Promise<Response>;
};

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

// ------------------------------------------------------------ shared prompt/tools

// Text-mode sibling of the spoken instructions in voice-rt.ts buildSessionConfig().
// Same persona and vault behavior; only the delivery differs (written, can be a
// little longer, markdown is fine).
const INSTRUCTIONS =
  "You are Calyx's assistant — warm, brief, and natural. This is the typed side of a chat that can " +
  "also be spoken (the user may switch to voice mid-conversation; earlier turns may come from either). " +
  "You help the user work with their vault of notes: explore it (describe_vault, browse), find things " +
  "(search, list_by_type), read a note, create or update notes, and start whole projects (create_project). " +
  "For current events or facts outside the vault, use web_search. When you're unsure what note types, " +
  "tags, or projects exist, call describe_vault first to learn the real names before searching or " +
  "creating. Keep replies short and conversational — a sentence or two unless the user asks for more; " +
  "light markdown is fine. Read a note before answering questions about it — never invent file contents; " +
  "if a search returns nothing, say so. Confirm the title before you finish creating or changing a note.";

// The realtime API takes flat {type:"function", name, ...}; chat completions
// wants them nested under `function`. Same schemas, different envelope.
const CHAT_COMPLETION_TOOLS = VAULT_TOOL_SCHEMAS.map((t) => ({
  type: "function" as const,
  function: { name: t.name, description: t.description, parameters: t.parameters },
}));

const MAX_TOOL_ROUNDS = 8;
const TIMEOUT_MS = 60_000;

// ------------------------------------------------------------ OpenAI (implemented)

const openai: ChatProvider = {
  id: "openai",
  label: "OpenAI",
  // GPT-5.6 family (launched 2026-07-09): named capability tiers — Terra is
  // OpenAI's "everyday default" (GPT-5.5-class at ~2x lower cost, $2.50/$15 per
  // 1M), Luna the fastest/cheapest ($1/$6), Sol the flagship ($5/$30). All three
  // verified present on the server key via /v1/models and smoke-tested with the
  // vault tool loop, 2026-07-22. gpt-5.5 kept as a known-good fallback.
  models: ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.5"],
  available: () => !!process.env.OPENAI_API_KEY,
  implemented: true,
  async runTurn({ model, messages, repoCwd }) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return err(503, "OPENAI_API_KEY not set on the server");

    // Rolling message list: system + thread history, then tool-call exchanges
    // appended as the loop runs. `toolCalls` is the surfaced log for the UI.
    const convo: Record<string, unknown>[] = [
      { role: "system", content: INSTRUCTIONS },
      ...messages.map((m) => ({ role: m.role, content: m.content })),
    ];
    // Surfaced to the UI as friendly chips — includes the outcome (ok + a
    // path/id detail when the tool returned one), not just the invocation.
    const toolCalls: { name: string; args: Record<string, unknown>; ok?: boolean; detail?: string }[] = [];

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      let res: Response;
      try {
        res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages: convo,
            tools: CHAT_COMPLETION_TOOLS,
            tool_choice: "auto",
            // GPT-5.6 tiers default to built-in reasoning, which /v1/chat/completions
            // rejects when combined with function tools ("use /v1/responses or set
            // reasoning_effort to 'none'"). "none" is right for a snappy chat surface
            // anyway; a Responses-API migration is the longer-term path.
            ...(model.startsWith("gpt-5.6-") ? { reasoning_effort: "none" } : {}),
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        return err(502, `openai unreachable: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 400);
        return err(502, `openai chat ${res.status}: ${detail}`);
      }
      const data = (await res.json().catch(() => null)) as {
        choices?: {
          message?: {
            content?: string | null;
            tool_calls?: { id: string; function: { name: string; arguments: string } }[];
          };
        }[];
      } | null;
      const msg = data?.choices?.[0]?.message;
      if (!msg) return err(502, "openai chat returned no message");

      const calls = msg.tool_calls ?? [];
      if (calls.length === 0) {
        return json({ text: (msg.content ?? "").trim(), toolCalls, model, provider: openai.id });
      }

      // Execute the requested vault tools and feed the outputs back.
      convo.push({ role: "assistant", content: msg.content ?? null, tool_calls: calls });
      for (const call of calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          /* leave empty */
        }
        const toolRes = await runVaultTool(call.function.name, repoCwd, args);
        const output = await toolRes.text();
        let ok: boolean | undefined;
        let detail: string | undefined;
        try {
          const parsed = JSON.parse(output) as Record<string, unknown>;
          ok = parsed?.error ? false : ((parsed?.ok as boolean | undefined) ?? true);
          detail =
            typeof parsed?.path === "string"
              ? parsed.path
              : typeof parsed?.project_id === "string"
                ? (parsed.project_id as string)
                : undefined;
        } catch {
          /* non-JSON output — leave outcome unknown */
        }
        toolCalls.push({ name: call.function.name, args, ok, detail });
        convo.push({ role: "tool", tool_call_id: call.id, content: output });
      }
    }
    return err(502, `chat turn exceeded ${MAX_TOOL_ROUNDS} tool rounds without a final reply`);
  },
};

// ------------------------------------------------------------ coming soon

// Registered so the picker can show the roadmap; selecting them is rejected
// until runTurn is implemented. Availability probes the conventional env keys
// so the UI can also say whether a key is already on the server.
const gemini: ChatProvider = {
  id: "gemini",
  label: "Google Gemini",
  models: [],
  available: () => !!process.env.GEMINI_API_KEY,
  implemented: false,
};

const claude: ChatProvider = {
  id: "claude",
  label: "Anthropic Claude",
  models: [],
  available: () => !!process.env.ANTHROPIC_API_KEY,
  implemented: false,
};

const PROVIDERS: Record<string, ChatProvider> = {
  [openai.id]: openai,
  [gemini.id]: gemini,
  [claude.id]: claude,
};

const DEFAULTS: ChatSettings = { provider: openai.id, model: openai.models[0] };

// ------------------------------------------------------------ settings store

const filePath = () => join(PATHS.data, "chat-settings.json");

function validate(p: Partial<ChatSettings> | null | undefined, fallback: ChatSettings): ChatSettings {
  const provider =
    p?.provider && PROVIDERS[p.provider]?.implemented ? p.provider : fallback.provider;
  const models = PROVIDERS[provider].models;
  const model = p?.model && models.includes(p.model) ? p.model : provider === fallback.provider ? fallback.model : models[0];
  return { provider, model };
}

export async function getChatSettings(): Promise<ChatSettings> {
  const f = Bun.file(filePath());
  if (!(await f.exists())) return { ...DEFAULTS };
  try {
    return validate(JSON.parse(await f.text()) as Partial<ChatSettings>, DEFAULTS);
  } catch {
    return { ...DEFAULTS };
  }
}

export async function setChatSettings(patch: Partial<ChatSettings>): Promise<ChatSettings> {
  const next = validate(patch, await getChatSettings());
  await mkdir(PATHS.data, { recursive: true });
  await Bun.write(filePath(), JSON.stringify(next, null, 2));
  return next;
}

// What the picker renders: every provider, whether its key is wired up, and
// whether it's actually implemented yet (grey out + "soon" the ones that aren't).
export function listChatProviders() {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    label: p.label,
    models: p.models,
    available: p.available(),
    implemented: p.implemented,
  }));
}

// ------------------------------------------------------------ dispatch

/** Run one typed turn of the unified chat against the configured provider. */
export async function runChatTurn(repoCwd: string, messages: ChatTurnMessage[]): Promise<Response> {
  if (!Array.isArray(messages) || messages.length === 0) return err(400, "expected { messages: [...] }");
  const clean: ChatTurnMessage[] = [];
  for (const m of messages) {
    if ((m?.role !== "user" && m?.role !== "assistant") || typeof m?.content !== "string") {
      return err(400, "each message needs role user|assistant and string content");
    }
    if (m.content.trim()) clean.push({ role: m.role, content: m.content });
  }
  if (clean.length === 0 || clean[clean.length - 1].role !== "user") {
    return err(400, "last message must be a non-empty user turn");
  }
  const s = await getChatSettings();
  const p = PROVIDERS[s.provider];
  if (!p?.implemented || !p.runTurn) return err(503, `chat provider ${s.provider} not implemented yet`);
  if (!p.available()) return err(503, `${p.label} API key not set on the server`);
  return p.runTurn({ model: s.model, messages: clean, repoCwd });
}
