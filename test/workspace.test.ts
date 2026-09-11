import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomWorkspace } from "../src/workspace";

test("previews are immutable and promotion is explicit", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-test-"));
  const workspace = new RoomWorkspace(data, "test-room");
  const original = workspace.readPublished("index.html");

  workspace.writeFile("index.html", "<h1>preview</h1>");
  workspace.commit("preview page");
  const preview = workspace.createPreview("test change");

  expect(workspace.readPublished("index.html")).toBe(original);
  expect(workspace.readPublished("index.html", "stable")).toBe(original);
  expect(workspace.readPublished("index.html", "head")).toBe("<h1>preview</h1>");
  expect(workspace.deploymentStatus().activeIsHead).toBe(false);
  expect(workspace.readPublished("index.html", preview.id)).toBe("<h1>preview</h1>");
  workspace.promotePreview(preview.id);
  expect(workspace.deploymentStatus().activeIsHead).toBe(true);
  expect(workspace.readPublished("index.html")).toBe("<h1>preview</h1>");
  expect(workspace.visiblePreviews()).toEqual([]);
});

test("repository paths cannot escape or inspect git internals", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-test-"));
  const workspace = new RoomWorkspace(data, "test-room");
  expect(() => workspace.readFile("../../etc/passwd")).toThrow("escapes repository");
  expect(() => workspace.readFile(".git/config")).toThrow("invalid repository path");
  expect(() => workspace.readFile(".GIT/config")).toThrow("invalid repository path");
  expect(workspace.readPublishedAsset("missing.txt")).toBeUndefined();
  expect(workspace.readPublishedAsset(".git/config")).toBeUndefined();
  expect(workspace.readPublishedAsset("index.html")).toContain("Hello world");
});

test("binary capability writes are atomic, quota-bounded, and optimistic", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-test-"));
  const workspace = new RoomWorkspace(data, "binary-room");
  const created = workspace.writeFileBytes("assets/icon.bin", Buffer.from([0, 1, 2]), null);
  expect(workspace.readFileBytes("assets/icon.bin")).toEqual(Buffer.from([0, 1, 2]));
  expect(() => workspace.writeFileBytes("assets/icon.bin", Buffer.from([3]), null)).toThrow("changed since it was opened");
  expect(workspace.writeFileBytes("assets/icon.bin", Buffer.from([3]), created.revision).bytes).toBe(1);
  expect(() => workspace.writeFileBytes("large.bin", Buffer.alloc(512 * 1024 + 1))).toThrow("512 KiB");
});

test("agent patches are unique and tracked files can be safely restored from HEAD", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-patch-"));
  const workspace = new RoomWorkspace(data, "patch-room");
  const original = workspace.readFile("index.html");
  expect(workspace.patchFile("index.html", "Hello world", "Hello patch")).toMatchObject({ replaced: true, path: "index.html" });
  expect(workspace.readFile("index.html")).toContain("Hello patch");
  expect(() => workspace.patchFile("index.html", "missing text", "nope")).toThrow("was not found");
  workspace.writeFile("duplicate.txt", "same same");
  expect(() => workspace.patchFile("duplicate.txt", "same", "different")).toThrow("not unique");
  expect(workspace.restoreFile("index.html")).toMatchObject({ path: "index.html", restoredFrom: "HEAD" });
  expect(workspace.readFile("index.html")).toBe(original);
  expect(() => workspace.restoreFile("duplicate.txt")).toThrow("not tracked in HEAD");
  expect(() => workspace.restoreFile(".git/config")).toThrow("invalid repository path");
});

test("version graph exposes concise commit stacks and refs", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-test-"));
  const workspace = new RoomWorkspace(data, "graph-room");
  workspace.createBranch("feature");
  workspace.writeFile("feature.txt", "stacked\n");
  const commit = workspace.commit("stacked work");
  const graph = workspace.versionGraph();
  expect(graph.some((line) => line.includes(commit.commit) && line.includes("head"))).toBe(true);
  expect(graph.every((line) => line.length <= 120)).toBe(true);
});

test("archiving hides a preview without deleting its commit", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-test-"));
  const workspace = new RoomWorkspace(data, "archive-room");
  workspace.writeFile("index.html", "<h1>temporary</h1>");
  const commit = workspace.commit("temporary page");
  const preview = workspace.createPreview("temporary variant");

  expect(workspace.visiblePreviews().map((item) => item.id)).toContain(preview.id);
  expect(workspace.archivePreview(preview.id)).toEqual({ id: preview.id, commit: commit.commit, archived: true });
  expect(workspace.visiblePreviews()).toEqual([]);
  expect(workspace.readPublished("index.html", preview.id)).toBe("<h1>temporary</h1>");
  expect(workspace.readPublished("index.html", commit.commit)).toBe("<h1>temporary</h1>");
});

test("stable promotion requires rebased linear history", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-test-"));
  const workspace = new RoomWorkspace(data, "linear-room");
  workspace.createBranch("feature");
  workspace.writeFile("feature.txt", "feature\n");
  const featureCommit = workspace.commit("feature work");
  expect(workspace.readPublished("feature.txt", featureCommit.commit)).toBe("feature\n");
  const stalePreview = workspace.createPreview("feature before stable moved");

  workspace.switchBranch("main");
  workspace.writeFile("main.txt", "main\n");
  workspace.commit("advance stable");
  const stablePreview = workspace.createPreview("advance stable");
  workspace.promotePreview(stablePreview.id);

  workspace.switchBranch("feature");
  expect(() => workspace.promotePreview(stalePreview.id)).toThrow("fast-forward");
  workspace.rebaseOntoStable();
  const rebasedPreview = workspace.createPreview("rebased feature");
  expect(workspace.visiblePreviews().some((preview) => preview.id === stalePreview.id)).toBe(false);
  expect(workspace.promotePreview(rebasedPreview.id).commit).toBe(rebasedPreview.commit);
});

test("agent can resolve a conflicted rebase and preserve linear history", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-test-"));
  const workspace = new RoomWorkspace(data, "conflict-room");
  workspace.createBranch("feature");
  workspace.writeFile("index.html", "feature\n");
  workspace.commit("feature version");

  workspace.switchBranch("main");
  workspace.writeFile("index.html", "stable\n");
  workspace.commit("stable version");
  const stablePreview = workspace.createPreview("stable version");
  workspace.promotePreview(stablePreview.id);

  workspace.switchBranch("feature");
  const conflict = workspace.rebaseOntoStable();
  expect(conflict.completed).toBe(false);
  expect(workspace.readFile("index.html")).toContain("<<<<<<<");
  workspace.writeFile("index.html", "resolved\n");
  expect(workspace.continueRebase().completed).toBe(true);
  const resolved = workspace.createPreview("resolved conflict");
  expect(workspace.promotePreview(resolved.id).commit).toBe(resolved.commit);
});
