import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appendToBody, editNote, splitNote } from "./note-body.ts";

// note-body.ts is a verbatim port of Calyx's src/lib/shared/noteBody.ts below a
// three-line header. When a Calyx clone is on this machine, prove it still is.
const CALYX_CANDIDATES = [
  process.env.CALYX_REPO,
  join(import.meta.dir, "..", "..", "mdEditorTestExtenstionVscode"),
  join(import.meta.dir, "..", "..", "Chiron", "mdEditorTestExtenstionVscode"),
  "/home/openclaw/repos/mdEditorTestExtenstionVscode",
].filter((p): p is string => !!p);

describe("note-body port", () => {
  const calyx = CALYX_CANDIDATES.map((r) => join(r, "src/lib/shared/noteBody.ts")).find((p) => existsSync(p));

  test.skipIf(!calyx)("is byte-identical to Calyx's noteBody.ts", () => {
    const ours = readFileSync(join(import.meta.dir, "note-body.ts"), "utf8").split("\n").slice(3).join("\n");
    expect(ours).toBe(readFileSync(calyx!, "utf8"));
  });

  test("adds above the comments block, never below it", () => {
    const tail = "<!-- calyx-comments -->\ncomments:\n  c_1:\n    by: user\n";
    const raw = `---\ntitle: x\n---\n## Why now\n- a\n\n${tail}`;
    const out = appendToBody(raw, "- b");
    expect(splitNote(out).tail).toBe(tail);
    const r = editNote(raw, { action: "add", section: "why now", text: "- c" });
    expect(r.ok && r.text).toContain("- a\n- c\n");
  });
});
