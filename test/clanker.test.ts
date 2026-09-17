import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FireworksClanker, hasPendingConcreteWork, isConcreteWorkRequest, isTrivialSocialMessage, recoverDsmlToolCalls, ROOM_CLANKER_FINALIZATION_WINDOW_MS, ROOM_CLANKER_MAX_TURNS, ROOM_CLANKER_PROVIDER_TIMEOUT_MS, ROOM_CLANKER_RUN_TIMEOUT_MS, shouldGuideRespond } from "../src/clanker";
import type { Message } from "../src/room";
import { RoomWorkspace } from "../src/workspace";
import { TokenBudget } from "../src/token-budget";
import { loadRoomClankerPrompt, readCanonicalSiteCss } from "../src/clanker-prompt";

test("social greetings are deterministically swallowed before model routing", () => {
  for (const message of ["hi", "Hi Alice", "@clanker hello", "hey everyone!", "thanks", "cool"]) {
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

test("room clanker runs reserve finalization time within bounded production budgets", () => {
  expect(ROOM_CLANKER_RUN_TIMEOUT_MS).toBe(15 * 60_000);
  expect(ROOM_CLANKER_PROVIDER_TIMEOUT_MS).toBe(5 * 60_000);
  expect(ROOM_CLANKER_FINALIZATION_WINDOW_MS).toBe(2 * 60_000);
  expect(ROOM_CLANKER_MAX_TURNS).toBe(256);
});

test("room clanker receives the canonical restrained site design and CSS reference", () => {
  const prompt = loadRoomClankerPrompt();
  expect(prompt).toContain("Hacker News' information-first restraint");
  expect(prompt).toContain("read_design_reference");
  expect(readCanonicalSiteCss()).toContain("--accent: #7f9f7f");
  expect(readCanonicalSiteCss()).toContain("border-radius: 0");
});

test("clanker can read the canonical design without carrying its CSS in every prompt", async () => {
  let calls = 0;
  const clanker = new FireworksClanker("test", "test-model", loadRoomClankerPrompt(), {
    attempts: 1,
    fetcher: async (_input, init) => {
      calls++;
      if (calls === 1) return Response.json({ choices: [{ message: { role: "assistant", tool_calls: [{ id: "design", type: "function", function: { name: "read_design_reference", arguments: "{}" } }] } }] });
      const request = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content?: string }> };
      expect(request.messages.at(-1)?.content).toContain("--accent: #7f9f7f");
      return Response.json({ choices: [{ message: finish("answer", "The reference uses square controls.") }] });
    },
  });
  expect(await clanker.respond("test", "https://test.example", [message("chat", "what visual baseline does this site use?")], workspace(), () => {}, "alice", "alice", false, () => [])).toBe("The reference uses square controls.");
  expect(calls).toBe(2);
});

test("complete DeepSeek DSML leakage is recovered as a native tool call", () => {
  const leaked = `<｜DSML｜ calls> I will edit it.
<｜DSML｜ invoke name="write_file">
<｜DSML｜ parameter name="path" string="true">index.html</｜DSML｜ parameter>
<｜DSML｜ parameter name="content" string="true"><!doctype html><button>scan</button></｜DSML｜ parameter>
</｜DSML｜ invoke></｜DSML｜ calls>`;
  const recovered = recoverDsmlToolCalls({ role: "assistant", content: leaked });
  expect(recovered.content).toBeNull();
  expect(recovered.tool_calls).toHaveLength(1);
  expect(recovered.tool_calls?.[0]?.function.name).toBe("write_file");
  expect(JSON.parse(recovered.tool_calls?.[0]?.function.arguments ?? "{}")).toEqual({ path: "index.html", content: "<!doctype html><button>scan</button>" });
});

test("malformed model markup and free-form replies are never admitted to chat", async () => {
  let calls = 0;
  const clanker = new FireworksClanker("test", "test-model", "test prompt", {
    attempts: 1,
    fetcher: async (_input, init) => {
      calls++;
      const request = JSON.parse(String(init?.body)) as { tool_choice: string; tools: Array<{ function: { name: string } }>; messages: Array<{ content?: string }> };
      expect(request.tool_choice).toBe("required");
      expect(request.tools.some((tool) => tool.function.name === "finish_clanker_turn")).toBe(true);
      if (calls === 1) return Response.json({ choices: [{ message: { role: "assistant", content: `<｜DSML｜ invoke name="write_file"><｜DSML｜ parameter name="path">broken` } }] });
      expect(request.messages.at(-1)?.content).toContain("response was rejected");
      return Response.json({ choices: [{ message: finish("answer", "worker.js serves the room.") }] });
    },
  });
  expect(await clanker.respond("test", "https://test.example", [message("chat", "what does worker.js do?")], workspace(), () => {}, "alice", "alice", false, () => [])).toBe("worker.js serves the room.");
  expect(calls).toBe(2);

  const broken = new FireworksClanker("test", "test-model", "test prompt", {
    attempts: 1,
    fetcher: async () => Response.json({ choices: [{ message: { role: "assistant", content: "I changed the page." } }] }),
  });
  await expect(broken.respond("test", "https://test.example", [message("chat", "what does worker.js do?")], workspace(), () => {}, "alice", "alice", false, () => [])).rejects.toThrow("invalid clanker format");
});

test("turn-limit failures are concise and confirm that work is preserved", async () => {
  let calls = 0;
  const clanker = new FireworksClanker("test", "test-model", "test prompt", {
    timeoutMs: 1_000,
    attempts: 1,
    maxTurns: 2,
    fetcher: async () => Response.json({ choices: [{ message: { role: "assistant", tool_calls: [{ id: `call-${++calls}`, type: "function", function: { name: "git_status", arguments: "{}" } }] } }] }),
  });
  await expect(clanker.respond("test", "https://test.example", [message("chat", "build a notes app")], workspace(), () => {}, "alice", "alice", false, () => [])).rejects.toThrow("2-turn limit reached · work preserved");
  expect(calls).toBe(2);
});

test("concrete work remains pending across a follow-up until a commit or clanker blocker", () => {
  const history = [message("chat", "create a notes app"), message("chat", "cmon clanker, do this")];
  expect(hasPendingConcreteWork(history)).toBe(true);
  expect(hasPendingConcreteWork([...history, message("clanker", "A required capability is unavailable.")])).toBe(false);
  expect(hasPendingConcreteWork([...history, message("commit", "abc1234 Build notes app")])).toBe(false);
});

test("transient provider failures retry within the completion budget", async () => {
  let calls = 0;
  const activity: string[] = [];
  const clanker = new FireworksClanker("test", "test-model", "test prompt", {
    timeoutMs: 1_000,
    attempts: 2,
    retryDelayMs: 0,
    fetcher: async () => {
      calls++;
      return calls === 1
        ? Response.json({ error: { message: "temporarily busy" } }, { status: 503 })
        : Response.json({ choices: [{ message: finish("answer", "worker.js serves the room.") }] });
    },
  });
  const reply = await clanker.respond("test", "https://test.example", [message("chat", "what does worker.js do?")], workspace(), (status, detail) => activity.push(`${status}:${detail}`), "alice", "alice", false, () => []);
  expect(reply).toBe("worker.js serves the room.");
  expect(calls).toBe(2);
  expect(activity.some((entry) => entry.includes("retrying provider · 2/2"))).toBe(true);
});

test("a provider timeout becomes an explicit bounded clanker failure", async () => {
  const clanker = new FireworksClanker("test", "test-model", "test prompt", {
    timeoutMs: 1_000,
    providerTimeoutMs: 10,
    attempts: 1,
    fetcher: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }),
  });
  await expect(clanker.respond("test", "https://test.example", [message("chat", "what does worker.js do?")], workspace(), () => {}, "alice", "alice", false, () => [])).rejects.toThrow("provider timed out after 10ms");
});

test("an overall run deadline has a distinct concise failure", async () => {
  const clanker = new FireworksClanker("test", "test-model", "test prompt", {
    timeoutMs: 20,
    providerTimeoutMs: 1_000,
    attempts: 1,
    fetcher: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }),
  });
  await expect(clanker.respond("test", "https://test.example", [message("chat", "what does worker.js do?")], workspace(), () => {}, "alice", "alice", false, () => [])).rejects.toThrow("20ms run limit reached · work preserved");
});

test("concrete work receives a time-reserved finalization attempt", async () => {
  let calls = 0;
  const activity: string[] = [];
  const clanker = new FireworksClanker("test", "test-model", "test prompt", {
    timeoutMs: 60,
    providerTimeoutMs: 1_000,
    finalizationWindowMs: 20,
    attempts: 1,
    fetcher: async (_input, init) => {
      calls++;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    },
  });
  await expect(clanker.respond("test", "https://test.example", [message("chat", "fix the page")], workspace(), (status, detail) => activity.push(`${status}:${detail}`), "alice", "alice", false, () => [])).rejects.toThrow("60ms run limit reached · work preserved");
  expect(calls).toBe(2);
  expect(activity.some((entry) => entry.includes("finalizing"))).toBe(true);
});

test("pending implementation work gets one corrective continuation instead of silence", async () => {
  let calls = 0;
  const clanker = new FireworksClanker("test", "test-model", "test prompt", {
    timeoutMs: 1_000,
    attempts: 1,
    fetcher: async () => Response.json({ choices: [{ message: ++calls === 1 ? finish("silent") : finish("blocked", "A required capability is unavailable.") }] }),
  });
  const history = [message("chat", "create a notes app"), message("chat", "cmon clanker, do this")];
  const reply = await clanker.respond("test", "https://test.example", history, workspace(), () => {}, "alice", "alice", false, () => []);
  expect(reply).toBe("A required capability is unavailable.");
  expect(calls).toBe(2);
});

test("clanker receives stable message IDs and can use the permission-checked pin capability", async () => {
  let calls = 0;
  let requestBody = "";
  const pins: Array<[number, boolean]> = [];
  const clanker = new FireworksClanker("test", "test-model", "test prompt", {
    attempts: 1,
    fetcher: async (_input, init) => {
      requestBody = String(init?.body ?? "");
      calls++;
      return calls === 1
        ? Response.json({ choices: [{ message: { role: "assistant", tool_calls: [{ id: "pin-1", type: "function", function: { name: "set_message_pin", arguments: '{"message_id":42,"pinned":true}' } }] } }] })
        : Response.json({ choices: [{ message: finish("silent") }] });
    },
  });
  const history: Message[] = [{ id: 42, kind: "chat", author: "alice", text: "pin this guide", at: new Date(), clankerVisible: true }];
  const reply = await clanker.respond("test", "https://test.example", history, workspace(), () => {}, "alice", "alice", false, () => [], (id, pinned) => { pins.push([id, pinned]); return true; });
  expect(reply).toBe("[silent]");
  expect(pins).toEqual([[42, true]]);
  expect(requestBody).toContain("[message 42] alice: pin this guide");
});

test("every clanker provider turn is charged to its room token budget", async () => {
  const root = mkdtempSync(join(tmpdir(), "serverside-chat-clanker-budget-"));
  const tokenBudget = new TokenBudget(join(root, "usage.sqlite"), 50_000, 100_000);
  const clanker = new FireworksClanker("test", "test-model", "test prompt", {
    attempts: 1,
    tokenBudget,
    fetcher: async () => Response.json({ choices: [{ message: finish("answer", "worker.js serves the room.") }], usage: { completion_tokens: 321, total_tokens: 12_000 } }),
  });
  await clanker.respond("metered", "https://test.example", [message("chat", "what does worker.js do?")], workspace(), () => {}, "alice", "alice", false, () => []);
  expect(tokenBudget.snapshot("metered")).toMatchObject({ roomUsed: 321, globalUsed: 321 });
});

function workspace(): RoomWorkspace { return new RoomWorkspace(mkdtempSync(join(tmpdir(), "serverside-chat-clanker-")), "test"); }
function message(kind: Message["kind"], text: string): Message { return { id: Math.floor(Math.random() * 1_000_000), kind, author: kind === "clanker" ? "clanker" : "alice", text, at: new Date(), clankerVisible: true }; }
function finish(outcome: "silent" | "answer" | "blocked", text = "") {
  return { role: "assistant", tool_calls: [{ id: `finish-${Math.random()}`, type: "function", function: { name: "finish_clanker_turn", arguments: JSON.stringify({ outcome, message: text }) } }] };
}
