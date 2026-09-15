// Calyx asks — the questions a *Calyx agent task* leaves behind when it stops.
//
// Distinct from `src/ask/store.ts`, and deliberately so. That store serves LFG's
// own headless agents: the agent is alive on the other end of a long-poll, and
// the question dies with the process. A Calyx ask is the opposite by design —
// the agent writes its question into the task's frontmatter and *exits*, so the
// question survives restarts, machine loss, and days of silence. Answering it is
// what starts the work again.
//
// The record therefore lives in the vault, not here. This module only reads and
// writes that file; it owns no state of its own.
//
// ── The contract (Calyx writes it, we read it) ────────────────────────────────
// Calyx's ExecutionEngine writes, on block:
//     execution_status: "blocked"
//     blocked_reason:   "<plain sentence>"
//     blocked_question: <AskQuestion[]> | null
//     unblock_comments: ""            ← cleared, so a stale answer can't satisfy
//                                       a new question
// and its wake scan resumes the task when `unblock_comments` becomes non-empty.
// So: writing the answer into that field IS the resumption. There is no second
// mechanism, and we must not invent one.
//
// The question shape mirrors `src/lib/shared/askQuestions.ts` in the Calyx repo
// (the "the-card.md" vocabulary). It is intentionally the SAME vocabulary, not a
// second one — if that file changes, change this reader with it.

import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "./frontmatter.ts";
import { safeResolve } from "./files.ts";
import { scanVault, updateVaultDoc, stripWikilink, type VaultDoc } from "./vault.ts";

/** One answer option, with the consequence of picking it stated plainly. */
export type CalyxAskOption = {
  label: string;
  /** What happens if you choose this — including the ugly part. */
  description?: string;
  recommended?: boolean;
  /** A vault file that IS this option (an HTML mockup, a diagram). */
  preview?: string;
};

export type CalyxAskQuestion = {
  text: string;
  /** Short chip label (Calyx caps this at 24 chars). */
  header?: string;
  options: CalyxAskOption[];
  multiSelect?: boolean;
  allowOther?: boolean;
  /** Vault files to look at before deciding — diagrams, screenshots, write-ups. */
  attachments?: string[];
};

export type CalyxAsk = {
  /** Stable id = the task's repo-relative path. One ask per blocked task. */
  id: string;
  path: string;
  title: string;
  /**
   * Absent (a blocked task) or `"heads-up"` — a "just so you know" item with
   * no question, from `.calyx/heads-ups/`. New field; the phone renders it
   * through the same card with no app change, since it carries the same
   * `reason`/`questions: []`/`answered`/`answer` shape a task ask does.
   */
  kind?: "heads-up";
  /** The plain-sentence reason. Always present; the fallback when there are no options. */
  reason?: string;
  /** Structured questions, when the agent asked properly. May be empty. */
  questions: CalyxAskQuestion[];
  project?: string;
  agent?: string;
  /**
   * True when an answer is already written but the runner hasn't picked it up
   * yet. Shown as "answered — restarting", never as still-pending.
   */
  answered: boolean;
  answer?: string;
  /** Which repo/vault this came from, so a multi-vault phone can say. */
  repo: string;
};

// Calyx's own limits, mirrored so a malformed file can't produce a runaway card.
const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 6;
const MAX_TEXT = 2000;
const MAX_LABEL = 200;
const MAX_DESCRIPTION = 500;
const MAX_HEADER = 24;
const MAX_ATTACHMENTS = 6;
const MAX_PATH = 400;

/**
 * A vault-relative path, or nothing.
 *
 * Re-validated here even though Calyx validates on write, because this reader
 * is the thing that hands a path to a file reader on the phone's behalf, and
 * the file it read could have been edited by hand or arrived over sync. Mirrors
 * `cleanVaultPath` in Calyx's src/lib/shared/askQuestions.ts.
 */
function cleanPath(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const raw = v.trim().replace(/\\/g, "/");
  if (!raw || raw.length > MAX_PATH) return undefined;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return undefined; // http:, file:, data:…
  if (raw.startsWith("/") || raw.startsWith("~")) return undefined;
  const parts = raw.split("/");
  if (parts.some((p) => p === "..")) return undefined;
  return parts.filter((p) => p && p !== ".").join("/") || undefined;
}

function clean(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!t) return undefined;
  return t.length > max ? t.slice(0, max) : t;
}

/**
 * Normalize the untrusted `blocked_question` value into the card shape.
 *
 * Untrusted because an agent wrote it. Anything that doesn't survive
 * normalization is dropped rather than rendered — the plain `reason` is always
 * there as the fallback, so a malformed question degrades to a readable ask
 * instead of an empty card.
 */
export function normalizeQuestions(raw: unknown): CalyxAskQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: CalyxAskQuestion[] = [];
  for (const item of raw.slice(0, MAX_QUESTIONS)) {
    if (!item || typeof item !== "object") continue;
    const q = item as Record<string, unknown>;
    const text = clean(q.text, MAX_TEXT);
    if (!text) continue;

    const options: CalyxAskOption[] = [];
    if (Array.isArray(q.options)) {
      for (const o of q.options.slice(0, MAX_OPTIONS)) {
        if (typeof o === "string") {
          const label = clean(o, MAX_LABEL);
          if (label) options.push({ label });
          continue;
        }
        if (!o || typeof o !== "object") continue;
        const opt = o as Record<string, unknown>;
        const label = clean(opt.label, MAX_LABEL);
        if (!label) continue;
        options.push({
          label,
          description: clean(opt.description, MAX_DESCRIPTION),
          recommended: opt.recommended === true,
          preview: cleanPath(opt.preview),
        });
      }
    }

    const attachments: string[] = [];
    if (Array.isArray(q.attachments)) {
      for (const a of q.attachments.slice(0, MAX_ATTACHMENTS)) {
        const p = cleanPath(a);
        if (p && !attachments.includes(p)) attachments.push(p);
      }
    }

    out.push({
      text,
      header: clean(q.header, MAX_HEADER),
      options,
      multiSelect: q.multiSelect === true,
      allowOther: q.allowOther !== false,
      ...(attachments.length ? { attachments } : {}),
    });
  }
  return out;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

/**
 * Is this doc a Calyx task that is stopped, waiting on a human?
 *
 * Mirrors the runner's own predicate: `execution_status: blocked`. A task whose
 * `unblock_comments` is already filled is still returned — it is "answered,
 * restarting", which the user should see rather than have vanish silently.
 */
function isBlockedTask(d: VaultDoc): boolean {
  if (d.type !== "task") return false;
  return str(d.properties.execution_status)?.toLowerCase() === "blocked";
}

function toAsk(d: VaultDoc, repo: string): CalyxAsk {
  const p = d.properties;
  const answer = str(p.unblock_comments);
  return {
    id: d.path,
    path: d.path,
    title: d.title,
    reason: str(p.blocked_reason),
    questions: normalizeQuestions(p.blocked_question),
    project: stripWikilink(p.project),
    agent: str(p.agent),
    answered: Boolean(answer),
    answer,
    repo,
  };
}

// ── Heads-ups: the "just so you know" item kind ──────────────────────────
//
// Hand-mirrors Calyx's `src/lib/shared/headsUps.ts` — the ONE reader/writer
// of this format in the Calyx repo (docs/tracking/features/universal-
// notifications/). A heads-up is one file, `.calyx/heads-ups/<ULID>.md`:
// frontmatter for the record, body = the message. No `type: task`, no
// `execution_status` — it never runs anything, so it lives outside
// `scanVault`'s task machinery entirely and is read directly from its own
// folder. Keep this in step with that file by hand, same rule as the
// ask-questions mirror above.

const HEADS_UPS_REL_DIR = ".calyx/heads-ups";
const HEADS_UP_TYPE = "heads-up";
const HEADS_UP_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_REPLY = 4000;
// Anchored to the end of the stem so a file a *user* named
// "notes (conflict resolution).md" is not caught — mirrors Calyx's
// src/lib/shared/conflictCopies.ts.
const CONFLICT_COPY_SUFFIX = / \(conflict [A-Za-z0-9_-]{1,40} [0-9a-f]{8,64}\)$/i;

/** Unranked statuses (anything unrecognized) sort as "new" — the safest default. */
const STATUS_RANK: Record<string, number> = { new: 0, replied: 1, done: 2, dismissed: 2 };

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID (26 chars, Crockford base32). Mirrors Calyx's `newHeadsUpId`. */
function newUlid(nowMs: number = Date.now()): string {
  let t = Math.max(0, Math.floor(nowMs));
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i] % 32];
  return time + rand;
}

function isConflictCopyName(fileName: string): boolean {
  const dot = fileName.lastIndexOf(".");
  const stem = dot <= 0 ? fileName : fileName.slice(0, dot);
  return CONFLICT_COPY_SUFFIX.test(stem);
}

type HeadsUpReply = { id: string; at: string; text: string; consumed_by?: string };

type HeadsUpFile = {
  id: string;
  /** Vault-relative path of THIS file — may be a conflict copy. */
  path: string;
  title: string;
  message: string;
  from: string;
  status: string;
  replies: HeadsUpReply[];
};

function parseHeadsUpReplies(v: unknown): HeadsUpReply[] {
  if (!Array.isArray(v)) return [];
  const out: HeadsUpReply[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = clean(r.id, 64);
    const at = typeof r.at === "string" ? r.at : undefined;
    const text = clean(r.text, MAX_REPLY);
    if (!id || !at || !text) continue;
    const consumedBy = clean(r.consumed_by, 200);
    out.push(consumedBy ? { id, at, text, consumed_by: consumedBy } : { id, at, text });
  }
  return out;
}

/** Read and validate one heads-up file. Not a heads-up (wrong `type`, no
 * valid id) → null, so one bad file can't hide the rest. */
function readHeadsUpFile(repoCwd: string, fileName: string): HeadsUpFile | null {
  const rel = `${HEADS_UPS_REL_DIR}/${fileName}`;
  let raw: string;
  try {
    raw = readFileSync(join(repoCwd, rel), "utf8");
  } catch {
    return null;
  }
  const { properties: p, content } = parseFrontmatter(raw);
  if (p.type !== HEADS_UP_TYPE) return null;
  const id = clean(p.id, 26);
  if (!id || !HEADS_UP_ID_RE.test(id)) return null;
  return {
    id,
    path: rel,
    title: clean(p.title, MAX_LABEL) ?? "Heads-up",
    message: (content ?? "").trim(),
    from: clean(p.from, MAX_LABEL) ?? "Agent",
    status: typeof p.status === "string" ? p.status : "new",
    replies: parseHeadsUpReplies(p.replies),
  };
}

/**
 * Every heads-up in one vault. Two files with one id — a sync conflict
 * copy — fold into one item: the non-copy path is the primary, replies are
 * unioned by id. Mirrors `reconcileHeadsUps` in the Calyx repo.
 */
function listHeadsUpFiles(repoCwd: string): HeadsUpFile[] {
  let names: string[];
  try {
    names = readdirSync(join(repoCwd, HEADS_UPS_REL_DIR));
  } catch {
    return [];
  }
  const byId = new Map<string, HeadsUpFile>();
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const item = readHeadsUpFile(repoCwd, name);
    if (!item) continue;
    const existing = byId.get(item.id);
    if (!existing) {
      byId.set(item.id, item);
      continue;
    }
    const itemIsCopy = isConflictCopyName(name);
    const existingIsCopy = isConflictCopyName(existing.path.slice(existing.path.lastIndexOf("/") + 1));
    const primary = existingIsCopy && !itemIsCopy ? item : existing;
    const other = primary === existing ? item : existing;
    const replies = [...primary.replies];
    for (const r of other.replies) {
      if (!replies.some((x) => x.id === r.id)) replies.push(r);
    }
    replies.sort((a, b) => a.at.localeCompare(b.at));
    // A reply can land on whichever copy the sync engine wrote last, and it
    // flips that file's own `status` alongside it — so the merged status must
    // be the furthest-along of the two, not just the primary's.
    const status = STATUS_RANK[other.status] > STATUS_RANK[primary.status] ? other.status : primary.status;
    byId.set(item.id, { ...primary, replies, status });
  }
  return [...byId.values()];
}

function toHeadsUpAsk(h: HeadsUpFile, repo: string): CalyxAsk {
  const lastReply = h.replies[h.replies.length - 1];
  return {
    id: h.path,
    path: h.path,
    title: h.title,
    kind: "heads-up",
    reason: h.message,
    questions: [],
    agent: h.from,
    answered: h.status !== "new",
    answer: lastReply?.text,
    repo,
  };
}

/** Every heads-up worth showing on the phone — `done`/`dismissed` are dealt
 * with and drop out, same as an answered task ask eventually would. */
function listHeadsUpAsks(repoCwd: string, repoName: string): CalyxAsk[] {
  return listHeadsUpFiles(repoCwd)
    .filter((h) => h.status !== "done" && h.status !== "dismissed")
    .map((h) => toHeadsUpAsk(h, repoName));
}

/**
 * Append a reply to a heads-up file and, if it was still `new`, mark it
 * `replied` — never touching any other key. Mirrors `appendHeadsUpReply` in
 * the Calyx repo, through this repo's own surgical frontmatter writer so the
 * file's other fields survive byte-for-byte.
 */
async function answerHeadsUp(repoCwd: string, relPath: string, text: string): Promise<void> {
  const abs = await safeResolve(repoCwd, relPath);
  const raw = readFileSync(abs, "utf8");
  const { properties: p } = parseFrontmatter(raw);
  if (p.type !== HEADS_UP_TYPE) throw new Error("not a heads-up file");
  const replies = parseHeadsUpReplies(p.replies);
  const reply: HeadsUpReply = { id: newUlid(), at: new Date().toISOString(), text };
  const status = p.status === "new" ? "replied" : typeof p.status === "string" ? p.status : "replied";
  await updateVaultDoc(repoCwd, relPath, { replies: [...replies, reply], status });
}

/** Every stopped-and-waiting task, plus every open heads-up, newest-looking first. */
export function listCalyxAsks(repoCwd: string, repoName: string): CalyxAsk[] {
  const { docs } = scanVault(repoCwd);
  const taskAsks = docs.filter(isBlockedTask).map((d) => toAsk(d, repoName));
  const headsUpAsks = listHeadsUpAsks(repoCwd, repoName);
  // Unanswered first — those are the ones actually holding work up.
  return [...taskAsks, ...headsUpAsks].sort((a, b) => Number(a.answered) - Number(b.answered));
}

/**
 * Answer an ask.
 *
 * For a blocked task, writing into the task file IS the resumption:
 * deliberately a plain frontmatter merge through the same surgical splice the
 * status picker uses, so every byte the user wrote outside `unblock_comments`
 * is preserved. We do NOT touch `execution_status` or clear `blocked_question`
 * — the runner owns that transition, and racing it would strand the task.
 *
 * For a heads-up (`relPath` under `.calyx/heads-ups/`), there is nothing to
 * resume — replying only appends to `replies[]`. A runner's own wake scan, on
 * its own machine, decides whether that reply restarts anything.
 */
export async function answerCalyxAsk(
  repoCwd: string,
  relPath: string,
  answer: string,
): Promise<{ path: string; answered: string }> {
  const text = answer.trim();
  if (!text) throw new Error("answer cannot be empty");
  if (relPath.startsWith(`${HEADS_UPS_REL_DIR}/`)) {
    await answerHeadsUp(repoCwd, relPath, text);
    return { path: relPath, answered: text };
  }
  await updateVaultDoc(repoCwd, relPath, { unblock_comments: text });
  return { path: relPath, answered: text };
}

/**
 * Read a task's body for the briefing.
 *
 * The card shows the question first; the briefing is what the agent wrote into
 * the note, opened only if you want it. Kept out of the list payload — a phone
 * listing twenty asks should not carry twenty note bodies.
 */
export function readAskBody(repoCwd: string, relPath: string): string {
  try {
    const raw = readFileSync(join(repoCwd, relPath), "utf8");
    // Strip the frontmatter block; the body is the human-readable half.
    const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw);
    return (m ? raw.slice(m[0].length) : raw).trim();
  } catch {
    return "";
  }
}
