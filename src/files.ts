// Repo file browsing + content search for the Files/Search tabs.
//
// Every function operates on an absolute repo cwd plus a repo-relative path; the
// caller (serve.ts) resolves a repo *name* → cwd via listRepos(). Nothing here
// trusts a raw path: safeResolve() rejects anything escaping the repo root, and
// every git invocation uses an arg array (no shell) so a query or path can't
// inject. lfg's web API has no auth of its own, so these are a real surface.

import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

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
  // Symlink hardening: realpath the target (or, for not-yet-created paths, its
  // deepest existing ancestor) and re-check — an in-repo symlink must not lead
  // outside the repo. Now load-bearing: this module has write paths.
  let probe = abs;
  for (;;) {
    let real: string;
    try {
      real = await realpath(probe);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
      continue;
    }
    if (real !== root && !real.startsWith(root + sep)) throw new Error("path escapes repository");
    break;
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

/** Write (or create) a UTF-8 text file inside the repo. Creates parent dirs for new files. */
export async function writeRepoFile(
  repoCwd: string,
  rel: string,
  content: string,
  opts?: { createOnly?: boolean },
): Promise<{ path: string; size: number; created: boolean }> {
  if (!rel) throw new Error("path required");
  const size = Buffer.byteLength(content, "utf8");
  if (size > MAX_FILE_BYTES) throw new Error("file too large");
  const abs = await safeResolve(repoCwd, rel);
  const st = await stat(abs).catch((e) => {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  });
  if (st && !st.isFile()) throw new Error("not a file");
  if (st && opts?.createOnly) throw new Error("file already exists");
  if (!st) await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
  return { path: rel, size, created: !st };
}

/**
 * Run `fn` while holding the repo's sync lock (`.git/calyx-sync.lock`, kernel
 * flock). vault-sync.sh holds the same lock around its fetch/rebase/push, so a
 * mobile commit can never land mid-rebase and get orphaned when the rebase
 * moves the branch — the one data-loss race that fires with NO conflict.
 * Mechanism: a child `flock … sh` acquires the lock, prints "ok", then blocks
 * on `read` until we close its stdin — releasing the lock (kernel-released
 * even if we crash). On systems without flock(1) (macOS dev) or if acquisition
 * times out (15s), we run without the lock rather than fail the save.
 */
export async function withRepoLock<T>(repoCwd: string, fn: () => T): Promise<T> {
  type Holder = { stdout: ReadableStream<Uint8Array>; stdin: { end(): void }; kill(): void };
  let holder: Holder | null = null;
  try {
    try {
      holder = Bun.spawn(
        ["flock", "-w", "15", join(repoCwd, ".git", "calyx-sync.lock"), "sh", "-c", "echo ok; read _"],
        { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
      ) as unknown as Holder;
      const reader = holder.stdout.getReader();
      const first = await reader.read();
      reader.releaseLock();
      if (!first.value || !new TextDecoder().decode(first.value).startsWith("ok")) {
        holder.kill();
        holder = null; // timed out or flock unhappy — proceed unlocked
      }
    } catch {
      holder = null; // flock(1) missing (macOS dev) — proceed unlocked
    }
    return fn();
  } finally {
    if (holder) {
      try {
        holder.stdin.end();
      } catch {
        holder.kill();
      }
    }
  }
}

/**
 * Stage and commit specific paths only (pathspec commit — never sweeps other
 * staged work in a shared checkout). Returns the short hash, or null when the
 * save was a no-op or the file is .gitignore'd (saved to disk, nothing to commit).
 */
export function gitCommitPaths(repoCwd: string, paths: string[], message: string): string | null {
  if (!paths.length) return null;
  const ignored = git(repoCwd, ["check-ignore", "--stdin"], paths.join("\n") + "\n");
  const commitable = ignored.ok
    ? paths.filter((p) => !ignored.out.split("\n").map((l) => l.trim()).includes(p))
    : paths;
  if (!commitable.length) return null;
  const add = git(repoCwd, ["add", "--", ...commitable]);
  if (!add.ok) throw new Error(add.err.trim() || "git add failed");
  const staged = git(repoCwd, ["diff", "--cached", "--name-only", "--", ...commitable]);
  if (!staged.out.trim()) return null;
  const commit = git(repoCwd, [
    "-c", "user.name=Calyx Mobile",
    "-c", "user.email=mobile@calyxapp.co",
    "commit", "-m", message, "--", ...commitable,
  ]);
  if (!commit.ok) throw new Error(commit.err.trim() || "git commit failed");
  const hash = git(repoCwd, ["rev-parse", "--short", "HEAD"]);
  return hash.ok ? hash.out.trim() : "";
}

const RAW_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".pdf": "application/pdf",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
};
const MAX_RAW_BYTES = 20_000_000; // images/PDFs get a fatter cap than text

/**
 * Raw bytes + content-type for preview-able assets (images, PDF, HTML).
 * HTML/SVG are active content — the caller MUST serve these with a sandboxing
 * CSP header; this module only vouches for path safety and size.
 */
export async function readRepoFileRaw(
  repoCwd: string,
  rel: string,
): Promise<{ bytes: Uint8Array; type: string; size: number }> {
  const dot = rel.lastIndexOf(".");
  const type = dot >= 0 ? RAW_TYPES[rel.slice(dot).toLowerCase()] : undefined;
  if (!type) throw new Error("unsupported preview type");
  const abs = await safeResolve(repoCwd, rel);
  const st = await stat(abs);
  if (!st.isFile()) throw new Error("not a file");
  if (st.size > MAX_RAW_BYTES) throw new Error("file too large");
  const buf = await readFile(abs);
  return { bytes: buf, type, size: st.size };
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
