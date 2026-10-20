// PORT of Calyx src/lib/shared/noteBody.ts (CalyxApp/calyx-extension). Everything below this
// line is byte-identical to it; change Calyx first, then copy. note-body.test.ts checks this
// whenever a Calyx clone is present (CALYX_REPO, or a sibling mdEditorTestExtenstionVscode).
/**
 * noteBody — the one way a program changes the TEXT of a note.
 *
 * A note file has up to three parts, in this order:
 *
 *   head  YAML frontmatter: a `---` line at the very top, up to the next `---` line.
 *   body  the user's writing.
 *   tail  the inline-comments block: a `<!-- calyx-comments -->` line, and
 *         everything after it to the end of the file. The editor hides it and
 *         reads it as YAML (src/comments/inline/endmatter.ts).
 *
 * THE RULE: a text edit changes the body only. The head and the tail come back
 * byte-identical, and the tail stays last. "Add to the end of the note" means
 * the end of the body, above the comments block. Text written below the block
 * is hidden in the editor and breaks the block's YAML: every comment on the
 * note loses its author and date, and Calyx refuses new comments (bug
 * voice-append-lands-in-comment-block, 2026-10-20 — the same shape as
 * comment-block-traps-caret, which the editor already guards).
 *
 * Every edit ends in `finish()`, which checks the rule on the result and
 * throws `NoteFrameError` if it fails. A caller cannot break the rule, whatever
 * it passes in.
 *
 * Edits find their place by heading name or by quoting the note's words, never
 * by line number. An edit that would cut through an inline comment
 * (`{==…==}{>>…<<}{#id}`) is refused, not repaired.
 *
 * Pure, with no imports, on purpose: CalyxApp/lfg vendors this file verbatim as
 * src/note-body.ts (its voice and chat tools write notes on the server). Change
 * both together. The marker regex and code masking mirror
 * src/comments/inline/parse.ts — change those together too.
 */

export const COMMENTS_SENTINEL = "<!-- calyx-comments -->";

export interface NoteParts {
  /** The frontmatter, with its closing `---` line and that line's newline. "" when none. */
  head: string;
  /** The user's writing, including any blank lines above the comments block. */
  body: string;
  /** The comments block, from its sentinel to the end of the file. "" when none. */
  tail: string;
}

/** A write that would break the head/body/tail frame. Never caught here. */
export class NoteFrameError extends Error {}

export type BodyEdit =
  /** Add new text. With `section`: under that heading (at its end, or its
   *  start). With `after`: after the line or paragraph holding those words.
   *  With neither: at the end of the body. */
  | { action: "add"; text: string; section?: string; position?: "start" | "end"; after?: string }
  /** Replace the existing words `find` with `text`. */
  | { action: "replace"; find: string; text: string }
  /** Delete the existing words `find` (and the line, if nothing else is left on it). */
  | { action: "delete"; find: string };

export type EditFailure =
  | { ok: false; reason: "not_found"; message: string; headings?: string[]; nearest?: string[] }
  | { ok: false; reason: "ambiguous"; message: string; matches: string[] }
  | { ok: false; reason: "touches_comment"; message: string }
  | { ok: false; reason: "invalid"; message: string };

export interface EditSuccess {
  ok: true;
  /** The whole new file. */
  text: string;
  /** Plain-English account of where the change landed, built from the edit itself. */
  summary: string;
  /** 1-based line in the whole file where the change starts. */
  line: number;
}

export type EditResult = EditSuccess | EditFailure;

// ── split / join ────────────────────────────────────────────────────────────

/** Length of the frontmatter block at the top of `raw`, or 0 when there is none. */
function headLength(raw: string): number {
  const bom = raw.startsWith("﻿") ? 1 : 0;
  const open = /^---[ \t]*\r?\n/.exec(raw.slice(bom));
  if (!open) return 0;
  let i = bom + open[0].length;
  while (i <= raw.length) {
    const nl = raw.indexOf("\n", i);
    const lineEnd = nl === -1 ? raw.length : nl;
    if (/^---[ \t]*\r?$/.test(raw.slice(i, lineEnd))) return nl === -1 ? raw.length : nl + 1;
    if (nl === -1) return 0;
    i = nl + 1;
  }
  return 0;
}

/** Start of the comments block: the LAST sentinel that begins a line, at or
 *  after `from`. Same scan as locateEndmatter (src/comments/inline/endmatter.ts). */
function tailStart(raw: string, from: number): number {
  let idx = raw.lastIndexOf(COMMENTS_SENTINEL);
  while (idx !== -1 && idx >= from) {
    if (idx === 0 || raw[idx - 1] === "\n") return idx;
    idx = idx === 0 ? -1 : raw.lastIndexOf(COMMENTS_SENTINEL, idx - 1);
  }
  return -1;
}

export function splitNote(raw: string): NoteParts {
  const h = headLength(raw);
  const t = tailStart(raw, h);
  return {
    head: raw.slice(0, h),
    body: t === -1 ? raw.slice(h) : raw.slice(h, t),
    tail: t === -1 ? "" : raw.slice(t),
  };
}

/** The user's writing only: no frontmatter, no comments block. For readers. */
export function noteBodyText(raw: string): string {
  return splitNote(raw).body;
}

function sentinelLines(text: string): number {
  let n = 0;
  let idx = text.indexOf(COMMENTS_SENTINEL);
  while (idx !== -1) {
    if (idx === 0 || text[idx - 1] === "\n") n++;
    idx = text.indexOf(COMMENTS_SENTINEL, idx + 1);
  }
  return n;
}

/** Re-attach head and tail to a new body, and prove the rule held. */
function finish(parts: NoteParts, body: string): string {
  // A body only holds a sentinel line if the file was already damaged; never add one.
  if (sentinelLines(body) > sentinelLines(parts.body)) {
    throw new NoteFrameError(`The new text contains the comments marker ${COMMENTS_SENTINEL} on its own line.`);
  }
  // The tail must start a line, or it stops being the comments block.
  if (parts.tail && body.length > 0 && !body.endsWith("\n")) body += "\n";
  const out = parts.head + body + parts.tail;
  const check = splitNote(out);
  if (check.head !== parts.head || check.tail !== parts.tail) {
    throw new NoteFrameError("The edit would change the note's properties block or its comments block.");
  }
  return out;
}

/** Change the body with `fn`, keeping the frontmatter and the comments block
 *  exactly as they are. For writers that already have their own body logic
 *  (a person's Interactions log, a live transcript). */
export function mapBody(raw: string, fn: (body: string) => string): string {
  const parts = splitNote(raw);
  return finish(parts, fn(parts.body));
}

/** Add `text` at the end of the note's writing (above any comments block). */
export function appendToBody(raw: string, text: string): string {
  const r = editNote(raw, { action: "add", text });
  if (!r.ok) throw new NoteFrameError(r.message);
  return r.text;
}

// ── lines, headings, sections ───────────────────────────────────────────────

interface Line {
  start: number;
  /** Index of the line's "\n", or body.length for the last line. */
  end: number;
  text: string;
}

function linesOf(body: string): Line[] {
  const out: Line[] = [];
  let i = 0;
  while (i <= body.length) {
    const nl = body.indexOf("\n", i);
    const end = nl === -1 ? body.length : nl;
    out.push({ start: i, end, text: body.slice(i, end).replace(/\r$/, "") });
    if (nl === -1) break;
    i = nl + 1;
  }
  return out;
}

// A closing run of `#` counts only after a space (CommonMark): "## Learn C#" is "Learn C#".
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const LIST_RE = /^\s*([-*+]|\d+[.)])\s/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

interface Heading {
  level: number;
  text: string;
  /** Index into the lines array. */
  line: number;
}

/** Lines that sit inside a fenced code block (fence lines included). */
function codeLines(lines: Line[]): Set<number> {
  const inCode = new Set<number>();
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE_RE.exec(lines[i].text);
    if (fence) {
      inCode.add(i);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
    } else if (m) {
      inCode.add(i);
      fence = m[1];
    }
  }
  return inCode;
}

function headingsOf(lines: Line[], inCode: Set<number>): Heading[] {
  const out: Heading[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (inCode.has(i)) continue;
    const m = HEADING_RE.exec(lines[i].text);
    const text = m ? m[2].trim() : "";
    if (m && text && !/^#+$/.test(text)) out.push({ level: m[1].length, text, line: i });
  }
  return out;
}

/** Index of the line after a heading's section: the next heading at the same
 *  or a higher level, or the end of the body. */
function sectionEndLine(h: Heading, headings: Heading[], lineCount: number): number {
  for (const other of headings) {
    if (other.line > h.line && other.level <= h.level) return other.line;
  }
  return lineCount;
}

function normHeading(s: string): string {
  return s
    .toLowerCase()
    .replace(/[*_`]/g, "")
    .replace(/[\s:.!?—–-]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** "4. What is Calyx" also answers to "what is calyx". */
function withoutNumbering(s: string): string {
  return s.replace(/^\d+(\.\d+)*[.)]?\s*/, "");
}

/** `needle` appears in `hay` as whole words: "slide 1" is in "slide 1 — cover",
 *  not in "slide 10 — theory". */
function hasWords(hay: string, needle: string): boolean {
  const word = /[\p{L}\p{N}]/u;
  let at = hay.indexOf(needle);
  while (at !== -1) {
    const before = hay[at - 1] ?? "";
    const after = hay[at + needle.length] ?? "";
    const startsOk = !word.test(needle[0]) || !word.test(before);
    const endsOk = !word.test(needle[needle.length - 1]) || !word.test(after);
    if (startsOk && endsOk) return true;
    at = hay.indexOf(needle, at + 1);
  }
  return false;
}

function findHeading(headings: Heading[], wanted: string): Heading | EditFailure {
  const w = normHeading(wanted);
  const wBare = withoutNumbering(w);
  if (!w) return { ok: false, reason: "invalid", message: "The section name is empty." };
  const list = headings.map((h) => h.text);
  const exact = headings.filter((h) => {
    const n = normHeading(h.text);
    return n === w || withoutNumbering(n) === wBare;
  });
  const pick = exact.length
    ? exact
    : headings.filter((h) => {
        const n = withoutNumbering(normHeading(h.text));
        return wBare.length >= 3 && n.length >= 3 && (hasWords(n, wBare) || hasWords(wBare, n));
      });
  if (pick.length === 1) return pick[0];
  if (pick.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      message:
        `${pick.length} headings match "${wanted}". Ask which one, or use \`after\` with words quoted from the one you mean.`,
      matches: pick.map((h) => h.text),
    };
  }
  return {
    ok: false,
    reason: "not_found",
    message: list.length ? `No heading matches "${wanted}".` : "This note has no headings.",
    headings: list,
  };
}

/** The nearest heading above a line, for summaries. */
function sectionOfLine(headings: Heading[], line: number): string | null {
  let found: string | null = null;
  for (const h of headings) {
    if (h.line <= line) found = h.text;
    else break;
  }
  return found;
}

// ── inline comment markers (mirror of src/comments/inline/parse.ts) ────────

const MARKER_REGEX = /\{==([\s\S]*?)==\}(?:\{>>([\s\S]*?)<<\})?(?:\{#([^}]+)\})?/g;

function maskCode(text: string): string {
  const blank = (m: string) => " ".repeat(m.length);
  return text
    .replace(/`{3,}[\s\S]*?`{3,}/g, blank)
    .replace(/~{3,}[\s\S]*?~{3,}/g, blank)
    .replace(/`[^`\n]*`/g, blank);
}

interface Marker {
  from: number;
  anchorFrom: number;
  anchorTo: number;
  to: number;
}

function markersOf(body: string): Marker[] {
  const out: Marker[] = [];
  const masked = maskCode(body);
  MARKER_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER_REGEX.exec(masked)) !== null) {
    const anchorFrom = m.index + 3;
    out.push({ from: m.index, anchorFrom, anchorTo: anchorFrom + (m[1] ?? "").length, to: m.index + m[0].length });
  }
  return out;
}

// ── finding quoted words ────────────────────────────────────────────────────

/** The text a reader sees: marker syntax removed, anchor words kept. `map[i]`
 *  is the body index of visible character i. */
function visibleText(body: string, markers: Marker[]): { text: string; map: number[] } {
  let text = "";
  const map: number[] = [];
  let i = 0;
  for (const mk of [...markers, { from: body.length, anchorFrom: body.length, anchorTo: body.length, to: body.length }]) {
    for (; i < mk.from; i++) {
      text += body[i];
      map.push(i);
    }
    for (let j = mk.anchorFrom; j < mk.anchorTo; j++) {
      text += body[j];
      map.push(j);
    }
    i = mk.to;
  }
  return { text, map };
}

const CHAR_FOLD: Record<string, string> = {
  "‘": "'", "’": "'", "“": '"', "”": '"',
  "–": "-", "—": "-", " ": " ",
};

/** Lower-case, fold curly quotes and dashes, drop `*` `_` `` ` ``, collapse
 *  whitespace. `map[i]` is the input index of normalised character i. */
function normalise(text: string): { text: string; map: number[] } {
  let out = "";
  const map: number[] = [];
  let lastSpace = true;
  for (let i = 0; i < text.length; i++) {
    let c = CHAR_FOLD[text[i]] ?? text[i];
    if (c === "*" || c === "_" || c === "`") continue;
    if (/\s/.test(c)) {
      if (lastSpace) continue;
      c = " ";
      lastSpace = true;
    } else {
      lastSpace = false;
    }
    out += c.toLowerCase();
    map.push(i);
  }
  if (out.endsWith(" ")) {
    out = out.slice(0, -1);
    map.pop();
  }
  return { text: out, map };
}

interface Found {
  from: number;
  to: number;
}

function locate(body: string, markers: Marker[], quote: string): Found[] | EditFailure {
  const q = normalise(quote).text;
  if (!q) return { ok: false, reason: "invalid", message: "The quoted text is empty." };
  const vis = visibleText(body, markers);
  const n = normalise(vis.text);
  const hits: Found[] = [];
  let at = n.text.indexOf(q);
  while (at !== -1) {
    const visFrom = n.map[at];
    const visTo = n.map[at + q.length - 1] + 1;
    hits.push({ from: vis.map[visFrom], to: vis.map[visTo - 1] + 1 });
    // +1, not +q.length: "ha ha" sits in "ha ha ha" twice, so it is ambiguous.
    at = n.text.indexOf(q, at + 1);
  }
  return hits;
}

// ── formatting marks ────────────────────────────────────────────────────────

/** `*` and `` ` `` are always marks; `_` only outside a word (snake_case is text). */
function isMark(s: string, i: number): boolean {
  const c = s[i];
  if (c === "*" || c === "`") return true;
  if (c !== "_") return false;
  const word = /[\p{L}\p{N}]/u;
  return !(word.test(s[i - 1] ?? "") && word.test(s[i + 1] ?? ""));
}

/** Length of the run of mark `c` that ends just before `at`. */
function runBefore(s: string, at: number, c: string): number {
  let i = at;
  while (i > 0 && s[i - 1] === c && isMark(s, i - 1)) i--;
  return at - i;
}

/** Length of the run of mark `c` that starts at `at`. */
function runAfter(s: string, at: number, c: string): number {
  let i = at;
  while (i < s.length && s[i] === c && isMark(s, i)) i++;
  return i - at;
}

/** How many runs of mark `c` lie inside [from, to). */
function runsOf(s: string, from: number, to: number, c: string): number {
  let n = 0;
  for (let i = from; i < to; i++) {
    if (s[i] === c && isMark(s, i) && !(i > from && s[i - 1] === c)) n++;
  }
  return n;
}

/**
 * Quotes match without `*` `_` `` ` `` (see normalise), so a hit can start or
 * end between a formatting mark and its partner. Changed as is, that leaves a
 * stray `**`, which bolds the rest of the line. So widen the hit:
 *   1. over marks the quote itself starts or ends with ("**Eyebrow:** The moment");
 *   2. over the partner of a mark the hit holds without its pair;
 *   3. for a delete, over a pair it would leave empty ("**this**").
 * A hit with no marks in it, quoted with none, is left alone: changing a word
 * inside bold keeps the bold.
 */
function widenOverMarks(body: string, hit: Found, quote: string, deleting: boolean): Found {
  let { from, to } = hit;
  const q = quote.trim();
  for (const c of ["*", "_", "`"]) {
    const lead = runAfter(q, 0, c);
    if (lead) from -= Math.min(lead, runBefore(body, from, c));
    const trail = runBefore(q, q.length, c);
    if (trail) to += Math.min(trail, runAfter(body, to, c));
    if (runsOf(body, from, to, c) % 2 === 1) {
      const before = runBefore(body, from, c);
      if (before) from -= before;
      else to += runAfter(body, to, c);
    }
  }
  while (deleting && from > 0 && "*_`".includes(body[from - 1])) {
    const c = body[from - 1];
    const before = runBefore(body, from, c);
    if (!before || before !== runAfter(body, to, c)) break;
    from -= before;
    to += before;
  }
  return { from, to };
}

function excerpt(s: string, max = 60): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** Lines that share the most words with a quote that matched nothing. */
function nearestLines(lines: Line[], quote: string): string[] {
  const words = new Set(normalise(quote).text.split(" ").filter((w) => w.length > 2));
  if (!words.size) return [];
  return lines
    .map((l) => ({ l, score: normalise(l.text).text.split(" ").filter((w) => words.has(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => excerpt(x.l.text, 100));
}

function lineIndexAt(lines: Line[], offset: number): number {
  for (let i = 0; i < lines.length; i++) {
    if (offset <= lines[i].end) return i;
  }
  return lines.length - 1;
}

function failWhere(lines: Line[], quote: string, hits: Found[]): EditFailure {
  if (!hits.length) {
    return {
      ok: false,
      reason: "not_found",
      message: `The note has no text matching "${excerpt(quote)}". Read the note and quote its words exactly.`,
      nearest: nearestLines(lines, quote),
    };
  }
  return {
    ok: false,
    reason: "ambiguous",
    message: `"${excerpt(quote)}" appears ${hits.length} times. Ask which one, or quote more words.`,
    matches: hits.slice(0, 5).map((h) => excerpt(lines[lineIndexAt(lines, h.from)].text, 100)),
  };
}

/** Refuse a change to [from, to) that would cut through an inline comment.
 *  Words inside one comment's highlighted text may change; the highlight may
 *  not be emptied. */
function commentClash(markers: Marker[], from: number, to: number, replacement: string): EditFailure | null {
  for (const mk of markers) {
    if (to <= mk.from || from >= mk.to) continue;
    const insideAnchor = from >= mk.anchorFrom && to <= mk.anchorTo;
    const empties = insideAnchor && to - from === mk.anchorTo - mk.anchorFrom && !replacement.trim();
    if (insideAnchor && !empties) continue;
    return {
      ok: false,
      reason: "touches_comment",
      message:
        "That text has a comment on it. Resolve or delete the comment in Calyx first, or change words that are not commented.",
    };
  }
  return null;
}

/** An insert position must not fall inside a comment marker (one can span lines). */
function insideMarker(markers: Marker[], at: number): boolean {
  return markers.some((mk) => at > mk.from && at < mk.to);
}

const SPLITS_COMMENT: EditFailure = {
  ok: false,
  reason: "touches_comment",
  message: "That spot is inside a comment's highlighted text. Pick a place outside the comment.",
};

// ── edits ───────────────────────────────────────────────────────────────────

function cleanText(text: string): string {
  return text.replace(/\r/g, "").replace(/^\s*\n/, "").replace(/\s+$/, "");
}

/** Lines between two blocks: one newline keeps a list tight, otherwise a blank line. */
function separator(prevLine: string, nextText: string): string {
  return LIST_RE.test(prevLine) && LIST_RE.test(nextText.split("\n")[0]) ? "\n" : "\n\n";
}

/** Last line of the block that holds line `i`: a heading or list item is its
 *  own block (plus indented continuation lines); a paragraph runs to the next
 *  blank line, heading, list item or fence. */
function blockEndLine(lines: Line[], i: number, inCode: Set<number>): number {
  const own = lines[i].text;
  if (HEADING_RE.test(own)) return i;
  const isList = LIST_RE.test(own);
  let j = i;
  for (let k = i + 1; k < lines.length; k++) {
    const t = lines[k].text;
    if (!t.trim() || inCode.has(k) || HEADING_RE.test(t) || LIST_RE.test(t) || FENCE_RE.test(t)) break;
    if (isList && !/^\s/.test(t)) break;
    j = k;
  }
  return j;
}

function lastContentLine(lines: Line[], from: number, to: number): number {
  for (let i = to - 1; i >= from; i--) if (lines[i].text.trim()) return i;
  return -1;
}

function firstContentLine(lines: Line[], from: number, to: number): number {
  for (let i = from; i < to; i++) if (lines[i].text.trim()) return i;
  return -1;
}

function lineNumber(parts: NoteParts, bodyOffset: number): number {
  const before = parts.head + parts.body.slice(0, bodyOffset);
  return before.split("\n").length;
}

/** Insert `text` after the end of line `afterLine` (or at the top of an empty body). */
function insertAfterLine(body: string, lines: Line[], afterLine: number, text: string): { body: string; at: number } {
  const prev = lines[afterLine];
  const sep = separator(prev.text, text);
  const at = prev.end;
  // Keep the new text apart from what follows too, or a paragraph below would
  // merge into it (a list below a list stays tight).
  const next = lines[afterLine + 1];
  const lastNew = text.split("\n").slice(-1)[0];
  const gap = next && next.text.trim() && separator(lastNew, next.text) === "\n\n" ? "\n" : "";
  return { body: body.slice(0, at) + sep + text + gap + body.slice(at), at: at + sep.length };
}

const RULE_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

/**
 * Where a heading's OWN text ends: before its first sub-heading, and before a
 * divider (`---`) that closes it. "Add to Slide 2" means Slide 2's text — not
 * after its "### detail" sub-section, and not past the `---` onto Slide 3.
 * Returns [first line, line after the last] of that text.
 */
function ownText(h: Heading, headings: Heading[], lines: Line[], inCode: Set<number>): [number, number] {
  let end = sectionEndLine(h, headings, lines.length);
  const sub = headings.find((o) => o.line > h.line && o.line < end);
  if (sub) end = sub.line;
  while (end > h.line + 1) {
    const t = lines[end - 1].text;
    if (t.trim() && !(RULE_RE.test(t) && !inCode.has(end - 1))) break;
    end--;
  }
  return [h.line + 1, end];
}

export function editNote(raw: string, edit: BodyEdit): EditResult {
  const parts = splitNote(raw);
  const body = parts.body;
  const lines = linesOf(body);
  const inCode = codeLines(lines);
  const headings = headingsOf(lines, inCode);
  const markers = markersOf(body);
  // A note written with Windows line endings keeps them; a mixed one is left as is.
  const crlf = body.includes("\r\n") && !/(^|[^\r])\n/.test(body);
  const done = (next: string, at: number, summary: string): EditResult => {
    if (crlf) {
      const head = next.slice(0, at).replace(/\r?\n/g, "\r\n");
      next = head + next.slice(at).replace(/\r?\n/g, "\r\n");
      at = head.length;
    }
    try {
      return { ok: true, text: finish(parts, next), summary, line: lineNumber(parts, at) };
    } catch (e) {
      if (e instanceof NoteFrameError) return { ok: false, reason: "invalid", message: e.message };
      throw e;
    }
  };
  const inSection = (line: number) => {
    const s = sectionOfLine(headings, line);
    return s ? ` in the section "${s}"` : "";
  };

  if (edit.action === "add") {
    const text = cleanText(edit.text ?? "");
    if (!text) return { ok: false, reason: "invalid", message: "There is no text to add." };
    if (edit.section && edit.after) {
      return { ok: false, reason: "invalid", message: "Give a section or an `after` quote, not both." };
    }

    // An empty body: the text becomes the body.
    const last = lastContentLine(lines, 0, lines.length);
    if (last === -1 && !edit.section && !edit.after) {
      const next = (parts.head ? "\n" : "") + text + "\n" + (parts.tail ? "\n" : "");
      return done(next, 0, "Added the text as the note's first content.");
    }

    if (edit.section) {
      const h = findHeading(headings, edit.section);
      if ("ok" in h) return h;
      const [start, end] = ownText(h, headings, lines, inCode);
      if (edit.position === "start") {
        const first = firstContentLine(lines, start, end);
        if (first !== -1) {
          const line = lines[first];
          if (insideMarker(markers, line.start)) return SPLITS_COMMENT;
          const sep = separator(text.split("\n").slice(-1)[0], line.text);
          const next = body.slice(0, line.start) + text + sep + body.slice(line.start);
          return done(next, line.start, `Added at the start of the section "${h.text}".`);
        }
      }
      const lastIn = lastContentLine(lines, start, end);
      const after = lastIn === -1 ? h.line : lastIn;
      if (insideMarker(markers, lines[after].end)) return SPLITS_COMMENT;
      const r = insertAfterLine(body, lines, after, text);
      const tail = lastIn === -1 ? "" : `, after "${excerpt(lines[lastIn].text)}"`;
      return done(r.body, r.at, `Added at the end of the section "${h.text}"${tail}.`);
    }

    if (edit.after) {
      const hits = locate(body, markers, edit.after);
      if (!Array.isArray(hits)) return hits;
      if (hits.length !== 1) return failWhere(lines, edit.after, hits);
      const blockEnd = blockEndLine(lines, lineIndexAt(lines, hits[0].to), inCode);
      if (insideMarker(markers, lines[blockEnd].end)) return SPLITS_COMMENT;
      const r = insertAfterLine(body, lines, blockEnd, text);
      return done(r.body, r.at, `Added after "${excerpt(lines[blockEnd].text)}"${inSection(blockEnd)}.`);
    }

    const r = insertAfterLine(body, lines, last, text);
    return done(r.body, r.at, `Added at the end of the note, after "${excerpt(lines[last].text)}".`);
  }

  if (edit.action === "replace" || edit.action === "delete") {
    const find = edit.find ?? "";
    const hits = locate(body, markers, find);
    if (!Array.isArray(hits)) return hits;
    if (hits.length !== 1) return failWhere(lines, find, hits);
    const { from, to } = widenOverMarks(body, hits[0], find, edit.action === "delete");
    const replacement = edit.action === "replace" ? (edit.text ?? "").replace(/\r/g, "").replace(/\n+$/, "") : "";
    if (edit.action === "replace" && !replacement.trim()) {
      return { ok: false, reason: "invalid", message: "Replace needs new text. To remove words, use delete." };
    }
    const clash = commentClash(markers, from, to, replacement);
    if (clash) return clash;
    const lineIdx = lineIndexAt(lines, from);
    const old = body.slice(from, to);

    if (edit.action === "replace") {
      const next = body.slice(0, from) + replacement + body.slice(to);
      return done(next, from, `Replaced "${excerpt(old)}" with "${excerpt(replacement)}"${inSection(lineIdx)}.`);
    }

    // Delete, then tidy the seam: drop a line left empty (or left as a bare
    // bullet), and close a doubled space.
    let next = body.slice(0, from) + body.slice(to);
    const lineStart = next.lastIndexOf("\n", from - 1) + 1;
    let lineEnd = next.indexOf("\n", from);
    if (lineEnd === -1) lineEnd = next.length;
    const left = next.slice(lineStart, lineEnd);
    if (/^\s*(([-*+]|\d+[.)])([ \t]+\[[ xX]\])?)?\s*$/.test(left)) {
      next = next.slice(0, lineStart) + next.slice(Math.min(lineEnd + 1, next.length));
      next = next.replace(/\n{3,}/g, (m, idx: number) => (idx <= lineStart && idx + m.length >= lineStart ? "\n\n" : m));
    } else {
      if (next[from - 1] === " " && (next[from] === " " || /[.,;:!?]/.test(next[from] ?? ""))) {
        next = next.slice(0, from - 1) + next.slice(from);
      }
    }
    return done(next, Math.min(from, next.length), `Deleted "${excerpt(old)}"${inSection(lineIdx)}.`);
  }

  return { ok: false, reason: "invalid", message: "Unknown edit." };
}
