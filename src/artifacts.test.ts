import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATHS } from "./config.ts";
import {
  collapseArtifactRetryMessages,
  createFileArtifact,
  createImageArtifact,
  deleteArtifact,
  getImageArtifact,
  imageArtifactToMessage,
  publishHtmlArtifact,
  updateHtmlArtifactRefresh,
  type ArtifactRefreshConfig,
} from "./artifacts.ts";

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";

function refreshConfig(scopeRoot: string): ArtifactRefreshConfig {
  return {
    scriptPath: join(scopeRoot, "refresh.sh"),
    argv: [],
    scopeRoot,
    intervalMs: 10_000,
    timeoutMs: 2_000,
    enabled: true,
    configuredAt: 1,
    status: "idle",
  };
}

describe("artifact display retry reconciliation", () => {
  test("collapses an identical media retry while preserving transcript order", () => {
    const messages = [
      { id: "text-1", kind: "text", ts: 1, text: "before" },
      { id: "artifact-a", kind: "image", ts: 10_000, name: "shot.png", mimeType: "image/png", size: 42, caption: "Live" },
      { id: "artifact-b", kind: "image", ts: 30_000, name: "shot.png", mimeType: "image/png", size: 42, caption: "Live" },
      { id: "text-2", kind: "text", ts: 40_000, text: "after" },
    ];

    expect(collapseArtifactRetryMessages(messages).map((message) => message.id)).toEqual([
      "text-1",
      "artifact-a",
      "text-2",
    ]);
  });

  test("keeps a deliberate later display and distinct media", () => {
    const base = { kind: "image", name: "shot.png", mimeType: "image/png", size: 42, caption: "Live" };
    const messages = [
      { ...base, id: "artifact-a", ts: 10_000 },
      { ...base, id: "artifact-b", ts: 400_001 },
      { ...base, id: "artifact-c", ts: 410_000, size: 43 },
    ];

    expect(collapseArtifactRetryMessages(messages).map((message) => message.id)).toEqual([
      "artifact-a",
      "artifact-b",
      "artifact-c",
    ]);
  });
});

describe("stable HTML artifact ownership", () => {
  const originalData = PATHS.data;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lfg-artifact-ownership-"));
    PATHS.data = join(root, "data");
  });

  afterEach(() => {
    PATHS.data = originalData;
    rmSync(root, { recursive: true, force: true });
  });

  test("a new session takes over an HTML id without breaking its version chain", () => {
    const originalRefresh = refreshConfig(join(root, "session-a"));
    const before = publishHtmlArtifact({
      sessionId: SESSION_A,
      id: "shared-dash",
      html: "<!doctype html><html><body>session A</body></html>",
      refresh: originalRefresh,
    });

    const after = publishHtmlArtifact({
      sessionId: SESSION_B,
      id: "shared-dash",
      html: "<!doctype html><html><body>session B</body></html>",
    });

    expect(after.sessionId).toBe(SESSION_B);
    expect(after.version).toBe(2);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.filePath).toBe(before.filePath);
    expect(after.refresh).toEqual(originalRefresh);
    expect(readFileSync(after.filePath, "utf8")).toContain("session B");

    const reboundRefresh = refreshConfig(join(root, "session-b"));
    expect(() => updateHtmlArtifactRefresh({
      id: after.id,
      sessionId: SESSION_A,
      refresh: reboundRefresh,
    })).toThrow("different session");
    expect(() => deleteArtifact({ id: after.id, sessionId: SESSION_A })).toThrow("different session");

    expect(updateHtmlArtifactRefresh({
      id: after.id,
      sessionId: SESSION_B,
      refresh: reboundRefresh,
    }).refresh).toEqual(reboundRefresh);
    expect(deleteArtifact({ id: after.id, sessionId: SESSION_B }).id).toBe(after.id);
    expect(getImageArtifact(after.id)).toBeNull();
  });

  test("an HTML publish cannot take over an image artifact id", () => {
    const source = join(root, "image.png");
    writeFileSync(source, "not-a-real-png");
    const image = createImageArtifact({ sessionId: SESSION_A, path: source });

    expect(() => publishHtmlArtifact({
      sessionId: SESSION_B,
      id: image.id,
      html: "<!doctype html><html><body>collision</body></html>",
    })).toThrow("different media kind");
    expect(getImageArtifact(image.id)?.media).toBe("image");
  });
});

describe("file artifacts", () => {
  const originalData = PATHS.data;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lfg-artifact-file-"));
    PATHS.data = join(root, "data");
  });

  afterEach(() => {
    PATHS.data = originalData;
    rmSync(root, { recursive: true, force: true });
  });

  test("accepts any extension and copies the bytes with a known mime", () => {
    const source = join(root, "report.pdf");
    writeFileSync(source, "%PDF-1.4 fake");
    const artifact = createFileArtifact({ sessionId: SESSION_A, path: source, caption: "Q3" });

    expect(artifact.media).toBe("file");
    expect(artifact.mimeType).toBe("application/pdf");
    expect(artifact.name).toBe("report.pdf");
    expect(readFileSync(artifact.filePath, "utf8")).toBe("%PDF-1.4 fake");
    expect(getImageArtifact(artifact.id)?.media).toBe("file");
  });

  test("falls back to octet-stream for an unknown extension (never rejected)", () => {
    const source = join(root, "data.bin");
    writeFileSync(source, "raw-bytes");
    const artifact = createFileArtifact({ sessionId: SESSION_A, path: source });
    expect(artifact.mimeType).toBe("application/octet-stream");
  });

  test("the transcript message carries a file kind and download url", () => {
    const source = join(root, "server.log");
    writeFileSync(source, "line one");
    const artifact = createFileArtifact({ sessionId: SESSION_A, path: source });
    const message = imageArtifactToMessage(artifact);
    expect(message.kind).toBe("file");
    expect(message.url).toBe(`/api/artifacts/${artifact.id}`);
    expect(message.name).toBe("server.log");
  });

  test("rejects a relative path and an empty file", () => {
    expect(() => createFileArtifact({ sessionId: SESSION_A, path: "report.pdf" })).toThrow(
      "absolute",
    );
    const empty = join(root, "empty.txt");
    writeFileSync(empty, "");
    expect(() => createFileArtifact({ sessionId: SESSION_A, path: empty })).toThrow("empty");
  });
});
