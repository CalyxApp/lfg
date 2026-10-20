// The seam is the only door (LFG plan, L1): no screen reaches the backend by
// itself. A new `fetch("/api/…")`, socket, stream or beacon outside
// lib/backend fails here, so Calyx Cloud can never be bypassed by accident.
//
// Run: bun test web/src/lib/backend   (from the repo root)

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "..", "..");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

const FILES = sources(SRC)
  .map((path) => ({ file: relative(SRC, path), lines: readFileSync(path, "utf8").split("\n") }))
  .filter(({ file }) => !file.startsWith("lib/backend/"));

const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);

/** Calls that are not the backend, each with why. */
const NOT_THE_BACKEND: Array<{ file: string; has: string; why: string }> = [
  { file: "main.tsx", has: 'fetch("/", { cache: "reload" })', why: "the page's own shell, to spot a new build" },
  { file: "main.tsx", has: 'fetch(path, { cache: "reload" })', why: "the shell's hashed assets, same check" },
  { file: "converse.tsx", has: "fetch(CALLS_URL", why: "OpenAI's realtime API, not ours" },
];

function allowed(file: string, line: string): boolean {
  return NOT_THE_BACKEND.some((a) => a.file === file && line.includes(a.has));
}

describe("the backend seam is the only door", () => {
  test("no bare fetch, socket, stream or beacon outside lib/backend", () => {
    const found: string[] = [];
    const DOOR = /(?<![.\w$])fetch\(|new WebSocket\(|new EventSource\(|sendBeacon\(|fetchEventSource\(/;
    for (const { file, lines } of FILES) {
      lines.forEach((line, i) => {
        if (isComment(line) || !DOOR.test(line) || allowed(file, line)) return;
        found.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(found).toEqual([]);
  });

  test("every /api path is handed to the seam (or to a helper built on it)", () => {
    // The helpers: App.tsx's and BrowserProfiles' api(), lib/api.ts getJson/postJson,
    // SessionDiffView's getJson — each calls backend.* inside.
    const HANDED = /backend\.|\bapi\b\s*[<(]|getJson\s*[<(]|postJson\s*[<(]/;
    const found: string[] = [];
    for (const { file, lines } of FILES) {
      lines.forEach((line, i) => {
        if (isComment(line) || !/["'`]\/api\//.test(line)) return;
        // A call's path can sit a few lines below where the call opens (a typed api<{…}>()).
        const statement = lines.slice(Math.max(0, i - 5), i + 1).join("\n");
        if (HANDED.test(statement)) return;
        // ask-center picks its feed path, then calls backend.fetch(feedUrl).
        if (file === "components/ask-center.tsx" && /feedUrl\s*=/.test(line)) return;
        found.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(found).toEqual([]);
  });

  test("the helpers really are built on the seam", () => {
    const text = (f: string) => FILES.find((x) => x.file === f)!.lines.join("\n");
    expect(text("App.tsx")).toContain("return backend.request<T>(path, init);");
    expect(text("BrowserProfiles.tsx")).toContain("return backend.request<T>(path, init);");
    expect(text("lib/api.ts")).toContain("return backend.request<T>(path);");
    expect(text("components/SessionDiffView.tsx")).toContain("await backend.fetch(path)");
  });
});
