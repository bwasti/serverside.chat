import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore } from "../src/auth";
import { Room } from "../src/room";
import { parseArguments, RoomCapabilitySession } from "../src/room-shell";
import { RoomWorkspace } from "../src/workspace";

function setup() {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-shell-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const owner = accounts.ensureLocalOwner("alice", "Alice Example");
  const viewer = accounts.ensureLocalOwner("bob");
  accounts.ensureRoom("mine", owner, { visibility: "public", contributions: "members", agentMode: "passive" });
  const workspace = new RoomWorkspace(data, "mine");
  const room = new Room("mine", 250, "https://serverside.chat/mine", owner.handle, undefined, accounts);
  return { accounts, owner, viewer, workspace, room };
}

test("capability shell exposes bounded files and Git operations without command execution", () => {
  const { accounts, owner, workspace, room } = setup();
  const shell = new RoomCapabilitySession(owner, room, workspace, accounts);

  expect(shell.execute("files").output).toContain("worker.js");
  expect(shell.execute("cat README.md").output).toContain("# mine");
  expect(() => shell.execute("sh -c whoami")).toThrow("unknown command");
  expect(() => shell.execute("cat .git/config")).toThrow("invalid repository path");

  const revision = workspace.fileRevision("README.md");
  expect(shell.saveText("README.md", "# edited\n", revision).toString()).toContain("wrote README.md");
  const commit = shell.execute('commit "Edit the readme"').output!;
  expect(commit).toContain("Edit the readme");
  expect(room.messages.at(-1)).toMatchObject({ kind: "commit", author: "alice" });
  accounts.close();
});

test("read-only accounts cannot mutate room source or versions", () => {
  const { accounts, viewer, workspace, room } = setup();
  const shell = new RoomCapabilitySession(viewer, room, workspace, accounts);
  expect(shell.execute("cat README.md").output).toContain("# mine");
  expect(() => shell.execute("write README.md")).toThrow("read-only");
  expect(() => shell.execute("commit nope")).toThrow("read-only");
  accounts.close();
});

test("optimistic file revisions reject an overwrite after concurrent editing", () => {
  const { accounts, owner, workspace, room } = setup();
  const shell = new RoomCapabilitySession(owner, room, workspace, accounts);
  const stale = workspace.fileRevision("worker.js");
  workspace.writeFile("worker.js", "newer\n");
  expect(() => shell.saveText("worker.js", "stale\n", stale)).toThrow("changed since it was opened");
  expect(workspace.readFile("worker.js")).toBe("newer\n");
  accounts.close();
});

test("argument parsing supports quoted paths but never expands shell syntax", () => {
  expect(parseArguments(`'old name.txt' "new name.txt"`)).toEqual(["old name.txt", "new name.txt"]);
  expect(parseArguments("$(whoami) ; touch nope")).toEqual(["$(whoami)", ";", "touch", "nope"]);
  expect(() => parseArguments("'unfinished")).toThrow("unfinished quote");
});
