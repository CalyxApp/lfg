// Repo file browsing + content search for the Files/Search tabs.
//
// Every function operates on an absolute repo cwd plus a repo-relative path; the
// caller (serve.ts) resolves a repo *name* → cwd via listRepos(). Nothing here
// trusts a raw path: safeResolve() rejects anything escaping the repo root, and
// every git invocation uses an arg array (no shell) so a query or path can't
// inject. lfg's web API has no auth of its own, so these are a real surface.

import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const MAX_FILE_BYTES = 1_000_000; // 1 MB — larger files return { tooLarge } for a mobile viewer
const MAX_SEARCH_RESULTS = 200;
const MAX_MATCH_LEN = 300; // trim long (e.g. minified) matched lines

export type TreeEntry = { name: string; path: string; type: "dir" | "file" };
export type FileResult =
  | { path: string; size: number; content: string }
  | { path: string; size: number; binary: true }
  | { path: string; size: number; tooLarge: true };
export type GrepMatch = { path: string; line: number; text: string };

/** Resolve a repo-relative path to an absolute one, rejecting traversal outside the repo. */
export async function safeResolve(repoCwd: string, rel: string): Promise<string> {
  const root = await realpath(repoCwd).catch(() => resolve(repoCwd));
  const abs = resolve(root, rel || ".");
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error("path escapes repository");
  }
  return abs;
}

function git(repoCwd: string, args: string[], stdin?: string) {
  const proc = Bun.spawnSync({
    cmd: ["git", "-C", repoCwd, ...args],
    stdin: stdin !== undefined ? Buffer.from(stdin) : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { ok: proc.exitCode === 0, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

/** Immediate children of `rel` inside the repo — .gitignore-aware, dirs first. */
export async function listDir(repoCwd: string, rel: string): Promise<TreeEntry[]> {
  const abs = await safeResolve(repoCwd, rel);
  const dirents = await readdir(abs, { withFileTypes: true });
  const candidates = dirents
    .filter((d) => d.name !== ".git")
    .map((d) => ({ name: d.name, isDir: d.isDirectory(), rel: rel ? join(rel, d.name) : d.name }));

  // One `git check-ignore` over every candidate to drop .gitignore'd entries.
  // Exit 0 = one or more ignored (listed on stdout); exit 1 = none ignored.
  const ignored = new Set<string>();
  if (candidates.length) {
    const r = git(repoCwd, ["check-ignore", "--stdin"], candidates.map((c) => c.rel).join("\n") + "\n");
    if (r.ok) for (const l of r.out.split("\n")) if (l.trim()) ignored.add(l.trim());
  }

  return candidates
    .filter((c) => !ignored.has(c.rel))
    .map((c) => ({ name: c.name, path: c.rel, type: c.isDir ? ("dir" as const) : ("file" as const) }))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
}

/** Read a single file's contents, guarding size and binary payloads. */
export async function readRepoFile(repoCwd: string, rel: string): Promise<FileResult> {
  const abs = await safeResolve(repoCwd, rel);
  const st = await stat(abs);
  if (!st.isFile()) throw new Error("not a file");
  if (st.size > MAX_FILE_BYTES) return { path: rel, size: st.size, tooLarge: true };
  const buf = await readFile(abs);
  if (buf.subarray(0, 8192).includes(0)) return { path: rel, size: st.size, binary: true }; // NUL sniff
  return { path: rel, size: st.size, content: buf.toString("utf8") };
}

/** Literal, case-insensitive content search across a repo (tracked + untracked, .gitignore-aware). */
export function gitGrep(repoCwd: string, query: string, opts?: { max?: number }): GrepMatch[] {
  const max = opts?.max ?? MAX_SEARCH_RESULTS;
  // -F fixed-string, -n line numbers, -I skip binary, -i case-insensitive, --untracked include new files.
  // Exit 1 = no matches (not an error); the arg-array form keeps `query` inert.
  const r = git(repoCwd, ["grep", "-F", "-n", "-I", "-i", "--untracked", "-e", query]);
  const matches: GrepMatch[] = [];
  for (const line of r.out.split("\n")) {
    if (!line) continue;
    const first = line.indexOf(":");
    const second = line.indexOf(":", first + 1);
    if (first < 0 || second < 0) continue;
    matches.push({
      path: line.slice(0, first),
      line: parseInt(line.slice(first + 1, second), 10) || 0,
      text: line.slice(second + 1).slice(0, MAX_MATCH_LEN),
    });
    if (matches.length >= max) break;
  }
  return matches;
}
