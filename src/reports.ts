// Reports store — read-only view over the Calyx vault's `reports/` folder.
//
// The Calyx VS Code extension writes each generated report as a SELF-CONTAINED
// `.html` file (inline styles, light/dark aware) with its metadata carried in
// `<meta name="chiron:*">` tags in the head. We don't duplicate or re-store any
// of that — this module just scans the folder, parses those meta tags into a
// small ReportItem, and serves the raw HTML so the PWA can render it in the same
// sandboxed iframe used for HTML artifacts. New nightly reports appear for free.

import { closeSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ReportItem = {
  id: string; // filename without `.html`
  title: string;
  source: string; // briefing | agent | scheduled | manual
  status: string; // ready | generating | failed
  created: string; // ISO timestamp
  reportType?: string; // category, e.g. daily-briefing
  format?: string; // html | markdown (stored as html post-conversion)
  url: string; // /api/reports/:id — raw HTML
};

// Default to the Calyx vault the extension writes to (see the global env
// orientation: "User vault | ~/.openclaw/workspace/"). Overridable so the
// folder can be relocated without a code change.
function reportsDir(): string {
  return process.env.LFG_REPORTS_DIR || join(homedir(), ".openclaw", "workspace", "reports");
}

// Matches ReportService.parseMetaTags in the extension: <meta name="chiron:KEY"
// content="VALUE">, self-closing or not, single line.
const META_RE = /<meta\s+name="chiron:([^"]+)"\s+content="([^"]*)"\s*\/?>/gi;

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x0*27;/gi, "'")
    .replace(/&middot;/g, "·")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => safeCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => safeCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&"); // last, so it doesn't re-expand decoded entities
}

function safeCodePoint(n: number): string {
  try {
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
  } catch {
    return "";
  }
}

function parseMeta(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  META_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = META_RE.exec(html))) out[m[1]] = decodeEntities(m[2]);
  return out;
}

// The meta tags live in <head>, so we only need the first few KB of each file —
// avoids reading (potentially large) report bodies just to list them.
function readHead(path: string, bytes = 8192): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.toString("utf8", 0, n);
  } finally {
    closeSync(fd);
  }
}

// Fallback `created` from the filename prefix (YYYY-MM-DDTHH-MM-SS-...) when a
// report predates the meta-tag convention or lacks chiron:created.
function isoFromName(file: string): string {
  const m = file.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (!m) return "";
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`;
}

export function listReports(): ReportItem[] {
  const dir = reportsDir();
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".html"));
  } catch {
    return []; // folder not created yet — no reports
  }
  const items: ReportItem[] = [];
  for (const f of files) {
    try {
      const meta = parseMeta(readHead(join(dir, f)));
      if ((meta.type || "").toLowerCase() !== "report") continue; // only real reports
      const id = f.replace(/\.html$/i, "");
      items.push({
        id,
        title: meta.title || id,
        source: meta.source || "manual",
        status: meta.status || "ready",
        created: meta.created || isoFromName(f),
        reportType: meta.reportType || undefined,
        format: meta.format || undefined,
        url: `/api/calyx-reports/${encodeURIComponent(id)}`,
      });
    } catch {
      // unreadable file — skip, don't fail the whole listing
    }
  }
  items.sort((a, b) => (b.created || "").localeCompare(a.created || ""));
  return items;
}

// Raw HTML for one report. Returns null on any traversal attempt or miss.
export function getReportHtml(id: string): string | null {
  if (!id || id.includes("/") || id.includes("\\") || id.includes("..")) return null;
  try {
    return readFileSync(join(reportsDir(), `${id}.html`), "utf8");
  } catch {
    return null;
  }
}
