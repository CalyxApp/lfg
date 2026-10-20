// backfill-converse.ts — save the chats that were logged but never saved.
//
// Before autosave (2026-10-20) a Converse chat was saved only when closed with the
// close button. Every chat was still logged in full to data/converse-logs/<id>.jsonl
// (speech transcripts, typed turns, tool calls), so the unsaved ones can be rebuilt
// from there and saved the same way autosave saves them (record + vault note).
//
//   bun run scripts/backfill-converse.ts --vault <repo>            # dry run: list what it would save
//   bun run scripts/backfill-converse.ts --vault <repo> --write    # save them
//
// A chat that already has a record is skipped, so running it twice is safe.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PATHS } from "../src/config.ts";
import { autosaveConversation } from "../src/converse-autosave.ts";
import { getConversationRecord, type ConversationRecord, type ConversationTurn } from "../src/converse-store.ts";

type Ev = { t?: string; kind?: string; text?: string; name?: string; args?: unknown; ok?: boolean; output?: string; model?: string; event?: { type?: string; transcript?: string; text?: string } };

export function recordFromLog(id: string, lines: string[]): ConversationRecord | null {
  const evs: Ev[] = [];
  for (const l of lines) {
    try {
      evs.push(JSON.parse(l) as Ev);
    } catch {
      /* torn line */
    }
  }
  const turns: ConversationTurn[] = [];
  let model = "";
  for (const e of evs) {
    if (e.kind === "session_start" && e.model) model = e.model;
    else if (e.kind === "chat_user" && e.text?.trim()) turns.push({ role: "you", text: e.text });
    else if (e.kind === "chat_assistant" && e.text?.trim()) turns.push({ role: "assistant", text: e.text });
    else if (e.kind === "tool" && e.ok !== undefined && e.name) {
      turns.push({ role: "tool", text: e.name, ok: e.ok, tool: { name: e.name, args: e.args, result: e.output, ok: e.ok } });
    } else if (e.kind === "rt" && e.event) {
      const type = e.event.type;
      const text = (e.event.transcript ?? e.event.text ?? "").trim();
      if (!text) continue;
      if (type === "conversation.item.input_audio_transcription.completed") turns.push({ role: "you", text });
      else if (type === "response.output_audio_transcript.done" || type === "response.output_text.done") {
        turns.push({ role: "assistant", text });
      }
    }
  }
  const firstUser = turns.find((t) => t.role === "you")?.text;
  if (!firstUser) return null;
  const times = evs.map((e) => Date.parse(e.t ?? "")).filter((n) => !Number.isNaN(n));
  const start = times.length ? Math.min(...times) : Date.now();
  const end = times.length ? Math.max(...times) : start;
  return {
    id,
    title: firstUser.slice(0, 60),
    date: new Date(start).toISOString().slice(0, 10),
    model: model || "chat",
    durationMs: end - start,
    createdAt: new Date(start).toISOString(),
    turns,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const vault = args[args.indexOf("--vault") + 1];
  const write = args.includes("--write");
  if (!args.includes("--vault") || !vault) throw new Error("usage: --vault <repo path> [--write]");
  const dir = join(PATHS.data, "converse-logs");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl")).sort()) {
    const id = f.replace(/\.jsonl$/, "");
    if (await getConversationRecord(id)) continue;
    const rec = recordFromLog(id, readFileSync(join(dir, f), "utf8").split("\n"));
    if (!rec) {
      console.log(`skip  ${id}  (nothing said)`);
      continue;
    }
    const said = rec.turns.filter((t) => t.role !== "tool").length;
    if (!write) {
      console.log(`would save  ${rec.date}  ${said} turns  "${rec.title}"`);
      continue;
    }
    const r = await autosaveConversation(vault, rec);
    console.log(`saved  ${rec.date}  ${said} turns  ${"path" in r.note ? r.note.path : r.note.action}`);
  }
}

if (import.meta.main) await main();
