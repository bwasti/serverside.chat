import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore } from "../src/auth";
import { RoomDirectory } from "../src/room-directory";

test("accounts can create a persistent room that owners can rename, archive, and restore", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-directory-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const owner = accounts.ensureLocalOwner("alice");
  accounts.ensureRoom("lobby", owner, { visibility: "public", contributions: "members", clankerMode: "passive" });
  const member = accounts.createDevelopmentAccount("bob").principal;
  const collaborator = accounts.createDevelopmentAccount("charlie").principal;
  const directory = new RoomDirectory(accounts, data, "https://example.test");

  const starter = directory.createRoom(member, "bob");
  expect(starter.name).toBe("bob");
  expect(starter.pageUrl).toBe("https://example.test/bob");
  expect(accounts.roleFor(member, "bob")).toBe("owner");
  expect(existsSync(join(data, "rooms", "bob", "repo", ".git"))).toBe(true);
  expect(starter.sourceBytes).toBeGreaterThan(0);
  expect(starter.filesystemBytes).toBe(starter.sourceBytes);
  const beforeSourceBytes = starter.sourceBytes;
  directory.workspaces.get("bob")!.writeFile("extra.txt", "count me");
  expect(starter.sourceBytes).toBe(beforeSourceBytes + Buffer.byteLength("count me"));
  expect(starter.filesystemBytes).toBe(starter.sourceBytes);
  starter.chat(member, "persistent before rename");

  const renamed = directory.renameRoom(member, "bob", "bob-site");
  expect(directory.room("bob")).toBeUndefined();
  expect(renamed.messages.at(-1)?.text).toBe("persistent before rename");
  expect(accounts.roleFor(member, "bob-site")).toBe("owner");
  expect(existsSync(join(data, "rooms", "bob-site", "repo", ".git"))).toBe(true);
  accounts.redeemInvite(collaborator, accounts.createInvite(member, "bob-site", "admin"));
  renamed.updatePolicy(member, { visibility: "private", clankerMode: "explicit" });

  directory.deleteRoom(member, "bob-site");
  expect(directory.room("bob-site")).toBeUndefined();
  expect(accounts.roomPolicy("bob-site")).toBeUndefined();
  expect(existsSync(join(data, "rooms", "bob-site"))).toBe(false);
  expect(readdirSync(join(data, ".trash", "rooms")).some((name) => name.endsWith("-bob-site"))).toBe(true);
  expect(accounts.archivedRooms(member)[0]).toMatchObject({ name: "bob-site", ownerId: member.id, visibility: "private", clankerMode: "explicit" });
  expect(accounts.archivedRooms(collaborator)).toEqual([]);

  const restored = directory.restoreRoom(member, "bob-site");
  expect(restored.messages.at(-1)?.text).toBe("persistent before rename");
  expect(restored.policy).toMatchObject({ visibility: "private", clankerMode: "explicit" });
  expect(accounts.roleFor(member, "bob-site")).toBe("owner");
  expect(accounts.roleFor(collaborator, "bob-site")).toBe("admin");
  expect(accounts.archivedRooms(member)).toEqual([]);
  expect(existsSync(join(data, "rooms", "bob-site", "repo", ".git"))).toBe(true);
  accounts.close();
});

test("account preparation grants lobby access without creating a room", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-directory-lobby-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const owner = accounts.ensureLocalOwner("alice");
  const member = accounts.ensureLocalOwner("bob");
  accounts.ensureSystemRoom("lobby", owner, { visibility: "public", contributions: "members", clankerMode: "passive" });
  const directory = new RoomDirectory(accounts, data, "https://example.test");

  expect(directory.prepareAccount(member)).toBeUndefined();
  expect(accounts.roleFor(member, "lobby")).toBe("contributor");
  expect(accounts.ownedRoomNames(member)).toEqual([]);
  expect(directory.rooms.map((room) => room.name)).toEqual(["lobby"]);
  accounts.close();
});

test("normal rooms use isolated site origins while system rooms stay on the control plane", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-directory-origins-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const owner = accounts.ensureLocalOwner("alice");
  accounts.ensureSystemRoom("lobby", owner, { visibility: "public", contributions: "members", clankerMode: "passive" });
  accounts.ensureRoom("hello-world", owner, { visibility: "public", contributions: "members", clankerMode: "passive" });
  const directory = new RoomDirectory(accounts, data, "https://serverside.chat", undefined, "serverside.chat");

  expect(directory.room("hello-world")?.pageUrl).toBe("https://hello-world.serverside.chat");
  expect(directory.room("lobby")?.pageUrl).toBe("https://serverside.chat/room/lobby");
  expect(directory.chatUrl("hello-world")).toBe("https://serverside.chat/room/hello-world");
  expect(directory.roomNameForSiteHostname("HELLO-WORLD.serverside.chat.")).toBe("hello-world");
  expect(directory.roomNameForSiteHostname("missing.serverside.chat")).toBeUndefined();
  expect(directory.roomNameForSiteHostname("lobby.serverside.chat")).toBeUndefined();
  accounts.close();
});

test("free accounts cannot turn room archives into unbounded storage", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-directory-archive-limit-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const owner = accounts.ensureLocalOwner("alice");
  const directory = new RoomDirectory(accounts, data, "https://example.test");

  for (let index = 0; index < 10; index += 1) {
    directory.createRoom(owner, "project");
    directory.deleteRoom(owner, "project");
  }
  expect(accounts.archivedRooms(owner)).toHaveLength(10);
  directory.createRoom(owner, "project");
  expect(() => directory.deleteRoom(owner, "project")).toThrow("archive limit reached");
  expect(directory.room("project")).toBeDefined();
  expect(existsSync(join(data, "rooms", "project", "repo", ".git"))).toBe(true);
  accounts.close();
});
