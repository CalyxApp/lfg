import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVaultContext, createNote, describeVault } from "./vault-tools.ts";

// Build a throwaway git vault with a single project, so createNote's git commit
// has a repo to write into. Caller rm -rf's the returned path.
function makeVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "vault-tools-test-"));
  execSync("git init -q && git config user.email t@t.t && git config user.name t", {
    cwd: dir,
    shell: "/bin/bash",
  });
  mkdirSync(join(dir, "projects", "calyx-voice"), { recursive: true });
  mkdirSync(join(dir, "areas", "earth-nation"), { recursive: true });
  writeFileSync(
    join(dir, "projects", "calyx-voice", "index.md"),
    "---\ntype: project\nproject_id: calyx-voice\ntitle: CalyxVoice\nstatus: active\n---\n",
  );
  writeFileSync(
    join(dir, "areas", "earth-nation", "index.md"),
    "---\ntype: area\ntitle: Earth Nation\n---\n",
  );
  execSync("git add -A && git commit -qm init", { cwd: dir, shell: "/bin/bash" });
  return dir;
}

describe("createNote task placement (voice-session-findings finding 1)", () => {
  test("a root task lands at tasks/<slug>/index.md, not a project tasks folder", async () => {
    const vault = makeVault();
    try {
      const res = await createNote(vault, { type: "task", title: "Root task one" });
      const body = (await res.json()) as { path: string };
      expect(body.path).toBe("tasks/root-task-one/index.md");
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test("a task that names a project lands in that project's tasks/ folder", async () => {
    const vault = makeVault();
    try {
      const res = await createNote(vault, {
        type: "task",
        title: "Proj task",
        properties: { project: "[[CalyxVoice]]" },
      });
      const body = (await res.json()) as { path: string };
      expect(body.path).toBe("projects/calyx-voice/tasks/proj-task.md");
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test("a non-task note is unaffected (flat file in its type folder)", async () => {
    const vault = makeVault();
    try {
      const res = await createNote(vault, { type: "note", title: "Some note" });
      const body = (await res.json()) as { path: string };
      expect(body.path).toBe("notes/some-note.md");
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});

describe("areas are visible to voice (findings 3)", () => {
  test("buildVaultContext lists areas", () => {
    const vault = makeVault();
    try {
      const ctx = buildVaultContext(vault);
      expect(ctx).toContain("Areas (1)");
      expect(ctx).toContain("Earth Nation");
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test("describe_vault returns an areas list", async () => {
    const vault = makeVault();
    try {
      const body = (await describeVault(vault).json()) as { areas: { title: string }[] };
      expect(Array.isArray(body.areas)).toBe(true);
      expect(body.areas.map((a) => a.title)).toContain("Earth Nation");
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});
