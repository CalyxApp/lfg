// converse-autosave.ts — every Converse chat (voice or typed) is saved as it goes.
//
// Sam, 2026-10-20: "I don't want to choose to save them, I just want them to save
// automatically." Before this, a chat was saved only when the user closed it with
// the close button; 15 of 21 logged chats were never saved (the app was left, the
// phone locked, the page killed). Now the browser posts the whole conversation
// after every turn and when the page is hidden, and the server keeps two copies:
//
//   1. the structured record (converse-store.ts) — what the app's history shows.
//      It only ever grows: a late, shorter post never overwrites a longer one.
//   2. a readable `ai-voice-conversation` note in the vault — ONE note per chat,
//      rewritten in place as the chat grows. Once the user changes that note in
//      any way (an edit, a comment) or deletes it, the chat stops touching it:
//      their version wins and is never overwritten.
//
// The note index (chat id → note path + hash of what we last wrote) lives in
// data/converse-notes.json. The hash is what makes rule 2 deterministic.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PATHS } from "./config.ts";
import { readRepoFile, writeRepoFile, withRepoLock, gitCommitPaths } from "./files.ts";
import { buildFrontmatter, slugify } from "./vault-tools.ts";
import { getConversationRecord, saveConversationRecord, type ConversationRecord } from "./converse-store.ts";

type NoteIndex = Record<string, { path: string; hash: string }>;

const hash = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function indexFile(): string {
  return process.env.LFG_CONVERSE_NOTE_INDEX || join(PATHS.data, "converse-notes.json");
}

function readIndex(): NoteIndex {
  try {
    return JSON.parse(readFileSync(indexFile(), "utf8")) as NoteIndex;
  } catch {
    return {};
  }
}

function writeIndex(ix: NoteIndex): void {
  const f = indexFile();
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(ix), "utf8");
}

/** The spoken/typed turns worth keeping: no tool rows, no unresolved "…" placeholders. */
function realTurns(rec: ConversationRecord) {
  return rec.turns.filter(
    (t) => (t.role === "you" || t.role === "assistant") && t.text.trim() && t.text.trim() !== "…",
  );
}

/** The note's full text for a record. Deterministic: same record → same bytes. */
export function conversationNoteText(rec: ConversationRecord): string {
  // Same duration format the close-button save used ("4m 12s").
  const secs = Math.round((rec.durationMs ?? 0) / 1000);
  const duration = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : secs ? `${secs}s` : "";
  const frontmatter = buildFrontmatter({
    type: "ai-voice-conversation",
    title: rec.title,
    date: rec.date,
    ...(duration ? { duration } : {}),
    ...(rec.model ? { model: rec.model } : {}),
    conversation_id: rec.id,
    tags: [],
  });
  const body = realTurns(rec)
    .map((t) => `**${t.role === "you" ? "You" : "Assistant"}:** ${t.text.trim()}`)
    .join("\n\n");
  return `${frontmatter}\n\n## Transcript\n\n${body}\n`;
}

export type NoteOutcome =
  | { action: "created" | "updated" | "unchanged"; path: string }
  | { action: "kept-user-version" | "user-deleted"; path: string }
  | { action: "nothing-to-save" };

/** Create or update the chat's one vault note, never overwriting the user's changes. */
export async function upsertConversationNote(repoCwd: string, rec: ConversationRecord): Promise<NoteOutcome> {
  if (!realTurns(rec).some((t) => t.role === "you")) return { action: "nothing-to-save" };
  const content = conversationNoteText(rec);
  return withRepoLock(repoCwd, async () => {
    const ix = readIndex();
    const known = ix[rec.id];
    if (known) {
      let current: string | null = null;
      try {
        const f = await readRepoFile(repoCwd, known.path);
        current = "content" in f ? f.content : null;
      } catch {
        current = null;
      }
      if (current === null) return { action: "user-deleted", path: known.path };
      if (hash(current) !== known.hash) return { action: "kept-user-version", path: known.path };
      if (current === content) return { action: "unchanged", path: known.path };
      await writeRepoFile(repoCwd, known.path, content, { createOnly: false });
      // Record the new hash BEFORE committing: if the commit fails, the index must
      // still match the file, or the next save would take our own text for the user's.
      writeIndex({ ...ix, [rec.id]: { path: known.path, hash: hash(content) } });
      gitCommitPaths(repoCwd, [known.path], `converse: conversation — ${rec.title}`);
      return { action: "updated", path: known.path };
    }
    const base = slugify(rec.title);
    for (let n = 1; n <= 50; n++) {
      const rel = `ai-voice-conversations/${n === 1 ? base : `${base}-${n}`}.md`;
      if (existsSync(join(repoCwd, rel))) continue;
      try {
        await writeRepoFile(repoCwd, rel, content, { createOnly: true });
      } catch (e) {
        if (e instanceof Error && e.message.includes("already exists")) continue;
        throw e;
      }
      writeIndex({ ...ix, [rec.id]: { path: rel, hash: hash(content) } }); // before the commit, as above
      gitCommitPaths(repoCwd, [rel], `converse: conversation — ${rec.title}`);
      return { action: "created", path: rel };
    }
    throw new Error("could not find a free filename for the conversation note");
  });
}

type AutosaveResult = { record: "saved" | "kept-longer"; note: NoteOutcome | { action: "no-vault" } };

// One save at a time in this process. The browser can post one chat twice at once
// (a turn's save still in flight when the page-hidden save goes). The record's
// read-compare-write and the note index must not interleave, or the shorter post
// can land last and shrink the chat.
let queue: Promise<unknown> = Promise.resolve();

/**
 * Save one posted conversation: the record (grow-only) and its vault note.
 * `repoCwd` null = no vault available; the record is still kept.
 */
export function autosaveConversation(repoCwd: string | null, rec: ConversationRecord): Promise<AutosaveResult> {
  const run = queue.then(() => saveOne(repoCwd, rec));
  queue = run.catch(() => undefined);
  return run;
}

async function saveOne(repoCwd: string | null, rec: ConversationRecord): Promise<AutosaveResult> {
  const existing = await getConversationRecord(rec.id);
  let stored = rec;
  if (existing && Array.isArray(existing.turns) && existing.turns.length > rec.turns.length) {
    stored = existing; // a late, shorter post (the page closing mid-save) never shrinks a chat
  } else {
    // The first save fixes the title and start time; later saves only add turns.
    if (existing) stored = { ...rec, title: existing.title || rec.title, createdAt: existing.createdAt || rec.createdAt };
    await saveConversationRecord(stored);
  }
  const note = repoCwd ? await upsertConversationNote(repoCwd, stored) : ({ action: "no-vault" } as const);
  return { record: stored === existing ? "kept-longer" : "saved", note };
}
