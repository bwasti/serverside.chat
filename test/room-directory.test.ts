import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore } from "../src/auth";
import { RoomDirectory } from "../src/room-directory";

test("accounts receive a persistent starter room that owners can rename and recoverably delete", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-directory-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const owner = accounts.ensureLocalOwner("alice");
  accounts.ensureRoom("lobby", owner, { visibility: "public", contributions: "members", agentMode: "passive" });
  const member = accounts.createDevelopmentAccount("bob").principal;
  const directory = new RoomDirectory(accounts, data, "https://example.test");

  const starter = directory.ensureStarterRoom(member)!;
  expect(starter.name).toBe("bob");
  expect(starter.pageUrl).toBe("https://example.test/bob");
  expect(accounts.roleFor(member, "bob")).toBe("owner");
  expect(existsSync(join(data, "rooms", "bob", "repo", ".git"))).toBe(true);
  starter.chat(member, "persistent before rename");

  const renamed = directory.renameRoom(member, "bob", "bob-site");
  expect(directory.room("bob")).toBeUndefined();
  expect(renamed.messages.at(-1)?.text).toBe("persistent before rename");
  expect(accounts.roleFor(member, "bob-site")).toBe("owner");
  expect(existsSync(join(data, "rooms", "bob-site", "repo", ".git"))).toBe(true);

  directory.deleteRoom(member, "bob-site");
  expect(directory.room("bob-site")).toBeUndefined();
  expect(accounts.roomPolicy("bob-site")).toBeUndefined();
  expect(existsSync(join(data, "rooms", "bob-site"))).toBe(false);
  expect(readdirSync(join(data, ".trash", "rooms")).some((name) => name.endsWith("-bob-site"))).toBe(true);
  accounts.close();
});
