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

test("account preparation keeps the personal room but makes lobby usable", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-directory-lobby-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const owner = accounts.ensureLocalOwner("alice");
  const member = accounts.ensureLocalOwner("bob");
  accounts.ensureSystemRoom("lobby", owner, { visibility: "public", contributions: "members", agentMode: "passive" });
  const directory = new RoomDirectory(accounts, data, "https://example.test");

  expect(directory.prepareAccount(member)?.name).toBe("bob");
  expect(accounts.roleFor(member, "lobby")).toBe("contributor");
  expect(accounts.ownedRoomNames(member)).toEqual(["bob"]);
  expect(directory.rooms.map((room) => room.name).slice(0, 2)).toEqual(["lobby", "bob"]);
  accounts.close();
});

test("normal rooms use isolated site origins while system rooms stay on the control plane", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-directory-origins-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const owner = accounts.ensureLocalOwner("alice");
  accounts.ensureSystemRoom("lobby", owner, { visibility: "public", contributions: "members", agentMode: "passive" });
  accounts.ensureRoom("hello-world", owner, { visibility: "public", contributions: "members", agentMode: "passive" });
  const directory = new RoomDirectory(accounts, data, "https://serverside.chat", undefined, "serverside.chat");

  expect(directory.room("hello-world")?.pageUrl).toBe("https://hello-world.serverside.chat");
  expect(directory.room("lobby")?.pageUrl).toBe("https://serverside.chat/room/lobby");
  expect(directory.chatUrl("hello-world")).toBe("https://serverside.chat/room/hello-world");
  expect(directory.roomNameForSiteHostname("HELLO-WORLD.serverside.chat.")).toBe("hello-world");
  expect(directory.roomNameForSiteHostname("missing.serverside.chat")).toBeUndefined();
  expect(directory.roomNameForSiteHostname("lobby.serverside.chat")).toBeUndefined();
  accounts.close();
});
