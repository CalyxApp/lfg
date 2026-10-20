import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autosaveConversation, conversationNoteText } from "./converse-autosave.ts";
import { getConversationRecord, type ConversationRecord } from "./converse-store.ts";

let vault: string;
let data: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "autosave-vault-"));
  data = mkdtempSync(join(tmpdir(), "autosave-data-"));
  process.env.LFG_CONVERSE_DIR = join(data, "conversations");
  process.env.LFG_CONVERSE_NOTE_INDEX = join(data, "converse-notes.json");
  execSync("git init -q && git config user.email t@t.t && git config user.name t && git commit -q --allow-empty -m init", {
    cwd: vault,
    shell: "/bin/bash",
  });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
  delete process.env.LFG_CONVERSE_DIR;
  delete process.env.LFG_CONVERSE_NOTE_INDEX;
});

function rec(turns: [string, string][], extra: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    id: "2026-10-20T11-45-12-107Z-g6vgl1",
    title: "Find the pitch v3",
    date: "2026-10-20",
    model: "gpt-realtime-2.1",
    durationMs: 65_000,
    createdAt: "2026-10-20T11:45:12.107Z",
    turns: turns.map(([role, text]) => ({ role: role as "you" | "assistant", text })),
    ...extra,
  };
}

const notes = () => (existsSync(join(vault, "ai-voice-conversations")) ? readdirSync(join(vault, "ai-voice-conversations")) : []);
const note = (p: string) => readFileSync(join(vault, p), "utf8");

describe("every chat is saved as it goes", () => {
  test("the first turn creates one note and one record", async () => {
    const r = await autosaveConversation(vault, rec([["you", "Find the pitch v3"]]));
    expect(r.note).toMatchObject({ action: "created", path: "ai-voice-conversations/find-the-pitch-v3.md" });
    expect(notes()).toEqual(["find-the-pitch-v3.md"]);
    expect((await getConversationRecord(rec([]).id))?.turns.length).toBe(1);
  });

  test("later turns update the SAME note in place — no duplicates", async () => {
    await autosaveConversation(vault, rec([["you", "Find the pitch v3"]]));
    await autosaveConversation(vault, rec([["you", "Find the pitch v3"], ["assistant", "Found it."]]));
    const r = await autosaveConversation(vault, rec([["you", "Find the pitch v3"], ["assistant", "Found it."], ["you", "Add a line."]]));
    expect(r.note.action).toBe("updated");
    expect(notes()).toEqual(["find-the-pitch-v3.md"]);
    expect(note("ai-voice-conversations/find-the-pitch-v3.md")).toContain("**You:** Add a line.");
  });

  test("a late, shorter save never shrinks the chat", async () => {
    await autosaveConversation(vault, rec([["you", "a"], ["assistant", "b"], ["you", "c"]]));
    const r = await autosaveConversation(vault, rec([["you", "a"]]));
    expect(r.record).toBe("kept-longer");
    expect((await getConversationRecord(rec([]).id))?.turns.length).toBe(3);
    expect(note("ai-voice-conversations/find-the-pitch-v3.md")).toContain("**You:** c");
  });

  test("the title is fixed by the first save", async () => {
    await autosaveConversation(vault, rec([["you", "a"]]));
    await autosaveConversation(vault, rec([["you", "a"], ["you", "b"]], { title: "Something else" }));
    expect((await getConversationRecord(rec([]).id))?.title).toBe("Find the pitch v3");
  });

  test("a chat with nothing said by the user writes no note", async () => {
    const r = await autosaveConversation(vault, rec([["assistant", "Voice connected — start talking."]]));
    expect(r.note.action).toBe("nothing-to-save");
    expect(notes()).toEqual([]);
  });
});

describe("the user's version always wins", () => {
  const path = "ai-voice-conversations/find-the-pitch-v3.md";

  test("after the user edits or comments on the note, the chat stops rewriting it", async () => {
    await autosaveConversation(vault, rec([["you", "Find the pitch v3"]]));
    const edited = `${note(path)}\nMy own note.\n\n<!-- calyx-comments -->\ncomments:\n  c_1:\n    by: user\n`;
    writeFileSync(join(vault, path), edited);
    const r = await autosaveConversation(vault, rec([["you", "Find the pitch v3"], ["assistant", "More."]]));
    expect(r.note.action).toBe("kept-user-version");
    expect(note(path)).toBe(edited);
    // the record still has the whole chat
    expect((await getConversationRecord(rec([]).id))?.turns.length).toBe(2);
  });

  test("a note the user deleted is not brought back", async () => {
    await autosaveConversation(vault, rec([["you", "Find the pitch v3"]]));
    unlinkSync(join(vault, path));
    const r = await autosaveConversation(vault, rec([["you", "Find the pitch v3"], ["assistant", "More."]]));
    expect(r.note.action).toBe("user-deleted");
    expect(existsSync(join(vault, path))).toBe(false);
  });

  test("a different chat with the same first words gets its own note", async () => {
    await autosaveConversation(vault, rec([["you", "Find the pitch v3"]]));
    await autosaveConversation(vault, rec([["you", "Find the pitch v3"]], { id: "other-chat" }));
    expect(notes().sort()).toEqual(["find-the-pitch-v3-2.md", "find-the-pitch-v3.md"]);
  });
});

describe("the note text", () => {
  test("is a transcript of the spoken and typed turns, without tool rows or placeholders", () => {
    const text = conversationNoteText({
      ...rec([["you", "Hi"], ["assistant", "Hello."], ["you", "…"]]),
      turns: [
        { role: "you", text: "Hi" },
        { role: "tool", text: "Searched the vault" },
        { role: "assistant", text: "Hello." },
        { role: "you", text: "…" },
      ],
    });
    expect(text).toContain("type: \"ai-voice-conversation\"");
    expect(text).toContain("conversation_id: \"2026-10-20T11-45-12-107Z-g6vgl1\"");
    expect(text).toContain("duration: \"1m 5s\"");
    expect(text).toContain("## Transcript\n\n**You:** Hi\n\n**Assistant:** Hello.\n");
    expect(text).not.toContain("Searched the vault");
  });
});

describe("backfill from the debug log", () => {
  test("rebuilds spoken, typed and tool turns in order", async () => {
    const { recordFromLog } = await import("../scripts/backfill-converse.ts");
    const lines = [
      { t: "2026-10-20T11:45:12.142Z", kind: "session_start", model: "gpt-realtime-2.1" },
      { t: "2026-10-20T11:45:36.000Z", kind: "rt", event: { type: "conversation.item.input_audio_transcription.completed", transcript: "Hey, can you hear me?" } },
      { t: "2026-10-20T11:45:37.000Z", kind: "rt", event: { type: "response.output_audio_transcript.done", transcript: "Yes." } },
      { t: "2026-10-20T11:46:02.000Z", kind: "tool", name: "search", args: { q: "x" }, waiting: true },
      { t: "2026-10-20T11:46:04.000Z", kind: "tool", name: "search", args: { q: "x" }, ok: true, output: "{}" },
      { t: "2026-10-20T11:47:00.000Z", kind: "chat_user", text: "typed" },
      { t: "2026-10-20T11:47:05.000Z", kind: "chat_assistant", text: "typed reply" },
    ].map((e) => JSON.stringify(e));
    const rec = recordFromLog("abc", lines)!;
    expect(rec.turns.map((t) => `${t.role}:${t.text}`)).toEqual([
      "you:Hey, can you hear me?",
      "assistant:Yes.",
      "tool:search",
      "you:typed",
      "assistant:typed reply",
    ]);
    expect(rec.model).toBe("gpt-realtime-2.1");
    expect(rec.durationMs).toBe(112_858);
  });

  test("a log where the user said nothing gives no record", async () => {
    const { recordFromLog } = await import("../scripts/backfill-converse.ts");
    expect(recordFromLog("x", [JSON.stringify({ kind: "conn", state: "connected" })])).toBeNull();
  });
});
