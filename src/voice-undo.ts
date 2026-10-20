// voice-undo.ts — "undo that" for the assistant's own writes to the vault.
//
// Every write a vault tool makes (create, create_project, update, edit) is
// recorded here with the file's exact text BEFORE the write and a hash of its
// text AFTER. Undo puts the before-text back — or deletes a note the assistant
// created — but only when the file is still exactly what the assistant left. If
// anything changed it since (the user, sync, a later edit), undo refuses rather
// than overwrite that. Undo a later change first, and the earlier one becomes
// undoable again: it works as a stack.
//
// Git history is not used for this on purpose: the vault on the server also
// changes through sync without commits, so a commit's parent is not reliably
// "the note before the assistant touched it". The journal is.
//
// Storage: one JSON file per change under data/converse-undo/. Entries older
// than RETENTION_MS are pruned on write.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PATHS } from "./config.ts";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type UndoEntry = {
  id: string;
  at: string; // ISO
  sessionId?: string;
  repoCwd: string;
  path: string; // vault-relative
  title: string;
  /** The file's text before the write; null when the write created it. */
  before: string | null;
  afterHash: string;
  summary: string;
  undone?: boolean;
};

export type UndoResult =
  | { ok: true; path: string; title: string; summary: string; deleted: boolean }
  | { ok: false; error: "nothing_to_undo" | "changed_since" | "unknown_change"; message: string };

export const hashText = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function defaultDir(): string {
  return process.env.LFG_UNDO_DIR || join(PATHS.data, "converse-undo");
}

function readAll(dir: string): UndoEntry[] {
  if (!existsSync(dir)) return [];
  const out: UndoEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as UndoEntry);
    } catch {
      /* a torn entry is skipped, never fatal */
    }
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.id.localeCompare(a.id)));
}

function save(dir: string, e: UndoEntry): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${e.id}.json`), JSON.stringify(e), "utf8");
}

/** Record one write. Returns the change id the tool hands back to the model. */
export function recordChange(
  input: Omit<UndoEntry, "id" | "at" | "afterHash" | "undone"> & { after: string },
  dir = defaultDir(),
): string {
  const { after, ...rest } = input;
  const now = Date.now();
  const id = `${now.toString(36)}-${randomBytes(3).toString("hex")}`;
  save(dir, { ...rest, id, at: new Date(now).toISOString(), afterHash: hashText(after) });
  for (const e of readAll(dir)) {
    if (now - Date.parse(e.at) > RETENTION_MS) {
      try {
        unlinkSync(join(dir, `${e.id}.json`));
      } catch {
        /* already gone */
      }
    }
  }
  return id;
}

/** Pick the change to undo: the one named, else the latest not-yet-undone one
 *  from this conversation (or, with no conversation id, from the last hour). */
function pick(entries: UndoEntry[], changeId?: string, sessionId?: string): UndoEntry | UndoResult {
  if (changeId) {
    const e = entries.find((x) => x.id === changeId);
    if (!e) return { ok: false, error: "unknown_change", message: `No change with id ${changeId}.` };
    if (e.undone) return { ok: false, error: "nothing_to_undo", message: "That change was already undone." };
    return e;
  }
  const live = entries.filter((e) => !e.undone);
  const mine = sessionId
    ? live.filter((e) => e.sessionId === sessionId)
    : live.filter((e) => Date.now() - Date.parse(e.at) < 60 * 60 * 1000);
  return mine[0] ?? { ok: false, error: "nothing_to_undo", message: "There is no change of mine to undo in this conversation." };
}

/**
 * Undo one change. `io` does the file work (the caller holds the repo lock and
 * commits); this module decides whether it is safe.
 */
export async function undoChange(
  opts: { changeId?: string; sessionId?: string; repoCwd: string },
  io: {
    read: (rel: string) => Promise<string | null>;
    write: (rel: string, text: string) => Promise<void>;
    remove: (rel: string) => Promise<void>;
  },
  dir = defaultDir(),
): Promise<UndoResult> {
  const chosen = pick(readAll(dir).filter((e) => e.repoCwd === opts.repoCwd), opts.changeId, opts.sessionId);
  if ("ok" in chosen) return chosen;
  const e = chosen;
  const current = await io.read(e.path);
  if (current === null || hashText(current) !== e.afterHash) {
    return {
      ok: false,
      error: "changed_since",
      message:
        `"${e.title}" has changed since I made that change, so I won't undo it blindly. ` +
        "Undo my later changes to it first, or fix it in the app.",
    };
  }
  if (e.before === null) await io.remove(e.path);
  else await io.write(e.path, e.before);
  save(dir, { ...e, undone: true });
  return { ok: true, path: e.path, title: e.title, summary: e.summary, deleted: e.before === null };
}

/** Remove a file the assistant created, and its folder if that leaves it empty
 *  (a task is `tasks/<slug>/index.md`). Never removes a folder with anything else in it. */
export function removeCreatedFile(abs: string): void {
  unlinkSync(abs);
  const dir = dirname(abs);
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    /* leave the folder */
  }
}
