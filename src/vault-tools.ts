// vault-tools.ts — the vault agent-tool suite: navigate / retrieve / introspect /
// create / edit a Calyx-style vault (folders of .md notes with YAML frontmatter).
//
// This is the suite the Converse voice gateway advertises to the realtime model
// (see voice-rt.ts), and the intended blueprint for the Calyx mobile app + CLI
// parity — docs/tracking/features/vault-agent-tools/ in the extension repo.
//
// Design: SCAN-FIRST. Every tool answers by scanning the vault's notes in-process
// (scanVault — no subprocess, no synced-config dependency), so it works on ANY vault.
// Built on the existing engine: scanVault / vaultItems / updateVaultDoc (vault.ts),
// listDir / readRepoFile / write (files.ts), parseFrontmatter (frontmatter.ts).
//
// Each tool returns a Response whose JSON body the browser relays verbatim back to
// the model as function_call_output.

import { scanVault, vaultItems, updateVaultDoc, isVault, type VaultDoc } from "./vault.ts";
import { listDir, readRepoFile, writeRepoFile, deleteRepoFile, withRepoLock, gitCommitPaths, gitGrep } from "./files.ts";
import { parseFrontmatter } from "./frontmatter.ts";

// ---- Response + value helpers ----
function json(obj: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(obj), { headers: { "Content-Type": "application/json" }, ...init });
}
function err(status: number, message: string) {
  return json({ error: message }, { status });
}
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "note"
  );
}

// Compose YAML frontmatter ourselves (no dependency on the vault CLI's contentFactory,
// which is version-skewed on the deployed box). JSON-quoting every scalar is valid YAML
// and safely escapes colons/quotes/newlines; arrays render as block sequences.
export function buildFrontmatter(props: Record<string, unknown>): string {
  const lines: string[] = ["---"];
  for (const [k, v] of Object.entries(props)) {
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${JSON.stringify(String(item))}`);
    } else if (v !== undefined && v !== null && String(v) !== "") {
      lines.push(`${k}: ${JSON.stringify(String(v))}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

// ---- matching / resolution (shared by search + read + update) ----

/** Score a doc against a lowercased query on title / path / folder / type. 0 = no match. */
function scoreMatch(ql: string, d: VaultDoc): number {
  const title = d.title.toLowerCase();
  const path = d.path.toLowerCase();
  let s = 0;
  if (title === ql) s += 100;
  else if (title.startsWith(ql)) s += 60;
  else if (title.includes(ql)) s += 40;
  const qTokens = ql.split(/\s+/).filter(Boolean);
  const tTokens = new Set(title.split(/[^a-z0-9]+/).filter(Boolean));
  const overlap = qTokens.filter((t) => tTokens.has(t)).length;
  if (overlap) s += 15 * overlap;
  if (path.includes(ql)) s += 20;
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (folder.includes(ql)) s += 15;
  if (d.type === ql) s += 25;
  return s;
}

type Candidate = { path: string; title: string; type: string };

/**
 * Resolve a user-spoken name (or a path) to a single vault doc. Exact path/title/slug
 * → used directly; otherwise fuzzy-match. Returns { doc } on a confident hit, or
 * { candidates } when ambiguous, or {} when nothing matched.
 */
function resolveDoc(repoCwd: string, nameOrPath: string): { doc?: VaultDoc; candidates?: Candidate[] } {
  const { docs } = scanVault(repoCwd);
  const q = nameOrPath.trim();
  const ql = q.toLowerCase();

  const byPath = docs.find((d) => d.path === q || d.path === `${q}.md` || d.path.toLowerCase() === ql);
  if (byPath) return { doc: byPath };

  const titleExact = docs.filter((d) => d.title.toLowerCase() === ql);
  if (titleExact.length === 1) return { doc: titleExact[0] };

  const slug = slugify(q);
  const bySlug = docs.filter((d) => {
    const base = d.path.split("/").pop()!.replace(/\.mdx?$/i, "").toLowerCase();
    return base === ql || base === slug;
  });
  if (bySlug.length === 1) return { doc: bySlug[0] };

  const scored = docs
    .map((d) => ({ d, s: scoreMatch(ql, d) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  // Confident when there's a single hit, or a clear leader (≥2× the runner-up).
  if (scored.length === 1 || (scored.length > 1 && scored[0].s >= scored[1].s * 2)) return { doc: scored[0].d };
  if (scored.length) return { candidates: scored.slice(0, 6).map((x) => ({ path: x.d.path, title: x.d.title, type: x.d.type })) };
  if (titleExact.length > 1) return { candidates: titleExact.slice(0, 6).map((d) => ({ path: d.path, title: d.title, type: d.type })) };
  return {};
}

// ---- markdown heading helpers (for read) ----
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

function headingsOf(body: string): { level: number; text: string }[] {
  const out: { level: number; text: string }[] = [];
  for (const line of body.split("\n")) {
    const m = HEADING_RE.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2].trim() });
  }
  return out;
}

function extractSection(body: string, section: string): { heading: string; text: string } | null {
  const lines = body.split("\n");
  const sl = section.toLowerCase();
  let start = -1;
  let level = 0;
  let heading = "";
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i]);
    if (m) {
      const h = m[2].trim();
      if (h.toLowerCase() === sl || h.toLowerCase().includes(sl)) {
        start = i;
        level = m[1].length;
        heading = h;
        break;
      }
    }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i]);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return { heading, text: lines.slice(start + 1, end).join("\n").trim().slice(0, 4000) };
}

// ---- tools ----

/** describe_vault — introspection. No type = types+counts, tags, projects. With type = fields/statuses/examples. */
export function describeVault(repoCwd: string, type?: string): Response {
  const wantType = type?.trim().toLowerCase();
  const { docs, truncated } = scanVault(repoCwd);

  if (!wantType) {
    const counts: Record<string, number> = {};
    const tagFreq = new Map<string, number>();
    const projects: Candidate[] = [];
    for (const d of docs) {
      counts[d.type] = (counts[d.type] || 0) + 1;
      const tags = d.properties.tags;
      if (Array.isArray(tags)) {
        for (const t of tags) {
          const tag = str(t);
          if (tag) tagFreq.set(tag, (tagFreq.get(tag) || 0) + 1);
        }
      }
      if (d.type === "project") projects.push({ path: d.path, title: d.title, type: d.type });
    }
    return json({
      isVault: isVault(repoCwd),
      total: docs.length,
      types: Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([t, n]) => ({ type: t, count: n })),
      tags: [...tagFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([tag, count]) => ({ tag, count })),
      projects: projects.slice(0, 60),
      truncated,
    });
  }

  const of = docs.filter((d) => d.type === wantType);
  if (!of.length) {
    const known = [...new Set(docs.map((d) => d.type))].sort();
    return json({ type: wantType, count: 0, note: `No notes of type "${wantType}".`, knownTypes: known });
  }
  const fieldFreq = new Map<string, number>();
  const statuses = new Set<string>();
  const priorities = new Set<string>();
  for (const d of of) {
    for (const k of Object.keys(d.properties)) fieldFreq.set(k, (fieldFreq.get(k) || 0) + 1);
    const st = str(d.properties.status);
    if (st) statuses.add(st);
    const pr = str(d.properties.priority);
    if (pr) priorities.add(pr);
  }
  return json({
    type: wantType,
    count: of.length,
    fields: [...fieldFreq.entries()].sort((a, b) => b[1] - a[1]).map(([field, count]) => ({ field, count })),
    statuses: [...statuses],
    priorities: [...priorities],
    examples: of.slice(0, 6).map((d) => ({ title: d.title, path: d.path })),
    truncated,
  });
}

/** search — structural (title/path/folder/type) + literal content, deduped by file. */
export function searchVault(repoCwd: string, query: string, opts?: { type?: string; limit?: number }): Response {
  const q = query.trim();
  if (!q) return err(400, "query required");
  const ql = q.toLowerCase();
  const limit = Math.min(Math.max(opts?.limit ?? 8, 1), 25);
  const typeFilter = opts?.type?.trim().toLowerCase();
  const { docs, truncated } = scanVault(repoCwd);
  const docByPath = new Map(docs.map((d) => [d.path, d]));
  const pool = typeFilter ? docs.filter((d) => d.type === typeFilter) : docs;

  const scored = new Map<string, { d: VaultDoc; score: number; snippet?: string }>();
  for (const d of pool) {
    const s = scoreMatch(ql, d);
    if (s > 0) scored.set(d.path, { d, score: s });
  }
  // Literal content matches (git grep) supply a real snippet and boost/add results.
  for (const m of gitGrep(repoCwd, q, { max: 80 })) {
    const d = docByPath.get(m.path);
    if (!d) continue; // only .md notes we scanned
    if (typeFilter && d.type !== typeFilter) continue;
    const ex = scored.get(m.path);
    if (ex) {
      if (!ex.snippet) ex.snippet = m.text.trim();
      ex.score += 10;
    } else {
      scored.set(m.path, { d, score: 8, snippet: m.text.trim() });
    }
  }

  const results = [...scored.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => ({ path: r.d.path, title: r.d.title, type: r.d.type, snippet: r.snippet ?? str(r.d.properties.description) }));
  return json({ count: results.length, truncated, results });
}

/** list_by_type — every note of a type as slim rows (reuses the mobile-UI projection). */
export function listByType(repoCwd: string, type: string, limit?: number): Response {
  const t = type?.trim();
  if (!t) return err(400, "type required");
  const { items, truncated } = vaultItems(repoCwd, t);
  const lim = Math.min(Math.max(limit ?? 50, 1), 200);
  const compact = items.slice(0, lim).map((it) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(it)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      out[k] = v;
    }
    return out;
  });
  return json({ type: t.toLowerCase(), count: items.length, returned: compact.length, truncated, items: compact });
}

/** browse — one folder level; each .md entry enriched with its type + title. */
export async function browseVault(repoCwd: string, path?: string): Promise<Response> {
  const rel = (path ?? "").trim().replace(/^\/+|\/+$/g, "");
  let entries;
  try {
    entries = await listDir(repoCwd, rel);
  } catch (e) {
    return err(400, e instanceof Error ? e.message : String(e));
  }
  // Hide hidden/metadata dirs (.git, .obsidian, .calyx, .vscode…) — noise for a voice agent.
  const visible = entries.filter((e) => !e.name.startsWith("."));
  const ENRICH_CAP = 150;
  let enriched = 0;
  const out = await Promise.all(
    visible.map(async (e) => {
      if (e.type === "dir") return { name: e.name, path: e.path, kind: "folder" };
      const isMd = /\.mdx?$/i.test(e.name);
      if (isMd && enriched < ENRICH_CAP) {
        enriched++;
        try {
          const f = await readRepoFile(repoCwd, e.path);
          if ("content" in f) {
            const p = parseFrontmatter(f.content);
            return {
              name: e.name,
              path: e.path,
              kind: "note",
              type: str(p.properties.type) ?? "note",
              title: str(p.properties.title) ?? e.name.replace(/\.mdx?$/i, ""),
            };
          }
        } catch {
          // fall through to the un-enriched shape
        }
      }
      return { name: e.name, path: e.path, kind: isMd ? "note" : "file" };
    }),
  );
  return json({ path: rel || ".", count: out.length, folders: out.filter((o) => o.kind === "folder").length, entries: out });
}

/** read — one note by name/path: properties + heading outline + excerpt, or one section. */
export async function readNote(repoCwd: string, name: string, section?: string): Promise<Response> {
  const q = (name ?? "").trim();
  if (!q) return err(400, "name required");
  const resolved = resolveDoc(repoCwd, q);
  if (!resolved.doc) {
    if (resolved.candidates?.length) return json({ ambiguous: true, candidates: resolved.candidates });
    return err(404, `no note found for "${q}"`);
  }
  const d = resolved.doc;
  const file = await readRepoFile(repoCwd, d.path);
  if (!("content" in file)) return err(400, "note is not readable text");
  const parsed = parseFrontmatter(file.content);
  const outline = headingsOf(parsed.content);

  if (section?.trim()) {
    const sec = extractSection(parsed.content, section.trim());
    if (!sec) {
      return json({
        path: d.path,
        title: d.title,
        type: d.type,
        section: null,
        note: `No section matching "${section}".`,
        outline,
      });
    }
    return json({ path: d.path, title: d.title, type: d.type, section: sec });
  }

  return json({
    path: d.path,
    title: d.title,
    type: d.type,
    properties: parsed.properties,
    outline,
    excerpt: parsed.content.trim().slice(0, 400),
  });
}

/** Where a new note of `type` should live: learn from where existing ones are, else fall back. */
function folderForType(repoCwd: string, type: string): string {
  const { docs } = scanVault(repoCwd);
  const dirs = new Map<string, number>();
  for (const d of docs) {
    if (d.type === type && d.path.includes("/")) {
      const dir = d.path.slice(0, d.path.lastIndexOf("/"));
      dirs.set(dir, (dirs.get(dir) || 0) + 1);
    }
  }
  const top = [...dirs.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top) return top[0];
  return type === "note" ? "notes" : type;
}

/** create — a typed note, filed where notes of that type already live, committed. */
export async function createNote(
  repoCwd: string,
  input: { type?: string; title: string; properties?: Record<string, unknown>; body?: string },
): Promise<Response> {
  const title = (input.title ?? "").trim();
  if (!title) return err(400, "title required");
  const type = (input.type ?? "note").trim().toLowerCase() || "note";
  const folder = folderForType(repoCwd, type);
  const baseSlug = slugify(title);
  const frontmatter = buildFrontmatter({ type, title, ...(input.properties ?? {}) });
  const bodyText = input.body?.trim();
  const content = bodyText ? `${frontmatter}\n\n${bodyText}\n` : `${frontmatter}\n`;
  try {
    const result = await withRepoLock(repoCwd, async () => {
      let written: { path: string } | null = null;
      for (let n = 1; n <= 20; n++) {
        const rel = n === 1 ? `${folder}/${baseSlug}.md` : `${folder}/${baseSlug}-${n}.md`;
        try {
          written = await writeRepoFile(repoCwd, rel, content, { createOnly: true });
          break;
        } catch (e) {
          if (e instanceof Error && e.message.includes("already exists")) continue;
          throw e;
        }
      }
      if (!written) throw new Error("could not find a free filename");
      const commit = gitCommitPaths(repoCwd, [written.path], `converse: ${type} — ${title}`);
      return { path: written.path, commit };
    });
    return json({ ok: true, type, ...result });
  } catch (e) {
    return err(400, e instanceof Error ? e.message : String(e));
  }
}

/**
 * create_project — scaffold a whole project (voice-chat-capabilities #1).
 * Unlike the generic create (one flat note), this builds the vault's standard
 * project shape: `projects/<project_id>/index.md` with the full frontmatter
 * contract (type/project_id/title/status/description/created_at/updated_at/
 * priority/tags) that project views and other tools key off. Additive create →
 * auto-runs (tiered-write model §6); slug de-dup; committed under the lock.
 */
export async function createProject(
  repoCwd: string,
  input: {
    title: string;
    description?: string;
    status?: string;
    priority?: string;
    area?: string;
    tags?: string[];
    body?: string;
  },
): Promise<Response> {
  const title = (input.title ?? "").trim();
  if (!title) return err(400, "title required");
  const baseSlug = slugify(title);
  const now = new Date().toISOString();
  const bodyText = input.body?.trim();
  try {
    const result = await withRepoLock(repoCwd, async () => {
      let written: { path: string } | null = null;
      let projectId = baseSlug;
      for (let n = 1; n <= 20; n++) {
        projectId = n === 1 ? baseSlug : `${baseSlug}-${n}`;
        const frontmatter = buildFrontmatter({
          type: "project",
          project_id: projectId,
          title,
          status: (input.status ?? "active").trim().toLowerCase(),
          description: input.description?.trim() ?? "",
          created_at: now,
          updated_at: now,
          ...(input.priority ? { priority: input.priority.trim().toLowerCase() } : {}),
          ...(input.area ? { area: input.area.trim() } : {}),
          tags: Array.isArray(input.tags) ? input.tags : [],
        });
        const content = `${frontmatter}\n\n# ${title}\n${
          input.description?.trim() ? `\n${input.description.trim()}\n` : ""
        }${bodyText ? `\n${bodyText}\n` : ""}`;
        try {
          written = await writeRepoFile(repoCwd, `projects/${projectId}/index.md`, content, {
            createOnly: true,
          });
          break;
        } catch (e) {
          if (e instanceof Error && e.message.includes("already exists")) continue;
          throw e;
        }
      }
      if (!written) throw new Error("could not find a free project id");
      const commit = gitCommitPaths(repoCwd, [written.path], `converse: project — ${title}`);
      return { project_id: projectId, path: written.path, commit };
    });
    return json({ ok: true, ...result });
  } catch (e) {
    return err(400, e instanceof Error ? e.message : String(e));
  }
}

/**
 * web_search — live web lookup for the assistant (voice-chat-capabilities #2).
 * Not a vault tool strictly, but it lives in the shared toolbelt so BOTH the
 * Converse voice call and the typed chat get it. Runs server-side through
 * OpenAI's Responses API built-in web_search (reuses OPENAI_API_KEY — no new
 * key or search vendor), returning a concise sourced answer the calling model
 * can speak or quote.
 */
export async function webSearch(query: string): Promise<Response> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return err(503, "OPENAI_API_KEY not set on the server");
  const q = query.trim();
  if (!q) return err(400, "query required");
  try {
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.LFG_WEBSEARCH_MODEL || "gpt-5.6-luna",
        tools: [{ type: "web_search" }],
        instructions:
          "Search the web and answer the query concisely — a short paragraph at most. " +
          "Name your sources inline (site name + URL). If results conflict or are thin, say so.",
        input: q,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) return err(502, `web search ${r.status}: ${(await r.text().catch(() => "")).slice(0, 300)}`);
    const j = (await r.json().catch(() => null)) as {
      output?: { content?: { type?: string; text?: string }[] }[];
    } | null;
    const text = (j?.output ?? [])
      .flatMap((it) => it.content ?? [])
      .filter((c) => c.type === "output_text" && c.text)
      .map((c) => c.text)
      .join("\n")
      .trim();
    return json({ result: text || "(no results)" });
  } catch (e) {
    return err(502, `web search failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** update — set frontmatter fields (surgical) and/or append to a note's body, committed. */
export async function updateNote(
  repoCwd: string,
  input: { name: string; properties?: Record<string, unknown>; append?: string },
): Promise<Response> {
  const q = (input.name ?? "").trim();
  if (!q) return err(400, "name required");
  const hasProps = !!input.properties && Object.keys(input.properties).length > 0;
  const hasAppend = !!input.append?.trim();
  if (!hasProps && !hasAppend) return err(400, "nothing to update (provide properties and/or append)");

  const resolved = resolveDoc(repoCwd, q);
  if (!resolved.doc) {
    if (resolved.candidates?.length) return json({ ambiguous: true, candidates: resolved.candidates });
    return err(404, `no note found for "${q}"`);
  }
  const rel = resolved.doc.path;
  const label = resolved.doc.title;
  try {
    const result = await withRepoLock(repoCwd, async () => {
      const changed: string[] = [];
      if (hasProps) {
        await updateVaultDoc(repoCwd, rel, input.properties!);
        changed.push("properties");
      }
      if (hasAppend) {
        const f = await readRepoFile(repoCwd, rel);
        if (!("content" in f)) throw new Error("note is not editable text");
        const next = `${f.content.replace(/\s*$/, "")}\n\n${input.append!.trim()}\n`;
        await writeRepoFile(repoCwd, rel, next, { createOnly: false });
        changed.push("body");
      }
      const commit = gitCommitPaths(repoCwd, [rel], `converse: update ${label}`);
      return { changed, commit };
    });
    return json({ ok: true, path: rel, ...result });
  } catch (e) {
    return err(400, e instanceof Error ? e.message : String(e));
  }
}

/** delete — resolve a note, remove its file, and commit the deletion (recoverable in git history). */
export async function deleteNote(repoCwd: string, input: { name: string }): Promise<Response> {
  const q = (input.name ?? "").trim();
  if (!q) return err(400, "name required");

  const resolved = resolveDoc(repoCwd, q);
  if (!resolved.doc) {
    if (resolved.candidates?.length) return json({ ambiguous: true, candidates: resolved.candidates });
    return err(404, `no note found for "${q}"`);
  }
  const rel = resolved.doc.path;
  const label = resolved.doc.title;
  try {
    const result = await withRepoLock(repoCwd, async () => {
      await deleteRepoFile(repoCwd, rel);
      const commit = gitCommitPaths(repoCwd, [rel], `converse: delete ${label}`);
      return { commit };
    });
    return json({ ok: true, path: rel, deleted: label, ...result });
  } catch (e) {
    return err(400, e instanceof Error ? e.message : String(e));
  }
}

// ---- schemas advertised to the realtime model (client-executed, relayed here) ----
export const VAULT_TOOL_SCHEMAS = [
  {
    type: "function",
    name: "describe_vault",
    description:
      "Learn how the vault is organized before you act. No argument: the kinds of notes that exist (types + counts), common tags, and the list of projects. With a type (e.g. 'task', 'essay', 'project'): its fields, statuses, and example notes. Call this FIRST whenever you don't already know the vault's real type/tag/project names.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", description: "Optional. A note type to describe in detail (e.g. 'task', 'project', 'essay')." },
      },
    },
  },
  {
    type: "function",
    name: "search",
    description:
      "Find notes by title, folder, type, or content. Handles 'find my essays', 'where's the Dragonfly Courses project', 'notes about X'. Returns path, title, type and a snippet per match. Optionally restrict to one type.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for — a title, topic, folder, or phrase." },
        type: { type: "string", description: "Optional. Restrict results to this note type." },
        limit: { type: "number", description: "Max results (default 8)." },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "list_by_type",
    description:
      "List every note of a given type — all tasks, all projects, all essays. Returns slim rows (title, status, priority, due, project, tags). Use for 'all my X'. Call describe_vault first if unsure of the exact type name.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", description: "The note type to list (e.g. 'task', 'project')." },
        limit: { type: "number", description: "Max rows (default 50)." },
      },
      required: ["type"],
    },
  },
  {
    type: "function",
    name: "browse",
    description:
      "List what's inside a folder — subfolders and notes (each note with its type + title). No argument browses the vault root. Use to explore structure, like 'what's in my Essays folder'.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Folder path relative to the vault root. Omit for the root." },
      },
    },
  },
  {
    type: "function",
    name: "read",
    description:
      "Open one note by name or path. Returns its properties and a heading outline; pass a section heading to get just that section's text. Use to actually read a note — never guess its contents.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The note's title, filename, or path." },
        section: { type: "string", description: "Optional. A heading to read just that section." },
      },
      required: ["name"],
    },
  },
  {
    type: "function",
    name: "create",
    description:
      "Create a new note of a given type (defaults to a plain note), filed in the folder where notes of that type already live. Use for 'make a task', 'jot this down'. For a whole new PROJECT use create_project instead. Call describe_vault first if unsure what type or fields to use.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title." },
        type: { type: "string", description: "Note type (e.g. 'task', 'note', 'project'). Defaults to 'note'." },
        properties: {
          type: "object",
          description: "Optional frontmatter fields, e.g. { status: 'todo', priority: 'high', due: '2026-08-01' }.",
          additionalProperties: true,
        },
        body: { type: "string", description: "Optional note body (markdown)." },
      },
      required: ["title"],
    },
  },
  {
    type: "function",
    name: "create_project",
    description:
      "Start a whole new project — scaffolds projects/<project_id>/index.md with the standard project fields (status, description, priority, tags) so it shows up everywhere projects do. Use for 'start a project called X', 'set up a project for Y'. Confirm the title with the user first. Returns the project_id that tasks and notes can reference.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "The project's name." },
        description: { type: "string", description: "One or two sentences on what the project is." },
        status: { type: "string", description: "Project status (default 'active')." },
        priority: { type: "string", description: "Optional: low, medium, or high." },
        area: { type: "string", description: "Optional life/work area this belongs to." },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags." },
        body: { type: "string", description: "Optional extra markdown for the project page (goals, first steps…)." },
      },
      required: ["title"],
    },
  },
  {
    type: "function",
    name: "web_search",
    description:
      "Search the live web — for current events, facts, prices, docs, anything NOT in the user's vault. Returns a concise sourced answer. Don't use it for things the vault tools can answer.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look up, phrased like a search." },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "update",
    description:
      "Change an existing note: set frontmatter fields (e.g. mark a task done) and/or append text to its body. Preserves everything else the user wrote. Use for 'mark X done', 'set priority high', 'add a note to Y'.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The note's title, filename, or path." },
        properties: {
          type: "object",
          description: "Frontmatter fields to set (e.g. { status: 'done' }). A null value deletes a field.",
          additionalProperties: true,
        },
        append: { type: "string", description: "Text to append to the note body (markdown)." },
      },
      required: ["name"],
    },
  },
  {
    type: "function",
    name: "delete",
    description:
      "Permanently remove a note from the vault (the deletion is committed to git history, so it can be recovered). Use for 'delete X', 'remove the note about Y', 'get rid of Z'. Only deletes when the user clearly asks to; confirm the exact note first if there's any ambiguity.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The note's title, filename, or path." },
      },
      required: ["name"],
    },
  },
];

/**
 * Dispatch a relayed tool call. Pure over (repoCwd, args); serve.ts resolves the repo
 * inline. Returns stringifiable JSON the browser forwards to the model verbatim.
 */
export async function runVaultTool(name: string, repoCwd: string, args: Record<string, unknown>): Promise<Response> {
  try {
    switch (name) {
      case "describe_vault":
        return describeVault(repoCwd, str(args.type));
      case "search":
        return searchVault(repoCwd, String(args.query ?? ""), { type: str(args.type), limit: Number(args.limit) || undefined });
      case "list_by_type":
        return listByType(repoCwd, String(args.type ?? ""), Number(args.limit) || undefined);
      case "browse":
        return await browseVault(repoCwd, str(args.path));
      case "read":
        return await readNote(repoCwd, String(args.name ?? ""), str(args.section));
      case "create":
        return await createNote(repoCwd, { type: str(args.type), title: String(args.title ?? ""), properties: obj(args.properties), body: str(args.body) });
      case "web_search":
        return await webSearch(String(args.query ?? ""));
      case "create_project":
        return await createProject(repoCwd, {
          title: String(args.title ?? ""),
          description: str(args.description),
          status: str(args.status),
          priority: str(args.priority),
          area: str(args.area),
          tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
          body: str(args.body),
        });
      case "update":
        return await updateNote(repoCwd, { name: String(args.name ?? ""), properties: obj(args.properties), append: str(args.append) });
      case "delete":
        return await deleteNote(repoCwd, { name: String(args.name ?? "") });
      default:
        return err(404, `unknown tool: ${name}`);
    }
  } catch (e) {
    return err(400, e instanceof Error ? e.message : String(e));
  }
}
