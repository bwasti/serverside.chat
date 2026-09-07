import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore, anonymousPrincipal, sshFingerprint } from "../src/auth";
import { Room } from "../src/room";

function setup() {
  const data = mkdtempSync(join(tmpdir(), "wasm-chat-auth-"));
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

test("an invited SSH key becomes a durable room account", () => {
  const { accounts, owner } = setup();
  const key = Buffer.from("new-collaborator-public-key");
  const guest = accounts.principalForKey("ssh-ed25519", key, "charlie");
  const invite = accounts.createInvite(owner, "private-room", "contributor");

  const redeemed = accounts.redeemSshInvite(guest, invite);
  expect(redeemed).toMatchObject({ roomName: "private-room", role: "contributor", principal: { handle: "charlie", authenticated: true } });
  expect(accounts.canView(redeemed.principal, "private-room")).toBe(true);
  expect(accounts.canContribute(redeemed.principal, "private-room")).toBe(false);
  expect(accounts.principalForKey("ssh-ed25519", key, "spoofed")).toMatchObject({ id: redeemed.principal.id, handle: "charlie", authenticated: true });
  expect(() => accounts.redeemSshInvite(guest, invite)).toThrow("invalid or expired");
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
  expect(accounts.redeemInvite(member, invite)).toBe("contributor");
  expect(accounts.canContribute(member, "public-room")).toBe(true);
  expect(accounts.canInvokeAgent(member, "public-room")).toBe(true);
  expect(accounts.canPromote(member, "public-room")).toBe(false);
  expect(accounts.canPromote(owner, "public-room")).toBe(true);
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
