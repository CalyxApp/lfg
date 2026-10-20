import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runVaultTool } from "./vault-tools.ts";

// The 2026-10-20 incident: a voice call asked for six points "under Why now" in a
// pitch note that ends with an inline-comments block. The old `update` appended to
// the raw file, below the block — hidden in Calyx, and the block's YAML broken.

const TAIL = "<!-- calyx-comments -->\ncomments:\n  c_user_1:\n    by: user\n    at: '2026-10-16T09:43:08.518Z'\n";
const PITCH =
  "---\ntitle: Pitch deck copy v3\ntype: note\n---\n\n## Why now: \n- agents are going mainstream\n- apps are scattered, \n\n\n" +
  "# Team \n- Sam {==solo founder==}{>>say more<<}{#c_user_1}\n\n*End of deck.*\n\n\n" +
  TAIL;
const REL = "projects/fundraise/pitch.md";

let vault: string;
let undoDir: string;
const git = (cmd: string) => execSync(cmd, { cwd: vault, shell: "/bin/bash" }).toString();
const file = () => readFileSync(join(vault, REL), "utf8");
async function tool(name: string, args: Record<string, unknown>, session = "s1") {
  return (await (await runVaultTool(name, vault, args, session)).json()) as Record<string, any>;
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "vault-edit-"));
  undoDir = mkdtempSync(join(tmpdir(), "vault-undo-"));
  process.env.LFG_UNDO_DIR = undoDir;
  git("git init -q && git config user.email t@t.t && git config user.name t");
  mkdirSync(join(vault, "projects", "fundraise"), { recursive: true });
  writeFileSync(join(vault, REL), PITCH);
  git("git add -A && git commit -qm init");
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(undoDir, { recursive: true, force: true });
  delete process.env.LFG_UNDO_DIR;
});

describe("edit: add", () => {
  test("puts text under the named heading and says so", async () => {
    const r = await tool("edit", { name: REL, action: "add", section: "Why now", text: "- Multi-model future" });
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('Added at the end of the section "Why now:", after "- apps are scattered,".');
    expect(file()).toContain("- apps are scattered, \n- Multi-model future\n");
    expect(file().endsWith(TAIL)).toBe(true);
    expect(r.change_id).toBeTruthy();
    expect(git("git log --oneline -1")).toContain("converse: edit");
  });

  test("with no place given, adds at the end of the writing — above the comments", async () => {
    await tool("edit", { name: REL, action: "add", text: "Closing line." });
    expect(file()).toContain("*End of deck.*\n\nClosing line.\n\n\n" + TAIL);
  });

  test("an unknown heading is refused with the real headings, and nothing is written", async () => {
    const r = await tool("edit", { name: REL, action: "add", section: "Go to market", text: "x" });
    expect(r).toMatchObject({ ok: false, error: "not_found" });
    expect(r.headings).toContain("Why now:");
    expect(file()).toBe(PITCH);
  });
});

describe("edit: replace and delete", () => {
  test("replaces exact words", async () => {
    const r = await tool("edit", { name: REL, action: "replace", find: "apps are scattered,", text: "apps are scattered." });
    expect(r.ok).toBe(true);
    expect(file()).toContain("- apps are scattered. \n");
  });

  test("deletes a bullet", async () => {
    await tool("edit", { name: REL, action: "delete", find: "agents are going mainstream" });
    expect(file()).toContain("## Why now: \n- apps are scattered, \n");
  });

  test("refuses to cut through a comment", async () => {
    const r = await tool("edit", { name: REL, action: "delete", find: "Sam solo founder" });
    expect(r).toMatchObject({ ok: false, error: "touches_comment" });
    expect(file()).toBe(PITCH);
  });
});

describe("update", () => {
  test("a legacy append from an older client lands above the comments block", async () => {
    const r = await tool("update", { name: REL, append: "- Legacy point" });
    expect(r.ok).toBe(true);
    expect(file().endsWith(TAIL)).toBe(true);
    expect(file().indexOf("Legacy point")).toBeLessThan(file().indexOf("<!-- calyx-comments -->"));
  });

  test("properties change is undoable", async () => {
    await tool("update", { name: REL, properties: { status: "done" } });
    expect(file()).toContain("status: done");
    const u = await tool("undo", {});
    expect(u.ok).toBe(true);
    expect(file()).toBe(PITCH);
  });
});

describe("read", () => {
  test("never shows the comments block as note text", async () => {
    const r = await tool("read", { name: REL, section: "Team" });
    expect(r.section.text).not.toContain("comments:");
  });
});

describe("undo", () => {
  test("undoes the last change, then the one before it", async () => {
    await tool("edit", { name: REL, action: "add", section: "Why now", text: "- One" });
    const afterOne = file();
    await tool("edit", { name: REL, action: "add", section: "Why now", text: "- Two" });
    expect((await tool("undo", {})).ok).toBe(true);
    expect(file()).toBe(afterOne);
    expect((await tool("undo", {})).ok).toBe(true);
    expect(file()).toBe(PITCH);
    expect(await tool("undo", {})).toMatchObject({ ok: false, error: "nothing_to_undo" });
    expect(git("git log --oneline -1")).toContain("converse: undo");
  });

  test("refuses when the note changed since, and leaves it alone", async () => {
    await tool("edit", { name: REL, action: "add", section: "Why now", text: "- One" });
    writeFileSync(join(vault, REL), file().replace("Sam", "Sam B"));
    const changed = file();
    expect(await tool("undo", {})).toMatchObject({ ok: false, error: "changed_since" });
    expect(file()).toBe(changed);
  });

  test("only undoes this conversation's changes", async () => {
    await tool("edit", { name: REL, action: "add", text: "From another call." }, "other-session");
    expect(await tool("undo", {}, "s1")).toMatchObject({ ok: false, error: "nothing_to_undo" });
  });

  test("undoing a create removes the note and its empty task folder", async () => {
    const c = await tool("create", { type: "task", title: "Review the deck" });
    expect(existsSync(join(vault, c.path))).toBe(true);
    const u = await tool("undo", {});
    expect(u.ok).toBe(true);
    expect(existsSync(join(vault, c.path))).toBe(false);
    expect(existsSync(join(vault, "tasks", "review-the-deck"))).toBe(false);
  });

  test("a named change_id undoes that change", async () => {
    const one = await tool("edit", { name: REL, action: "add", section: "Why now", text: "- One" });
    const u = await tool("undo", { change_id: one.change_id });
    expect(u.ok).toBe(true);
    expect(file()).toBe(PITCH);
  });
});
