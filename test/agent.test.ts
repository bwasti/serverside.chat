import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FireworksAgent, hasPendingConcreteWork, isConcreteWorkRequest, isTrivialSocialMessage, ROOM_AGENT_MAX_TURNS, ROOM_AGENT_PROVIDER_TIMEOUT_MS, shouldGuideRespond } from "../src/agent";
import type { Message } from "../src/room";
import { RoomWorkspace } from "../src/workspace";

test("social greetings are deterministically swallowed before model routing", () => {
  for (const message of ["hi", "Hi Alice", "@room-agent hello", "hey everyone!", "thanks", "cool"]) {
    expect(isTrivialSocialMessage(message)).toBe(true);
  }
  for (const message of ["make the button red", "what does worker.js do?", "hi, can you fix the page?"]) {
    expect(isTrivialSocialMessage(message)).toBe(false);
  }
});

test("explicit work requests are recognized without a probabilistic admission gate", () => {
  for (const message of ["fix it", "build a contact page", "can you remove that preview?", "investigate this bug", "please make the button red"]) {
    expect(isConcreteWorkRequest(message)).toBe(true);
  }
  for (const message of ["hi", "that is interesting", "what do you all think?"]) {
    expect(isConcreteWorkRequest(message)).toBe(false);
  }
});

test("the lobby guide admits product questions but not social or unrelated chat", () => {
  for (const message of ["how do I create a room?", "can I invite Alice", "what does tab do", "help", "SSH login?"]) {
    expect(shouldGuideRespond(message)).toBe(true);
  }
  for (const message of ["hi", "thanks everyone", "I like turtles", "great weather today"]) {
    expect(shouldGuideRespond(message)).toBe(false);
  }
});

test("room agent provider calls have a five-minute production budget", () => {
  expect(ROOM_AGENT_PROVIDER_TIMEOUT_MS).toBe(5 * 60_000);
  expect(ROOM_AGENT_MAX_TURNS).toBe(64);
});

test("turn-limit failures are concise and confirm that work is preserved", async () => {
  let calls = 0;
  const agent = new FireworksAgent("test", "test-model", "test prompt", {
    timeoutMs: 1_000,
    attempts: 1,
    maxTurns: 2,
    fetcher: async () => Response.json({ choices: [{ message: { role: "assistant", tool_calls: [{ id: `call-${++calls}`, type: "function", function: { name: "git_status", arguments: "{}" } }] } }] }),
  });
  await expect(agent.respond("test", "https://test.example", [message("chat", "build a notes app")], workspace(), () => {}, "alice", "alice", false, () => [])).rejects.toThrow("2-turn limit reached · work preserved");
  expect(calls).toBe(2);
});

test("concrete work remains pending across a follow-up until a commit or agent blocker", () => {
  const history = [message("chat", "create a notes app"), message("chat", "cmon bot, do this")];
  expect(hasPendingConcreteWork(history)).toBe(true);
  expect(hasPendingConcreteWork([...history, message("agent", "A required capability is unavailable.")])).toBe(false);
  expect(hasPendingConcreteWork([...history, message("commit", "abc1234 Build notes app")])).toBe(false);
});

test("transient provider failures retry within the completion budget", async () => {
  let calls = 0;
  const activity: string[] = [];
  const agent = new FireworksAgent("test", "test-model", "test prompt", {
    timeoutMs: 1_000,
    attempts: 2,
    retryDelayMs: 0,
    fetcher: async () => {
      calls++;
      return calls === 1
        ? Response.json({ error: { message: "temporarily busy" } }, { status: 503 })
        : Response.json({ choices: [{ message: { role: "assistant", content: "worker.js serves the room." } }] });
    },
  });
  const reply = await agent.respond("test", "https://test.example", [message("chat", "what does worker.js do?")], workspace(), (status, detail) => activity.push(`${status}:${detail}`), "alice", "alice", false, () => []);
  expect(reply).toBe("worker.js serves the room.");
  expect(calls).toBe(2);
  expect(activity.some((entry) => entry.includes("retrying provider · 2/2"))).toBe(true);
});

test("a provider timeout becomes an explicit bounded agent failure", async () => {
  const agent = new FireworksAgent("test", "test-model", "test prompt", {
    timeoutMs: 10,
    attempts: 1,
    fetcher: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }),
  });
  await expect(agent.respond("test", "https://test.example", [message("chat", "what does worker.js do?")], workspace(), () => {}, "alice", "alice", false, () => [])).rejects.toThrow("provider timed out after 10ms");
});

test("pending implementation work gets one corrective continuation instead of silence", async () => {
  let calls = 0;
  const agent = new FireworksAgent("test", "test-model", "test prompt", {
    timeoutMs: 1_000,
    attempts: 1,
    fetcher: async () => Response.json({ choices: [{ message: { role: "assistant", content: ++calls === 1 ? "[silent]" : "A required capability is unavailable." } }] }),
  });
  const history = [message("chat", "create a notes app"), message("chat", "cmon bot, do this")];
  const reply = await agent.respond("test", "https://test.example", history, workspace(), () => {}, "alice", "alice", false, () => []);
  expect(reply).toBe("A required capability is unavailable.");
  expect(calls).toBe(2);
});

function workspace(): RoomWorkspace { return new RoomWorkspace(mkdtempSync(join(tmpdir(), "serverside-chat-agent-")), "test"); }
function message(kind: Message["kind"], text: string): Message { return { id: Math.floor(Math.random() * 1_000_000), kind, author: kind === "agent" ? "room-agent" : "alice", text, at: new Date(), agentVisible: true }; }
