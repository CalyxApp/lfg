// Calyx-vault awareness: scan a repo's markdown frontmatter to surface tasks,
// projects and areas on the phone, and flip task status without disturbing a
// byte the user wrote (surgical frontmatter splice, verified-or-fallback).
//
// Scanner semantics are a port of Calyx cli/src/lib/scanner.ts (keep in sync):
// walk .md/.mdx, skip metadata dirs, title = frontmatter → folder → filename,
// type defaults to "note". Stateless — fast enough for vaults < 5k files.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { parseFrontmatter } from "./frontmatter.ts";
import { updateFrontmatterPreserving } from "./frontmatter-surgeon.ts";
import { safeResolve } from "./files.ts";

const IGNORED_DIRS = new Set([
  ".chiron",
  ".git",
  ".obsidian",
  ".vscode",
  ".trash",
  "node_modules",
  ".claude",
]);
const MAX_DOCS = 5000; // scan cap — code repos can be markdown-heavy

export type VaultDoc = {
  path: string; // repo-relative
  title: string;
  type: string;
  properties: Record<string, unknown>;
};

export type VaultSummary = {
  isVault: boolean; // has a .chiron/ marker dir
  counts: Record<string, number>; // frontmatter type → count
  truncated: boolean;
};

/** A repo "is a vault" when it carries Calyx's .chiron metadata dir. */
export function isVault(repoCwd: string): boolean {
  const p = join(repoCwd, ".chiron");
  return existsSync(p) && statSync(p).isDirectory();
}

function walk(dir: string, repoCwd: string, docs: VaultDoc[]): void {
  if (docs.length >= MAX_DOCS) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // permission denied, racing deletes, etc.
  }
  for (const entry of entries) {
    if (docs.length >= MAX_DOCS) return;
    if (IGNORED_DIRS.has(entry.name)) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, repoCwd, docs);
    } else if (entry.isFile() && /\.mdx?$/i.test(entry.name)) {
      try {
        const content = readFileSync(fullPath, "utf8");
        const parsed = parseFrontmatter(content);
        const fileName = basename(fullPath);
        const isIndex = fileName.toLowerCase() === "index.md";
        let title: string;
        if (typeof parsed.properties.title === "string" && parsed.properties.title.trim()) {
          title = parsed.properties.title.trim();
        } else if (isIndex) {
          title = basename(dirname(fullPath))
            .split("-")
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(" ");
        } else {
          title = fileName.replace(/\.mdx?$/i, "");
        }
        const type =
          typeof parsed.properties.type === "string"
            ? parsed.properties.type.toLowerCase()
            : "note";
        docs.push({ path: relative(repoCwd, fullPath), title, type, properties: parsed.properties });
      } catch {
        // skip unreadable files
      }
    }
  }
}

export function scanVault(repoCwd: string): { docs: VaultDoc[]; truncated: boolean } {
  const docs: VaultDoc[] = [];
  walk(repoCwd, repoCwd, docs);
  return { docs, truncated: docs.length >= MAX_DOCS };
}

export function vaultSummary(repoCwd: string): VaultSummary {
  const { docs, truncated } = scanVault(repoCwd);
  const counts: Record<string, number> = {};
  for (const d of docs) counts[d.type] = (counts[d.type] || 0) + 1;
  return { isVault: isVault(repoCwd), counts, truncated };
}

/** `"[[Calyx Mobile]]"` → `"Calyx Mobile"` (how task frontmatter references its project). */
export function stripWikilink(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const m = /^\s*\[\[([^\]]+)\]\]\s*$/.exec(value);
  return (m ? m[1] : value).trim() || undefined;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

/** Slim, phone-ready item projection for one frontmatter type. */
export function vaultItems(repoCwd: string, type: string): { items: Record<string, unknown>[]; truncated: boolean } {
  const { docs, truncated } = scanVault(repoCwd);
  const wanted = docs.filter((d) => d.type === type.toLowerCase());
  const items = wanted.map((d) => {
    const p = d.properties;
    return {
      path: d.path,
      title: d.title,
      type: d.type,
      status: str(p.status),
      priority: str(p.priority),
      due: str(p.due),
      project: stripWikilink(p.project),
      area: stripWikilink(p.area),
      tags: Array.isArray(p.tags) ? p.tags.filter((t) => typeof t === "string") : undefined,
      description: str(p.description),
      agent: str(p.agent),
    };
  });
  return { items, truncated };
}

/**
 * Merge frontmatter updates into one file, preserving every byte the user
 * wrote outside the touched keys (null value = delete key). Returns the new
 * markdown so the caller can commit/return it.
 */
export async function updateVaultDoc(
  repoCwd: string,
  rel: string,
  updates: Record<string, unknown>,
): Promise<{ path: string; markdown: string }> {
  const abs = await safeResolve(repoCwd, rel);
  const original = readFileSync(abs, "utf8");
  const next = updateFrontmatterPreserving(original, updates);
  await writeFile(abs, next, "utf8");
  return { path: rel, markdown: next };
}
