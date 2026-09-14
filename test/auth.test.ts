import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { AccountStore, anonymousPrincipal, sshFingerprint } from "../src/auth";
import { Room } from "../src/room";

function setup() {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-auth-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const owner = accounts.ensureLocalOwner("alice");
  const member = accounts.ensureLocalOwner("bob");
  accounts.ensureRoom("public-room", owner, { visibility: "public", contributions: "members", clankerMode: "passive" });
  accounts.ensureRoom("private-room", owner, { visibility: "private", contributions: "admins", clankerMode: "disabled" });
  return { accounts, owner, member };
}

test("legacy account databases gain site-role and plan defaults", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-auth-migrate-"));
  const path = join(data, "accounts.sqlite");
  const legacy = new Database(path);
  legacy.exec(`CREATE TABLE users (
    id TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL
  );
  CREATE TABLE rooms (
    name TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL REFERENCES users(id),
    visibility TEXT NOT NULL, contribution_policy TEXT NOT NULL,
    agent_mode TEXT NOT NULL, created_at INTEGER NOT NULL
  )`);
  legacy.close();

  const accounts = new AccountStore(path);
  const migrated = new Database(path, { readonly: true });
  const roomColumns = (migrated.query("PRAGMA table_info(rooms)").all() as Array<{ name: string }>).map(({ name }) => name);
  expect(roomColumns).toContain("clanker_mode");
  expect(roomColumns).not.toContain("agent_mode");
  migrated.close();
  const principal = accounts.ensureLocalOwner("legacy");
  expect(accounts.accountProfile(principal)).toMatchObject({ siteRole: "member", plan: "free", roomLimit: 5 });
  expect(accounts.ensureRoom("legacy-room", principal, { visibility: "public", contributions: "members", clankerMode: "passive" }).system).toBe(false);
  accounts.close();
});

test("the lobby is a reserved quota-free room that signed-in accounts can use", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-auth-lobby-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const owner = accounts.ensureLocalOwner("alice");
  const member = accounts.ensureLocalOwner("bob");
  accounts.ensureSystemRoom("lobby", owner, { visibility: "public", contributions: "members", clankerMode: "passive" });

  accounts.ensureSystemMembership(member, "lobby");
  expect(accounts.roomPolicy("lobby")).toMatchObject({ system: true, visibility: "public", clankerMode: "passive" });
  expect(accounts.roleFor(member, "lobby")).toBe("contributor");
  expect(accounts.canContribute(member, "lobby")).toBe(true);
  expect(accounts.canEditSource(member, "lobby")).toBe(false);
  expect(accounts.accountProfile(owner).ownedRooms).toBe(0);
  expect(accounts.ownedRoomNames(owner)).toEqual([]);
  expect(() => accounts.renameRoom(owner, "lobby", "welcome")).toThrow("system rooms cannot be renamed");
  expect(() => accounts.deleteRoom(owner, "lobby")).toThrow("system rooms cannot be deleted");
  expect(() => accounts.updateRoomPolicy(owner, "lobby", { visibility: "private" })).toThrow("host-managed");
  accounts.close();
});

test("room owners prove custom-domain control before the host routes traffic", () => {
  const { accounts, owner, member } = setup();
  const pending = accounts.addRoomDomain(owner, "public-room", "CarsILike.Site.", "serverside.chat");
  expect(pending).toMatchObject({ hostname: "carsilike.site", roomName: "public-room", status: "pending" });
  expect(pending.challengeName).toBe("_serverside-chat.carsilike.site");
  expect(pending.challengeValue).toStartWith("serverside-chat-verification=");
  expect(accounts.roomForCustomDomain("carsilike.site")).toBeUndefined();

  const active = accounts.verifyRoomDomain(owner, "public-room", "carsilike.site", [pending.challengeValue]);
  expect(active.status).toBe("active");
  expect(accounts.roomForCustomDomain("CARSILIKE.SITE.")).toBe("public-room");
  expect(() => accounts.addRoomDomain(member, "public-room", "unauthorized.example", "serverside.chat")).toThrow("room owner");
  expect(() => accounts.addRoomDomain(owner, "public-room", "public-room.serverside.chat", "serverside.chat")).toThrow("platform hostnames");
  expect(accounts.removeRoomDomain(owner, "public-room", "carsilike.site")).toBe(true);
  expect(accounts.roomForCustomDomain("carsilike.site")).toBeUndefined();
  accounts.close();
});

test("SSH keys resolve to accounts while unknown keys stay anonymous", () => {
  const { accounts, owner } = setup();
  const enrolled = Buffer.from("enrolled-public-key-blob");
  const unknown = Buffer.from("unknown-public-key-blob");
  accounts.enrollSshKey(owner.id, "ssh-ed25519", enrolled, "laptop");

  expect(accounts.principalForKey("ssh-ed25519", enrolled, "spoofed")).toMatchObject({ id: owner.id, handle: "alice", authenticated: true });
  expect(accounts.principalForKey("ssh-ed25519", unknown, "alice")).toMatchObject({ id: `anonymous:${sshFingerprint(unknown)}`, kind: "anonymous", authenticated: false });
  accounts.close();
});

test("provider identity creates the canonical account and web sessions are revocable credentials", () => {
  const { accounts } = setup();
  const first = accounts.authenticateIdentity({ provider: "google", subject: "google-user-123", handle: "charlie", email: "charlie@example.test" });
  const again = accounts.authenticateIdentity({ provider: "google", subject: "google-user-123", handle: "ignored" });
  expect(first.created).toBe(true);
  expect(again).toMatchObject({ created: false, principal: { id: first.principal.id, handle: "charlie" } });

  const session = accounts.createWebSession(first.principal, 60_000);
  expect(accounts.principalForWebSession(session.sessionToken)).toMatchObject({ id: first.principal.id, handle: "charlie", authenticated: true });
  accounts.revokeWebSession(session.sessionToken);
  expect(accounts.principalForWebSession(session.sessionToken)).toBeUndefined();
  accounts.close();
});

test("account settings expose linked credentials and allow a display-name update", () => {
  const { accounts } = setup();
  const account = accounts.authenticateIdentity({ provider: "github", subject: "settings-user", handle: "charlie", displayName: "Charlie" });
  accounts.enrollSshKey(account.principal.id, "ssh-ed25519", Buffer.from("settings-key"), "laptop");

  expect(accounts.accountSettings(account.principal)).toMatchObject({
    handle: "charlie",
    displayName: "Charlie",
    providers: ["github"],
    sshKeys: 1,
  });
  const updated = accounts.updateDisplayName(account.principal, "  Charlie   Example  ");
  expect(updated.displayName).toBe("Charlie Example");
  expect(accounts.accountSettings(updated).displayName).toBe("Charlie Example");
  expect(() => accounts.updateDisplayName(updated, "   ")).toThrow("display name is required");
  accounts.close();
});

test("room mount credentials resolve to canonical accounts and rotate independently", () => {
  const { accounts, owner } = setup();
  const first = accounts.createMountCredential(owner, "public-room", 60_000);
  expect(first).toMatchObject({ roomName: "public-room", readOnly: false });
  expect(accounts.principalForMountCredential(first.username, first.password, "public-room")).toMatchObject({ id: owner.id, handle: "alice" });
  expect(accounts.principalForMountCredential(first.username, first.password, "private-room")).toBeUndefined();

  const replacement = accounts.createMountCredential(owner, "public-room", 60_000);
  expect(accounts.principalForMountCredential(first.username, first.password, "public-room")).toBeUndefined();
  expect(accounts.principalForMountCredential(replacement.username, replacement.password, "public-room")).toMatchObject({ id: owner.id });
  expect(accounts.revokeMountCredentials(owner, "public-room")).toBe(1);
  expect(accounts.principalForMountCredential(replacement.username, replacement.password, "public-room")).toBeUndefined();
  accounts.close();
});

test("temporary development login creates a canonical account without making a credential out of its handle", () => {
  const { accounts } = setup();
  const first = accounts.createDevelopmentAccount("alice", "Another Alice");
  const second = accounts.createDevelopmentAccount("alice", "Third Alice");
  expect(first.principal).toMatchObject({ handle: "alice-1", displayName: "Another Alice", authenticated: true });
  expect(second.principal).toMatchObject({ handle: "alice-2", authenticated: true });
  expect(first.principal.id).not.toBe(second.principal.id);
  expect(accounts.principalForWebSession(first.session.sessionToken)).toMatchObject({ id: first.principal.id });
  accounts.close();
});

test("a canonical browser account can attach multiple verified SSH keys", () => {
  const { accounts } = setup();
  const account = accounts.createDevelopmentAccount("charlie");
  const firstKey = Buffer.from("first-collaborator-public-key");
  const secondKey = Buffer.from("second-collaborator-public-key");
  const firstGuest = accounts.principalForKey("ssh-ed25519", firstKey, "ignored");
  const secondGuest = accounts.principalForKey("ssh-ed25519", secondKey, "ignored");

  expect(() => accounts.redeem(firstGuest, "not-an-invite")).toThrow("create an account");
  const firstLink = accounts.createSshPairing(firstGuest, "203.0.113.10", 60_000);
  const secondLink = accounts.createSshPairing(secondGuest, "203.0.113.10", 60_000);
  accounts.linkSshPairing(account.principal, firstLink.code, "laptop");
  accounts.linkSshPairing(account.principal, secondLink.code, "desktop");

  expect(accounts.principalForKey("ssh-ed25519", firstKey)).toMatchObject({ id: account.principal.id, handle: "charlie" });
  expect(accounts.principalForKey("ssh-ed25519", secondKey)).toMatchObject({ id: account.principal.id, handle: "charlie" });
  expect(() => accounts.linkSshPairing(account.principal, firstLink.code)).toThrow("invalid or expired");
  accounts.close();
});

test("an existing bootstrap account can issue a one-use OAuth identity link", () => {
  const { accounts, owner } = setup();
  const link = accounts.createAccountLink(owner, 60_000);
  expect(accounts.consumeAccountLink(link.code)).toMatchObject({ id: owner.id, handle: "alice" });
  expect(() => accounts.consumeAccountLink(link.code)).toThrow("invalid or expired");
  expect(() => accounts.createAccountLink(anonymousPrincipal("SHA256:guest"))).toThrow("authenticated account");
  accounts.close();
});

test("an SSH invite is granted to the canonical account during browser key linking", () => {
  const { accounts, owner } = setup();
  const account = accounts.createDevelopmentAccount("charlie");
  const key = Buffer.from("invited-collaborator-public-key");
  const guest = accounts.principalForKey("ssh-ed25519", key, "ignored");
  const invite = accounts.createInvite(owner, "private-room", "contributor");
  const pairing = accounts.createSshPairing(guest, "203.0.113.10", 60_000, invite);

  expect(pairing.roomName).toBe("private-room");
  expect(accounts.linkSshPairing(account.principal, pairing.code)).toMatchObject({ roomName: "private-room", role: "contributor" });
  expect(accounts.canView(account.principal, "private-room")).toBe(true);
  expect(accounts.principalForKey("ssh-ed25519", key)).toMatchObject({ id: account.principal.id });
  accounts.close();
});

test("public visibility is independent from contribution and clanker authority", () => {
  const { accounts, owner, member } = setup();
  const guest = anonymousPrincipal("SHA256:guest", "alice");
  expect(accounts.canView(guest, "public-room")).toBe(true);
  expect(accounts.canContribute(guest, "public-room")).toBe(false);
  expect(accounts.canInvokeClanker(guest, "public-room")).toBe(false);
  expect(accounts.canView(member, "private-room")).toBe(false);

  const invite = accounts.createInvite(owner, "public-room", "contributor");
  expect(accounts.redeemInvite(member, invite)).toEqual({ roomName: "public-room", role: "contributor" });
  expect(accounts.canContribute(member, "public-room")).toBe(true);
  expect(accounts.canEditSource(member, "public-room")).toBe(true);
  expect(accounts.canInvokeClanker(member, "public-room")).toBe(true);
  expect(accounts.canPromote(member, "public-room")).toBe(false);
  expect(accounts.canPromote(owner, "public-room")).toBe(true);
  accounts.close();
});

test("authenticated contribution rooms admit signed-in non-members but never anonymous users", () => {
  const { accounts, owner, member } = setup();
  const guest = anonymousPrincipal("SHA256:open-room-guest");
  expect(accounts.roleFor(member, "public-room")).toBeUndefined();
  accounts.updateRoomPolicy(owner, "public-room", { contributions: "authenticated" });
  expect(accounts.roomPolicy("public-room")?.contributions).toBe("authenticated");
  expect(accounts.canContribute(member, "public-room")).toBe(true);
  expect(accounts.canEditSource(member, "public-room")).toBe(true);
  expect(accounts.canInvokeClanker(member, "public-room")).toBe(true);
  expect(accounts.canContribute(guest, "public-room")).toBe(false);

  accounts.updateRoomPolicy(owner, "private-room", { contributions: "authenticated" });
  expect(accounts.canView(member, "private-room")).toBe(false);
  expect(accounts.canContribute(member, "private-room")).toBe(false);
  accounts.close();
});

test("site admins and free account room limits are distinct from room roles", () => {
  const { accounts, owner, member } = setup();
  expect(accounts.accountProfile(owner)).toMatchObject({ siteRole: "member", plan: "free", ownedRooms: 2, roomLimit: 5 });
  accounts.ensureSiteAdmin(owner);
  expect(accounts.accountProfile(owner)).toMatchObject({ siteRole: "admin", plan: "free", roomLimit: 100 });

  for (let index = 1; index <= 5; index++) accounts.createRoom(member, `bob-${index}`);
  expect(accounts.accountProfile(member)).toMatchObject({ siteRole: "member", plan: "free", ownedRooms: 5, roomLimit: 5 });
  expect(() => accounts.createRoom(member, "bob-6")).toThrow("at most 5 rooms");
  expect(() => accounts.renameRoom(member, "public-room", "stolen-room")).toThrow("owner or a site admin");

  accounts.renameRoom(owner, "bob-1", "admin-renamed");
  expect(accounts.roomPolicy("admin-renamed")?.ownerId).toBe(member.id);
  accounts.deleteRoom(owner, "admin-renamed");
  expect(accounts.roomPolicy("admin-renamed")).toBeUndefined();
  accounts.close();
});

test("site admins can see and contribute to every room and exclusively manage room limits", () => {
  const { accounts, owner, member } = setup();
  accounts.ensureSiteAdmin(member);
  expect(accounts.roleFor(member, "private-room")).toBeUndefined();
  expect(accounts.canView(member, "private-room")).toBe(true);
  expect(accounts.canContribute(member, "private-room")).toBe(true);

  const limits = { ...accounts.roomLimits("private-room"), connections: 256, databaseBytes: 10 * 1024 * 1024, clankerOutputTokensPerHour: 2_000_000 };
  expect(accounts.updateRoomLimits(member, "private-room", limits)).toEqual(limits);
  expect(() => accounts.updateRoomLimits(owner, "private-room", limits)).toThrow("site admin");
  expect(accounts.roomLimits("private-room")).toEqual(limits);
  accounts.close();
});

test("default room seeding happens once and does not resurrect deleted rooms", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-auth-seed-"));
  const path = join(data, "accounts.sqlite");
  const first = new AccountStore(path);
  const owner = first.ensureLocalOwner("alice");
  const defaults = [{ name: "mine", visibility: "public", contributions: "members", clankerMode: "passive" }] as const;
  first.seedRoomsOnce(owner, [...defaults]);
  first.deleteRoom(owner, "mine");
  first.close();

  const restored = new AccountStore(path);
  const restoredOwner = restored.ensureLocalOwner("alice");
  restored.seedRoomsOnce(restoredOwner, [...defaults]);
  expect(restored.roomPolicy("mine")).toBeUndefined();
  restored.close();
});

test("invite redemption never downgrades an existing room role", () => {
  const { accounts, owner } = setup();
  const invite = accounts.createInvite(owner, "public-room", "viewer");
  expect(accounts.redeem(owner, invite)).toMatchObject({ principal: { id: owner.id }, roomName: "public-room", role: "owner" });
  expect(accounts.roleFor(owner, "public-room")).toBe("owner");
  accounts.close();
});

test("admin-only and disabled-clanker room policies are enforced by Room", () => {
  const { accounts, owner, member } = setup();
  const contributorInvite = accounts.createInvite(owner, "private-room", "contributor");
  accounts.redeemInvite(member, contributorInvite);
  const room = new Room("private-room", 250, "http://example.test/private-room", owner.handle, undefined, accounts);

  expect(room.canView(member)).toBe(true);
  expect(room.chat(member, "untrusted contribution")).toBe(false);
  expect(room.clanker(member, "change the page")).toBe(false);
  expect(room.messages).toEqual([]);
  expect(room.chat(owner, "owner note")).toBe(true);
  expect(room.messages.at(-1)).toMatchObject({ authorId: owner.id, authorRole: "owner", clankerVisible: false });
  accounts.close();
});

test("room policies persist and only admins can change them", () => {
  const { accounts, owner, member } = setup();
  expect(() => accounts.updateRoomPolicy(member, "public-room", { visibility: "private" })).toThrow("requires an admin");
  const updated = accounts.updateRoomPolicy(owner, "public-room", { visibility: "private", contributions: "admins", clankerMode: "explicit" });
  expect(updated).toMatchObject({ visibility: "private", contributions: "admins", clankerMode: "explicit" });
  accounts.close();
});

test("explicit clanker mode does not react passively and preserves authenticated context", async () => {
  const { accounts, owner, member } = setup();
  accounts.updateRoomPolicy(owner, "public-room", { clankerMode: "explicit" });
  accounts.redeemInvite(member, accounts.createInvite(owner, "public-room", "contributor"));
  const room = new Room("public-room", 250, "http://example.test/public-room", owner.handle, undefined, accounts);
  const calls: Array<{ explicit: boolean; authors: string[] }> = [];
  room.setClankerResponder(async (history, _activity, request) => {
    calls.push({ explicit: request.explicit, authors: history.map((message) => message.author) });
    return "[silent]";
  });

  room.chat(member, "context for later");
  await Bun.sleep(0);
  expect(calls).toEqual([]);
  room.clanker(member, "inspect it");
  await Bun.sleep(0);
  expect(calls).toEqual([{ explicit: true, authors: ["bob", "bob"] }]);
  accounts.close();
});
