import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateProviderTokens, providerTokenUsage, TokenBudget } from "../src/token-budget";

function budget(roomLimit = 100, globalLimit = 180, clock = { now: 1_000 }): TokenBudget {
  const root = mkdtempSync(join(tmpdir(), "serverside-chat-tokens-"));
  return new TokenBudget(join(root, "usage.sqlite"), roomLimit, globalLimit, () => clock.now);
}

test("token reservations atomically protect room and global hourly budgets", () => {
  const tokens = budget();
  expect(() => tokens.reserve("alpha", 101)).toThrow("request exceeds the room token limit");
  const first = tokens.reserve("alpha", 60);
  expect(tokens.snapshot("alpha")).toMatchObject({ roomUsed: 60, globalUsed: 60, roomLimit: 100, globalLimit: 180 });
  expect(() => tokens.reserve("alpha", 41)).toThrow("room clanker token limit reached");

  const second = tokens.reserve("beta", 100);
  expect(() => tokens.reserve("gamma", 21)).toThrow("global clanker token limit reached");
  first.commit(25);
  second.commit(40);
  expect(tokens.snapshot("alpha").roomUsed).toBe(25);
  expect(tokens.snapshot("beta").globalUsed).toBe(65);
});

test("usage persists, follows room renames, and expires on a rolling hour", () => {
  const root = mkdtempSync(join(tmpdir(), "serverside-chat-tokens-"));
  const path = join(root, "usage.sqlite");
  const clock = { now: 5_000 };
  const first = new TokenBudget(path, 100, 200, () => clock.now);
  first.reserve("old-name", 80).commit(33);

  const restarted = new TokenBudget(path, 100, 200, () => clock.now);
  expect(restarted.snapshot("old-name").roomUsed).toBe(33);
  restarted.renameRoom("old-name", "new-name");
  expect(restarted.snapshot("old-name").roomUsed).toBe(0);
  expect(restarted.snapshot("new-name").roomUsed).toBe(33);

  clock.now += 60 * 60_000 + 1;
  expect(restarted.snapshot("new-name")).toMatchObject({ roomUsed: 0, globalUsed: 0 });
});

test("provider accounting prefers reported usage and estimates conservatively", () => {
  const payload = JSON.stringify({ messages: [{ role: "user", content: "hello" }] });
  expect(estimateProviderTokens(payload, 500)).toBe(Buffer.byteLength(payload) + 500);
  expect(providerTokenUsage({ usage: { total_tokens: 42 } })).toBe(42);
  expect(providerTokenUsage({ usage: { total_tokens: -1 } })).toBeUndefined();
});
