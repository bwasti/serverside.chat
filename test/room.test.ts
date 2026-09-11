import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore, anonymousPrincipal } from "../src/auth";
import { Room } from "../src/room";

test("room broadcasts chat and agent presence", () => {
  const room = new Room("mine");
  const seen: string[] = [];
  room.subscribe((message) => seen.push(`${message.kind}:${message.author}:${message.text}`));
  room.join("alice");
  room.chat("alice", " hello ");
  room.agent("alice", "status");

  expect(room.members.has("alice")).toBe(true);
  expect(seen.some((message) => message.includes("joined"))).toBe(false);
  expect(seen).toContain("chat:alice:hello");
  expect(seen.at(-1)).toContain("agent:room-agent:Room 'mine' is online");
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

test("room uses a configured asynchronous agent", async () => {
  const room = new Room("mine");
  room.setAgentResponder(async (history) => `saw ${history.at(-1)?.text}`);
  room.agent("alice", "hello");
  await Bun.sleep(0);
  expect(room.messages.at(-1)?.text).toBe("saw @room-agent hello");
});

test("agent failures remain visible in the HUD status", async () => {
  const room = new Room("mine");
  const failed = new Promise<void>((resolve) => room.subscribeService(() => { if (room.agentState.status === "error") resolve(); }));
  room.setAgentResponder(async () => { throw new Error("provider timed out after 5m"); });
  room.agent("alice", "build the page");
  await failed;
  expect(room.agentState).toMatchObject({ status: "error", detail: "provider timed out after 5m" });
});

test("canonical promotions are authoritatively logged in chat", async () => {
  const room = new Room("mine");
  const trunkLogged = new Promise<void>((resolve) => {
    room.subscribe((message) => { if (message.author === "trunk") resolve(); });
  });
  room.setAgentResponder(async (_history, activity) => {
    activity("working", "canonical updated", { label: "trunk abc1234", url: "http://localhost:3000/mine" });
    return "[silent]";
  });
  room.agent("alice", "publish it");
  await trunkLogged;
  expect(room.messages.some((message) => message.author === "trunk" && message.text === "trunk abc1234 · http://localhost:3000/mine")).toBe(true);
});

test("commits become host-rendered updates and suppress agent prose", async () => {
  const room = new Room("mine", 250, "http://localhost:3000/mine", "alice");
  const committed = new Promise<void>((resolve) => {
    room.subscribe((message) => { if (message.kind === "commit") resolve(); });
  });
  room.setAgentResponder(async (_history, activity) => {
    activity("working", "commit created", {
      label: "abc1234 Add greeting",
      url: "http://localhost:3000/mine?__ref=abc1234",
      blurb: "Adds the requested greeting.",
    });
    return "Here is an unnecessarily long summary.";
  });
  room.agent("alice", "add a greeting");
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
  first.addAgentLink("feature", "http://localhost:3000/mine?__ref=abc1234");

  const restored = new Room("mine", 250, "http://localhost:3000/mine", "alice", statePath);
  expect(restored.messages.at(-1)?.text).toBe("persistent hello");
  expect(restored.messages.at(-1)?.at).toBeInstanceOf(Date);
  expect(restored.serviceRequests).toBe(1);
  expect(restored.serviceResponseBytes).toBe(123);
  expect(restored.serviceLogs.at(-1)).toContain("GET /mine");
  expect(restored.agentState.links).toEqual([{ label: "feature", url: "http://localhost:3000/mine?__ref=abc1234" }]);
  expect(restored.serviceStartedAt.getTime()).toBe(first.serviceStartedAt.getTime());
});

test("agent-facing service logs are bounded and ordered", () => {
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
  accounts.ensureSystemRoom("lobby", owner, { visibility: "public", contributions: "members", agentMode: "passive" });
  accounts.ensureRoom("mine", owner, { visibility: "public", contributions: "members", agentMode: "passive" });
  const lobby = new Room("lobby", 250, "https://example.test/lobby", owner.handle, undefined, accounts);
  const mine = new Room("mine", 250, "https://example.test/mine", owner.handle, undefined, accounts);
  const guest = anonymousPrincipal("SHA256:moderated-guest");

  expect(lobby.chat(guest, "bypass moderation")).toBe(false);
  expect(mine.acceptModeratedAnonymousChat(guest, "wrong room")).toBe(false);
  expect(lobby.acceptModeratedAnonymousChat(guest, "approved question")).toBe(true);
  expect(lobby.messages).toHaveLength(1);
  expect(lobby.messages[0]).toMatchObject({ author: guest.handle, text: "approved question", authorId: guest.id, agentVisible: true });
  expect(lobby.messages[0]?.authorRole).toBeUndefined();
  accounts.close();
});
