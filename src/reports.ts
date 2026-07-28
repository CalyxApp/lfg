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

// ---------------------------------------------------------------------------
// Vault-path chips (ported verbatim from the Calyx desktop app so the mobile
// reports show the SAME "mention pills" as the VS Code fork's ReportViewer —
// webview-ui/src/components/reports/ReportViewer.tsx: linkifyVaultPaths /
// prettifyName / CHIP_STYLES / CHIP_ICON). The desktop post-processes the DOM
// in React (its iframe is sandbox=allow-same-origin); our report iframe is
// sandbox=allow-scripts (cross-origin), so we can't touch its DOM from the
// parent — instead we apply the same transform to the HTML at serve time and
// inject a small click-forwarder that postMessages the tapped path up to the
// app. "Implementation differs, the recognition/affordance logic is reused."
// ---------------------------------------------------------------------------

// A relative vault path: path-like chars, at least one segment, optional
// trailing slash. Excludes absolute paths, URLs (":"), and commands (spaces).
const RELATIVE_PATH = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\/?$/;

const CHIP_STYLE_MARKER = "data-chiron-chips";

const CHIP_STYLES = `<style ${CHIP_STYLE_MARKER}>
  .chiron-path-chip {
    display: inline-flex; align-items: center; gap: 0.3em;
    padding: 0.08em 0.55em 0.08em 0.45em; border-radius: 999px;
    background: rgba(201,122,58,0.10); color: #b06a30;
    border: 1px solid rgba(201,122,58,0.18); font-family: inherit;
    font-size: 0.86em; font-weight: 500; line-height: 1.4; white-space: nowrap;
    vertical-align: baseline; cursor: pointer; text-decoration: none;
  }
  .chiron-path-chip:hover { background: rgba(201,122,58,0.18); }
  .chiron-path-chip:active { transform: scale(0.97); }
  .chiron-path-chip svg { width: 0.85em; height: 0.85em; opacity: 0.7; flex-shrink: 0; }
  @media (prefers-color-scheme: dark) {
    .chiron-path-chip { background: rgba(224,160,106,0.12); color: #e0a06a; border-color: rgba(224,160,106,0.22); }
    .chiron-path-chip:hover { background: rgba(224,160,106,0.2); }
  }
</style>`;

const CHIP_ICON =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" ' +
  'stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 4.5a1 1 0 0 1 1-1h3.2l1.3 1.5h6a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1z"/></svg>';

// "calyx-chrome-extension" -> "Calyx Chrome Extension"
function prettifyName(leaf: string): string {
  return leaf
    .replace(/\.[A-Za-z0-9]+$/, "")
    .replace(/[-_]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// Replace <code> spans holding a relative vault path with a chip. Unlike the
// desktop original we also stash the (normalized) path in data-vault-path so a
// tap can be resolved to a file — the desktop drops it, keeping only the name.
function linkifyVaultPaths(html: string): string {
  return html.replace(/<code>([^<]*?)<\/code>/gi, (match, raw) => {
    const path = String(raw).trim();
    if (!path.includes("/") || !RELATIVE_PATH.test(path)) return match;
    const segments = path.split("/").filter(Boolean);
    const leaf = segments[segments.length - 1];
    const name = leaf && prettifyName(leaf);
    if (!name) return match;
    const clean = path.replace(/\/+$/, ""); // chars are already [A-Za-z0-9._-/]-safe
    return `<span class="chiron-path-chip" data-vault-path="${clean}" role="link" tabindex="0">${CHIP_ICON}${name}</span>`;
  });
}

function injectChipStyles(html: string): string {
  if (html.includes(CHIP_STYLE_MARKER)) return html;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>\n${CHIP_STYLES}`);
  return `${CHIP_STYLES}\n${html}`;
}

// Tap a chip (or any relative-path anchor) -> tell the app to open that vault
// file. Runs inside the sandboxed iframe (allow-scripts); postMessage is the
// only channel to the parent. The app listens for "calyx-open-vault" (Phase 2).
const FORWARDER =
  "<script>(function(){function p(el){var c=el.closest?el.closest('[data-vault-path]'):null;" +
  "if(c)return c.getAttribute('data-vault-path');var a=el.closest?el.closest('a[href]'):null;" +
  "if(a){var h=a.getAttribute('href')||'';if(/^[a-z]+:/i.test(h)||h.charAt(0)==='#'||h.charAt(0)==='/')return null;" +
  "return h.replace(/^([.][.]?\\/)+/,'').replace(/[?#].*$/,'')||null;}return null;}" +
  "document.addEventListener('click',function(e){var t=e.target;if(!t)return;var el=t.nodeType===1?t:t.parentElement;" +
  "if(!el)return;var path=p(el);if(!path)return;e.preventDefault();" +
  "try{parent.postMessage({type:'calyx-open-vault',path:path},'*');}catch(_){}" +
  "},true);})();</scr" + "ipt>";

function injectForwarder(html: string): string {
  return html.includes("</body>") ? html.replace("</body>", FORWARDER + "</body>") : html + FORWARDER;
}

// Full report HTML as served to the app: vault paths -> chips, chip styles +
// click-forwarder injected. Pure string transform over the on-disk report.
export function renderReportHtml(html: string): string {
  return injectForwarder(injectChipStyles(linkifyVaultPaths(html)));
}
