import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "./frontmatter.ts";
import { answerCalyxAsk, listCalyxAsks } from "./vault-asks.ts";

// A valid heads-up id: 26 chars, Crockford base32 (no I, L, O, U).
const ID_A = "ABCDEFGH0123456789JKMNPQRS";
const ID_B = "TVWXYZ0123456789ABCDEFGHJK";
const ID_CONFLICT = "0123456789ABCDEFGHJKMNPQRS";

let repoCwd: string;

function headsUpsDir(): string {
  return join(repoCwd, ".calyx", "heads-ups");
}

function writeHeadsUp(fileName: string, frontmatter: Record<string, unknown>, message: string): void {
  const lines = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  writeFileSync(join(headsUpsDir(), fileName), `---\n${lines}\n---\n${message}\n`, "utf8");
}

beforeEach(() => {
  repoCwd = mkdtempSync(join(tmpdir(), "lfg-heads-ups-"));
  mkdirSync(headsUpsDir(), { recursive: true });
});

afterEach(() => {
  rmSync(repoCwd, { recursive: true, force: true });
});

describe("heads-ups in listCalyxAsks", () => {
  test("a new heads-up appears as a CalyxAsk with kind heads-up, unanswered", () => {
    writeHeadsUp(
      `${ID_A}.md`,
      { type: "heads-up", id: ID_A, title: "Deploy finished", from: "Ops Agent", status: "new", replies: [] },
      "The deploy finished. All green."
    );

    const asks = listCalyxAsks(repoCwd, "TestVault");
    expect(asks).toHaveLength(1);
    const [ask] = asks;
    expect(ask.kind).toBe("heads-up");
    expect(ask.id).toBe(`.calyx/heads-ups/${ID_A}.md`);
    expect(ask.path).toBe(ask.id);
    expect(ask.title).toBe("Deploy finished");
    expect(ask.reason).toBe("The deploy finished. All green.");
    expect(ask.questions).toEqual([]);
    expect(ask.agent).toBe("Ops Agent");
    expect(ask.answered).toBe(false);
    expect(ask.answer).toBeUndefined();
    expect(ask.repo).toBe("TestVault");
  });

  test("done and dismissed heads-ups are skipped entirely", () => {
    writeHeadsUp(`${ID_A}.md`, { type: "heads-up", id: ID_A, title: "Done one", from: "Agent", status: "done", replies: [] }, "msg");
    writeHeadsUp(`${ID_B}.md`, { type: "heads-up", id: ID_B, title: "Dismissed one", from: "Agent", status: "dismissed", replies: [] }, "msg");

    expect(listCalyxAsks(repoCwd, "TestVault")).toHaveLength(0);
  });

  test("a file that isn't a heads-up (wrong type, or a bad id) is skipped, not thrown", () => {
    writeHeadsUp("not-a-headsup.md", { type: "note", id: ID_A, title: "x", from: "y", status: "new", replies: [] }, "msg");
    writeHeadsUp("bad-id.md", { type: "heads-up", id: "too-short", title: "x", from: "y", status: "new", replies: [] }, "msg");

    expect(() => listCalyxAsks(repoCwd, "TestVault")).not.toThrow();
    expect(listCalyxAsks(repoCwd, "TestVault")).toHaveLength(0);
  });

  test("no heads-ups folder at all → empty, not an error", () => {
    rmSync(headsUpsDir(), { recursive: true, force: true });
    expect(listCalyxAsks(repoCwd, "TestVault")).toEqual([]);
  });
});

describe("answering a heads-up", () => {
  test("appends to replies[], flips status new→replied, and touches nothing else", async () => {
    writeHeadsUp(
      `${ID_A}.md`,
      { type: "heads-up", id: ID_A, title: "Deploy finished", from: "Ops Agent", status: "new", replies: [] },
      "The deploy finished. All green."
    );
    const relPath = `.calyx/heads-ups/${ID_A}.md`;

    const result = await answerCalyxAsk(repoCwd, relPath, "Nice, thanks!");
    expect(result).toEqual({ path: relPath, answered: "Nice, thanks!" });

    const raw = readFileSync(join(repoCwd, relPath), "utf8");
    const { properties, content } = parseFrontmatter(raw);
    // Every key the answer didn't touch survives byte-for-byte in meaning.
    expect(properties.title).toBe("Deploy finished");
    expect(properties.from).toBe("Ops Agent");
    expect(properties.status).toBe("replied");
    expect(content.trim()).toBe("The deploy finished. All green.");
    expect(raw).toContain("Nice, thanks!");

    const [ask] = listCalyxAsks(repoCwd, "TestVault");
    expect(ask.answered).toBe(true);
    expect(ask.answer).toBe("Nice, thanks!");
  });

  test("an empty answer is rejected without writing anything", async () => {
    writeHeadsUp(`${ID_A}.md`, { type: "heads-up", id: ID_A, title: "x", from: "y", status: "new", replies: [] }, "msg");
    const relPath = `.calyx/heads-ups/${ID_A}.md`;
    const before = readFileSync(join(repoCwd, relPath), "utf8");

    await expect(answerCalyxAsk(repoCwd, relPath, "   ")).rejects.toThrow();

    expect(readFileSync(join(repoCwd, relPath), "utf8")).toBe(before);
  });

  test("a second reply appends rather than replacing the first, and status stays replied", async () => {
    writeHeadsUp(`${ID_A}.md`, { type: "heads-up", id: ID_A, title: "x", from: "y", status: "new", replies: [] }, "msg");
    const relPath = `.calyx/heads-ups/${ID_A}.md`;

    await answerCalyxAsk(repoCwd, relPath, "First reply");
    await answerCalyxAsk(repoCwd, relPath, "Second reply");

    const raw = readFileSync(join(repoCwd, relPath), "utf8");
    expect(raw).toContain("First reply");
    expect(raw).toContain("Second reply");
    expect((raw.match(/status: replied/g) ?? []).length).toBe(1);

    const [ask] = listCalyxAsks(repoCwd, "TestVault");
    expect(ask.answer).toBe("Second reply");
  });
});

// `watchCalyxAsks` in src/commands/serve.ts is module-private and touches
// global state (the on-disk seen-set, push notifications), so it isn't unit
// tested directly. What matters for a heads-up is that its seen/fresh logic
// — `if (a.answered) continue`, keyed on `a.id` — generalizes to heads-ups
// without any change, because listCalyxAsks now gives a heads-up the same
// `answered`/`id` shape a task ask has. This reproduces that logic against a
// real temp vault to confirm it: a new heads-up counts as fresh exactly once,
// and a replied one never counts as fresh again.
function freshCount(asks: ReturnType<typeof listCalyxAsks>, seen: Set<string>, repoName: string): number {
  const live = new Set(asks.map((a) => `${repoName}:${a.id}`));
  let fresh = 0;
  for (const a of asks) {
    if (a.answered) continue;
    const key = `${repoName}:${a.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fresh++;
  }
  for (const key of [...seen]) {
    if (key.startsWith(`${repoName}:`) && !live.has(key)) seen.delete(key);
  }
  return fresh;
}

describe("watcher push semantics generalize to heads-ups", () => {
  test("a new heads-up is fresh once; ticking again without change pushes nothing", () => {
    writeHeadsUp(`${ID_A}.md`, { type: "heads-up", id: ID_A, title: "x", from: "Agent", status: "new", replies: [] }, "msg");
    const seen = new Set<string>();

    expect(freshCount(listCalyxAsks(repoCwd, "TestVault"), seen, "TestVault")).toBe(1);
    expect(freshCount(listCalyxAsks(repoCwd, "TestVault"), seen, "TestVault")).toBe(0);
  });

  test("replying makes it answered, and it never counts as fresh again", async () => {
    writeHeadsUp(`${ID_A}.md`, { type: "heads-up", id: ID_A, title: "x", from: "Agent", status: "new", replies: [] }, "msg");
    const seen = new Set<string>();
    freshCount(listCalyxAsks(repoCwd, "TestVault"), seen, "TestVault"); // first tick: seen it

    await answerCalyxAsk(repoCwd, `.calyx/heads-ups/${ID_A}.md`, "Got it");

    expect(freshCount(listCalyxAsks(repoCwd, "TestVault"), seen, "TestVault")).toBe(0);
  });
});

describe("sync conflict copies reconcile to one item", () => {
  test("the non-copy path is the primary, replies union, furthest-along status wins", async () => {
    // The primary file: still new, no reply yet.
    writeHeadsUp(
      `${ID_CONFLICT}.md`,
      { type: "heads-up", id: ID_CONFLICT, title: "Ship it?", from: "Agent", status: "new", replies: [] },
      "Should I ship the change?"
    );
    // A conflict copy landed with a reply already on it (a reply written to
    // the copy the sync engine happened to keep on this device).
    writeHeadsUp(
      `${ID_CONFLICT} (conflict macbook 1a2b3c4d).md`,
      {
        type: "heads-up",
        id: ID_CONFLICT,
        title: "Ship it?",
        from: "Agent",
        status: "replied",
        replies: [{ id: "REPLY0000000000000000001", at: "2026-09-15T00:00:00.000Z", text: "Yes, ship it" }],
      },
      "Should I ship the change?"
    );

    const asks = listCalyxAsks(repoCwd, "TestVault");
    expect(asks).toHaveLength(1);
    const [ask] = asks;
    expect(ask.path).toBe(`.calyx/heads-ups/${ID_CONFLICT}.md`); // non-copy path wins
    expect(ask.answered).toBe(true); // furthest-along status (replied) wins
    expect(ask.answer).toBe("Yes, ship it"); // the copy's reply is not lost
  });
});
