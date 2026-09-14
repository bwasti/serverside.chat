import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore, anonymousPrincipal } from "../src/auth";
import { Room } from "../src/room";

test("room broadcasts chat and clanker presence", () => {
  const room = new Room("mine");
  const seen: string[] = [];
  room.subscribe((message) => seen.push(`${message.kind}:${message.author}:${message.text}`));
  room.join("alice");
  room.chat("alice", " hello ");
  room.clanker("alice", "status");

  expect(room.members.has("alice")).toBe(true);
  expect(seen.some((message) => message.includes("joined"))).toBe(false);
  expect(seen).toContain("chat:alice:hello");
  expect(seen.at(-1)).toContain("clanker:clanker:Room 'mine' is online");
});

test("one room broadcasts the same message to concurrent clients", () => {
  const room = new Room("mine");
  const alice: string[] = [];
  const shannon: string[] = [];
  room.subscribe((message) => alice.push(`${message.author}:${message.text}`));
  room.subscribe((message) => shannon.push(`${message.author}:${message.text}`));
  room.join("alice");
  room.join("shannon");
  room.chat("alice", "from alice");
  room.chat("shannon", "from shannon");
  expect(alice).toEqual(["alice:from alice", "shannon:from shannon"]);
  expect(shannon).toEqual(alice);
});

test("connection accounting distinguishes people from concurrent sessions", () => {
  const room = new Room("mine");
  expect(room.join("alice")).toBe(true);
  expect(room.join("alice")).toBe(true);
  room.setWebConnections(3);
  expect(room.members.size).toBe(1);
  expect(room.connectionCount).toBe(5);
  room.leave("alice");
  expect(room.members.has("alice")).toBe(true);
  expect(room.connectionCount).toBe(4);
});

test("typing presence broadcasts transitions without per-keystroke churn", () => {
  const room = new Room("mine");
  let updates = 0;
  room.subscribeService(() => updates++);

  room.setTyping("alice", true);
  room.setTyping("alice", true);
  expect(room.typingMembers).toEqual(["alice"]);
  expect(updates).toBe(1);

  room.setTyping("alice", false);
  expect(room.typingMembers).toEqual([]);
  expect(updates).toBe(2);
});

test("service log writes notify live HUD subscribers", () => {
  const room = new Room("mine");
  let updates = 0;
  room.subscribeService(() => updates++);

  room.recordServiceLog("guest live update");

  expect(updates).toBe(1);
  expect(room.serviceLogs.at(-1)).toContain("guest live update");
});

test("rolling response-byte ceiling is enforced", () => {
  const room = new Room("mine");
  expect(room.canSendResponse(64 * 1024 * 1024)).toBe(true);
  room.recordRequest("GET", "/large", 200, 1, 64 * 1024 * 1024);
  expect(room.canSendResponse(1)).toBe(false);
});

test("client 404s remain telemetry without marking the site unhealthy", () => {
  const room = new Room("mine");
  room.recordRequest("GET", "/missing", 404, 1, 10);
  expect(room.serviceRequests).toBe(1);
  expect(room.serviceErrors).toBe(0);
  expect(room.serviceLogs.at(-1)).toContain("404 1.0ms GET /missing");
  room.recordRequest("GET", "/broken", 500, 2, 10);
  expect(room.serviceErrors).toBe(1);
});

test("request telemetry bounds and flattens attacker-controlled request targets", () => {
  const room = new Room("mine");
  room.recordRequest("GET\r\nFORGED", `/hello\nFORGED ${"x".repeat(500)}`, 200, 1, 0);
  expect(room.serviceLogs[0]).not.toContain("\n");
  expect(room.serviceLogs[0]).not.toContain("FORGEDGET");
  expect(room.serviceLogs[0]!.length).toBeLessThan(300);
});

test("legacy cumulative client-error totals do not poison the new server-error counter", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-legacy-telemetry-"));
  const statePath = join(data, "room-state.json");
  writeFileSync(statePath, JSON.stringify({ serviceRequests: 162, serviceErrors: 135, serviceStartedAt: new Date().toISOString() }));
  const room = new Room("mine", 250, "http://localhost:3000/mine", "alice", statePath);
  expect(room.serviceRequests).toBe(162);
  expect(room.serviceErrors).toBe(0);
});

test("persisted clanker failures migrate into their dedicated error log", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-clanker-log-migration-"));
  const statePath = join(data, "room-state.json");
  writeFileSync(statePath, JSON.stringify({ serviceStartedAt: new Date().toISOString(), serviceLogs: [], clankerState: { events: ["12:34:56 error · clanker stopped without a commit or blocker"], links: [] } }));
  const room = new Room("mine", 250, "http://localhost:3000/mine", "alice", statePath);
  expect(room.clankerErrorLogs).toContain("12:34:56 CLANKER error clanker stopped without a commit or blocker");
  expect(room.serviceLogs).not.toContain("12:34:56 CLANKER error clanker stopped without a commit or blocker");
});

test("legacy agent transcript state migrates to clanker terminology", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-clanker-state-migration-"));
  const statePath = join(data, "room-state.json");
  writeFileSync(statePath, JSON.stringify({
    serviceStartedAt: new Date().toISOString(),
    messages: [
      { id: 1, kind: "chat", author: "alice", text: "@room-agent inspect user-agent handling", at: new Date().toISOString(), agentVisible: true },
      { id: 2, kind: "agent", author: "room-agent", text: "The user-agent header is preserved.", at: new Date().toISOString(), agentVisible: true },
    ],
    serviceLogs: ["12:34:56 AGENT error agent stopped"],
    agentState: { events: ["12:34:56 error · agent stopped"], links: [] },
  }));

  const room = new Room("mine", 250, "http://localhost:3000/mine", "alice", statePath);
  expect(room.messages[0]).toMatchObject({ kind: "chat", author: "alice", text: "@clanker inspect user-agent handling", clankerVisible: true });
  expect(room.messages[1]).toMatchObject({ kind: "clanker", author: "clanker", text: "The user-agent header is preserved.", clankerVisible: true });
  expect(room.clankerErrorLogs).toContain("12:34:56 CLANKER error clanker stopped");
  expect(room.serviceLogs).not.toContain("12:34:56 CLANKER error clanker stopped");
  expect(room.clankerState.events).toContain("12:34:56 error · clanker stopped");
});

test("room bounds messages and input", () => {
  const room = new Room("mine", 2);
  room.chat("alice", "one");
  room.chat("alice", "two");
  room.chat("alice", "three");
  expect(room.messages.map((message) => message.text)).toEqual(["two", "three"]);
});

test("room messages cannot inject terminal control sequences", () => {
  const room = new Room("mine");
  room.chat("alice", "\x1b[31mred\x1b[0m \x1b]8;;https://evil.test\x07link\x1b]8;;\x07");
  expect(room.messages[0]?.text).toBe("red link");
});

test("room uses a configured asynchronous clanker", async () => {
  const room = new Room("mine");
  room.setClankerResponder(async (history) => `saw ${history.at(-1)?.text}`);
  room.clanker("alice", "hello");
  await Bun.sleep(0);
  expect(room.messages.at(-1)?.text).toBe("saw @clanker hello");
});

test("clanker failures remain visible in the HUD status", async () => {
  const room = new Room("mine");
  const failed = new Promise<void>((resolve) => room.subscribeService(() => { if (room.clankerState.status === "error") resolve(); }));
  room.setClankerResponder(async () => { throw new Error("provider timed out after 5m"); });
  room.clanker("alice", "build the page");
  await failed;
  expect(room.clankerState).toMatchObject({ status: "error", detail: "provider timed out after 5m" });
  expect(room.clankerErrorLogs.at(-1)).toContain("CLANKER error provider timed out after 5m");
  expect(room.serviceLogs).toHaveLength(0);
});

test("canonical promotions are authoritatively logged in chat", async () => {
  const room = new Room("mine");
  const trunkLogged = new Promise<void>((resolve) => {
    room.subscribe((message) => { if (message.author === "trunk") resolve(); });
  });
  room.setClankerResponder(async (_history, activity) => {
    activity("working", "canonical updated", { label: "trunk abc1234", url: "http://localhost:3000/mine" });
    return "[silent]";
  });
  room.clanker("alice", "publish it");
  await trunkLogged;
  expect(room.messages.some((message) => message.author === "trunk" && message.text === "updated to abc1234 · http://localhost:3000/mine")).toBe(true);
  room.recordCanonicalUpdate({ id: "user:alice", kind: "user", handle: "alice", displayName: "Alice", authenticated: true }, "def5678", "http://localhost:3000/mine");
  expect(room.messages.at(-1)).toMatchObject({ author: "trunk", text: "updated to def5678 by @alice · http://localhost:3000/mine" });
});

test("commits become host-rendered updates and suppress clanker prose", async () => {
  const room = new Room("mine", 250, "http://localhost:3000/mine", "alice");
  const committed = new Promise<void>((resolve) => {
    room.subscribe((message) => { if (message.kind === "commit") resolve(); });
  });
  room.setClankerResponder(async (_history, activity) => {
    activity("working", "commit created", {
      label: "abc1234 Add greeting",
      url: "http://localhost:3000/mine?__ref=abc1234",
      blurb: "Adds the requested greeting.",
    });
    return "Here is an unnecessarily long summary.";
  });
  room.clanker("alice", "add a greeting");
  await committed;
  await Bun.sleep(0);

  const update = room.messages.find((message) => message.kind === "commit");
  expect(update).toMatchObject({ text: "abc1234 Add greeting", detail: "Adds the requested greeting.", url: "http://localhost:3000/mine?__ref=abc1234" });
  expect(room.messages.some((message) => message.text.includes("unnecessarily long"))).toBe(false);
});

test("room transcript and HUD state survive process recreation", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-room-state-"));
  const statePath = join(data, "room-state.json");
  const first = new Room("mine", 250, "http://localhost:3000/mine", "alice", statePath);
  first.chat("alice", "persistent hello");
  first.recordRequest("GET", "/mine", 200, 4.5, 123);
  first.addClankerLink("feature", "http://localhost:3000/mine?__ref=abc1234");

  const restored = new Room("mine", 250, "http://localhost:3000/mine", "alice", statePath);
  expect(restored.messages.at(-1)?.text).toBe("persistent hello");
  expect(restored.messages.at(-1)?.at).toBeInstanceOf(Date);
  expect(restored.serviceRequests).toBe(1);
  expect(restored.serviceResponseBytes).toBe(123);
  expect(restored.serviceLogs.at(-1)).toContain("GET /mine");
  expect(restored.clankerState.links).toEqual([{ label: "feature", url: "http://localhost:3000/mine?__ref=abc1234" }]);
  expect(restored.serviceStartedAt.getTime()).toBe(first.serviceStartedAt.getTime());
});

test("replies persist while room and site admins can moderate messages", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-message-moderation-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const owner = accounts.ensureLocalOwner("alice");
  const contributor = accounts.createDevelopmentAccount("bob").principal;
  const roomAdmin = accounts.createDevelopmentAccount("charlie").principal;
  const siteAdmin = accounts.createDevelopmentAccount("dana").principal;
  accounts.ensureRoom("mine", owner, { visibility: "public", contributions: "members", clankerMode: "passive" });
  accounts.redeemInvite(contributor, accounts.createInvite(owner, "mine", "contributor"));
  accounts.redeemInvite(roomAdmin, accounts.createInvite(owner, "mine", "admin"));
  accounts.ensureSiteAdmin(siteAdmin);
  expect(accounts.canView(siteAdmin, "mine")).toBe(true);
  const statePath = join(data, "room-state.json");
  const room = new Room("mine", 250, "http://localhost:3000/mine", "alice", statePath, accounts);

  room.chat(owner, "the original message");
  const original = room.messages.at(-1)!;
  expect(room.chat(contributor, "a focused reply", original.id)).toBe(true);
  const reply = room.messages.at(-1)!;
  expect(reply.replyTo).toEqual({ id: original.id, author: "alice", excerpt: "the original message" });
  expect(() => room.deleteMessage(contributor, original.id)).toThrow("requires a room admin");
  room.chat(owner, "temporary moderator target");
  expect(room.deleteMessage(roomAdmin, room.messages.at(-1)!.id)).toBe(true);
  expect(room.deleteMessage(siteAdmin, original.id)).toBe(true);
  expect(room.messages).toEqual([reply]);

  const restored = new Room("mine", 250, "http://localhost:3000/mine", "alice", statePath, accounts);
  expect(restored.messages).toHaveLength(1);
  expect(restored.messages[0]).toMatchObject({ text: "a focused reply", replyTo: { id: original.id, author: "alice", excerpt: "the original message" } });
  accounts.close();
});

test("room admins can persistently pin chat messages while contributors cannot", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-message-pins-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const owner = accounts.ensureLocalOwner("alice");
  const contributor = accounts.createDevelopmentAccount("bob").principal;
  accounts.ensureRoom("mine", owner, { visibility: "public", contributions: "members", clankerMode: "passive" });
  accounts.redeemInvite(contributor, accounts.createInvite(owner, "mine", "contributor"));
  const statePath = join(data, "room-state.json");
  const room = new Room("mine", 250, "http://localhost:3000/mine", "alice", statePath, accounts);
  room.chat(owner, "Welcome guide");
  const message = room.messages.at(-1)!;

  expect(() => room.setMessagePinned(contributor, message.id, true)).toThrow("requires a room admin");
  expect(room.setMessagePinned(owner, message.id, true)).toBe(true);
  expect(room.pinnedMessages.map((item) => item.id)).toEqual([message.id]);

  const restored = new Room("mine", 250, "http://localhost:3000/mine", "alice", statePath, accounts);
  expect(restored.pinnedMessages[0]).toMatchObject({ id: message.id, text: "Welcome guide", pinnedBy: owner.id });
  expect(restored.setMessagePinned(owner, message.id, false)).toBe(true);
  expect(restored.pinnedMessages).toEqual([]);
  accounts.close();
});

test("clanker-facing service logs are bounded and ordered", () => {
  const room = new Room("mine");
  for (let index = 0; index < 60; index++) room.recordServiceLog(`${index} ${"x".repeat(700)}`);
  const logs = room.tailServiceLogs(500);
  expect(logs).toHaveLength(32);
  expect(logs.at(-1)).toContain("59 ");
  expect(logs.every((line) => line.length <= 500)).toBe(true);
  expect(Buffer.byteLength(logs.join(""))).toBeLessThanOrEqual(16 * 1024);
});

test("version graph commits link to immutable deployment URLs", () => {
  const room = new Room("mine", 250, "http://example.test/mine");
  room.setVersionGraph(["● abc1234 Feature title  (feature)", "│ connector"]);
  expect(room.versionGraph[0]).toEqual({ text: "● abc1234 Feature title  (feature)", url: "http://example.test/mine?__ref=abc1234" });
  expect(room.versionGraph[1]).toEqual({ text: "│ connector", url: undefined });
});

test("only the system lobby accepts host-moderated anonymous messages", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-room-anonymous-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const owner = accounts.ensureLocalOwner("alice");
  accounts.ensureSystemRoom("lobby", owner, { visibility: "public", contributions: "members", clankerMode: "passive" });
  accounts.ensureRoom("mine", owner, { visibility: "public", contributions: "members", clankerMode: "passive" });
  const lobby = new Room("lobby", 250, "https://example.test/lobby", owner.handle, undefined, accounts);
  const mine = new Room("mine", 250, "https://example.test/mine", owner.handle, undefined, accounts);
  const guest = anonymousPrincipal("SHA256:moderated-guest");

  expect(lobby.chat(guest, "bypass moderation")).toBe(false);
  expect(mine.acceptModeratedAnonymousChat(guest, "wrong room")).toBe(false);
  expect(lobby.acceptModeratedAnonymousChat(guest, "approved question")).toBe(true);
  expect(lobby.messages).toHaveLength(1);
  expect(lobby.messages[0]).toMatchObject({ author: guest.handle, text: "approved question", authorId: guest.id, clankerVisible: true });
  expect(lobby.messages[0]?.authorRole).toBeUndefined();
  accounts.close();
});
