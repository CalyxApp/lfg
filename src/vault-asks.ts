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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scanVault, updateVaultDoc, stripWikilink, type VaultDoc } from "./vault.ts";

/** One answer option, with the consequence of picking it stated plainly. */
export type CalyxAskOption = {
  label: string;
  /** What happens if you choose this — including the ugly part. */
  description?: string;
  recommended?: boolean;
};

export type CalyxAskQuestion = {
  text: string;
  /** Short chip label (Calyx caps this at 24 chars). */
  header?: string;
  options: CalyxAskOption[];
  multiSelect?: boolean;
  allowOther?: boolean;
};

export type CalyxAsk = {
  /** Stable id = the task's repo-relative path. One ask per blocked task. */
  id: string;
  path: string;
  title: string;
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
        });
      }
    }

    out.push({
      text,
      header: clean(q.header, MAX_HEADER),
      options,
      multiSelect: q.multiSelect === true,
      allowOther: q.allowOther !== false,
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

/** Every stopped-and-waiting task in one vault, newest-looking first. */
export function listCalyxAsks(repoCwd: string, repoName: string): CalyxAsk[] {
  const { docs } = scanVault(repoCwd);
  const asks = docs.filter(isBlockedTask).map((d) => toAsk(d, repoName));
  // Unanswered first — those are the ones actually holding work up.
  return asks.sort((a, b) => Number(a.answered) - Number(b.answered));
}

/**
 * Answer an ask by writing into the task file — which IS the resumption.
 *
 * Deliberately a plain frontmatter merge through the same surgical splice the
 * status picker uses: every byte the user wrote outside `unblock_comments` is
 * preserved. We do NOT touch `execution_status` or clear `blocked_question` —
 * the runner owns that transition, and racing it would strand the task.
 */
export async function answerCalyxAsk(
  repoCwd: string,
  relPath: string,
  answer: string,
): Promise<{ path: string; answered: string }> {
  const text = answer.trim();
  if (!text) throw new Error("answer cannot be empty");
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
