// converse-store.ts — the storage adapter for saved Converse conversations.
//
// This is the ONE seam the universal view is built around (see
// docs/converse-universal-view.md). The viewer talks to an HTTP contract that
// returns a normalized shape; this module is the only code that knows where the
// records actually live. Today that's local JSON under data/converse-conversations/;
// swap the body of these three functions later (a real DB, a synced service) and
// nothing else — routes, UI — has to change.

import { join } from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { PATHS } from "./config.ts";

const DIR = join(PATHS.data, "converse-conversations");

export type ConversationTurn = {
  role: "you" | "assistant" | "tool" | "system";
  text: string;
  ok?: boolean;
  tool?: unknown; // { name, args, result, ok } — opaque here; the UI types it
  images?: string[];
  files?: string[];
};

export type ConversationRecord = {
  id: string;
  title: string;
  date: string; // YYYY-MM-DD
  model?: string;
  durationMs?: number;
  createdAt: string; // ISO
  turns: ConversationTurn[];
};

export type ConversationSummary = {
  id: string;
  title: string;
  date: string;
  model?: string;
  createdAt: string;
  turnCount: number;
};

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 120) || "conversation";
}

/** Persist (or overwrite) one conversation record. */
export async function saveConversationRecord(rec: ConversationRecord): Promise<void> {
  await mkdir(DIR, { recursive: true });
  await writeFile(join(DIR, `${safeId(rec.id)}.json`), JSON.stringify(rec), "utf8");
}

/** List conversation summaries, newest first. Best-effort: skips unreadable files. */
export async function listConversationSummaries(): Promise<ConversationSummary[]> {
  let files: string[];
  try {
    files = (await readdir(DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    return []; // dir doesn't exist yet → no conversations
  }
  const out: ConversationSummary[] = [];
  for (const f of files) {
    try {
      const rec = JSON.parse(await readFile(join(DIR, f), "utf8")) as ConversationRecord;
      out.push({
        id: rec.id,
        title: rec.title,
        date: rec.date,
        model: rec.model,
        createdAt: rec.createdAt,
        turnCount: Array.isArray(rec.turns) ? rec.turns.length : 0,
      });
    } catch {
      /* skip corrupt record */
    }
  }
  out.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return out;
}

/** Fetch one full record by id, or null if missing/unreadable. */
export async function getConversationRecord(id: string): Promise<ConversationRecord | null> {
  try {
    return JSON.parse(await readFile(join(DIR, `${safeId(id)}.json`), "utf8")) as ConversationRecord;
  } catch {
    return null;
  }
}
