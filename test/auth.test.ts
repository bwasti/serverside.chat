import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore, anonymousPrincipal, sshFingerprint } from "../src/auth";
import { Room } from "../src/room";

function setup() {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-auth-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const owner = accounts.ensureLocalOwner("alice");
  const member = accounts.ensureLocalOwner("bob");
  accounts.ensureRoom("public-room", owner, { visibility: "public", contributions: "members", agentMode: "passive" });
  accounts.ensureRoom("private-room", owner, { visibility: "private", contributions: "admins", agentMode: "disabled" });
  return { accounts, owner, member };
}

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

test("public visibility is independent from contribution and agent authority", () => {
  const { accounts, owner, member } = setup();
  const guest = anonymousPrincipal("SHA256:guest", "alice");
  expect(accounts.canView(guest, "public-room")).toBe(true);
  expect(accounts.canContribute(guest, "public-room")).toBe(false);
  expect(accounts.canInvokeAgent(guest, "public-room")).toBe(false);
  expect(accounts.canView(member, "private-room")).toBe(false);

  const invite = accounts.createInvite(owner, "public-room", "contributor");
  expect(accounts.redeemInvite(member, invite)).toEqual({ roomName: "public-room", role: "contributor" });
  expect(accounts.canContribute(member, "public-room")).toBe(true);
  expect(accounts.canInvokeAgent(member, "public-room")).toBe(true);
  expect(accounts.canPromote(member, "public-room")).toBe(false);
  expect(accounts.canPromote(owner, "public-room")).toBe(true);
  accounts.close();
});

test("invite redemption never downgrades an existing room role", () => {
  const { accounts, owner } = setup();
  const invite = accounts.createInvite(owner, "public-room", "viewer");
  expect(accounts.redeem(owner, invite)).toMatchObject({ principal: { id: owner.id }, roomName: "public-room", role: "owner" });
  expect(accounts.roleFor(owner, "public-room")).toBe("owner");
  accounts.close();
});

test("admin-only and disabled-agent room policies are enforced by Room", () => {
  const { accounts, owner, member } = setup();
  const contributorInvite = accounts.createInvite(owner, "private-room", "contributor");
  accounts.redeemInvite(member, contributorInvite);
  const room = new Room("private-room", 250, "http://example.test/private-room", owner.handle, undefined, accounts);

  expect(room.canView(member)).toBe(true);
  expect(room.chat(member, "untrusted contribution")).toBe(false);
  expect(room.agent(member, "change the page")).toBe(false);
  expect(room.messages).toEqual([]);
  expect(room.chat(owner, "owner note")).toBe(true);
  expect(room.messages.at(-1)).toMatchObject({ authorId: owner.id, authorRole: "owner", agentVisible: false });
  accounts.close();
});

test("room policies persist and only admins can change them", () => {
  const { accounts, owner, member } = setup();
  expect(() => accounts.updateRoomPolicy(member, "public-room", { visibility: "private" })).toThrow("requires an admin");
  const updated = accounts.updateRoomPolicy(owner, "public-room", { visibility: "private", contributions: "admins", agentMode: "explicit" });
  expect(updated).toMatchObject({ visibility: "private", contributions: "admins", agentMode: "explicit" });
  accounts.close();
});

test("explicit agent mode does not react passively and preserves authenticated context", async () => {
  const { accounts, owner, member } = setup();
  accounts.updateRoomPolicy(owner, "public-room", { agentMode: "explicit" });
  accounts.redeemInvite(member, accounts.createInvite(owner, "public-room", "contributor"));
  const room = new Room("public-room", 250, "http://example.test/public-room", owner.handle, undefined, accounts);
  const calls: Array<{ explicit: boolean; authors: string[] }> = [];
  room.setAgentResponder(async (history, _activity, request) => {
    calls.push({ explicit: request.explicit, authors: history.map((message) => message.author) });
    return "[silent]";
  });

  room.chat(member, "context for later");
  await Bun.sleep(0);
  expect(calls).toEqual([]);
  room.agent(member, "inspect it");
  await Bun.sleep(0);
  expect(calls).toEqual([{ explicit: true, authors: ["bob", "bob"] }]);
  accounts.close();
});
