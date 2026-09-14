import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { providerOutputTokenUsage, TokenBudget } from "../src/token-budget";

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

test("provider accounting uses output tokens and never total input-plus-output usage", () => {
  expect(providerOutputTokenUsage({ usage: { completion_tokens: 42, total_tokens: 900 } })).toBe(42);
  expect(providerOutputTokenUsage({ usage: { output_tokens: 17 } })).toBe(17);
  expect(providerOutputTokenUsage({ usage: { total_tokens: 900 } })).toBeUndefined();
});

test("legacy total-token ledger rows do not count toward output budgets", () => {
  const root = mkdtempSync(join(tmpdir(), "serverside-chat-token-migration-"));
  const path = join(root, "usage.sqlite");
  const legacy = new Database(path, { create: true });
  legacy.exec("CREATE TABLE clanker_token_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, tokens INTEGER NOT NULL, recorded_at INTEGER NOT NULL); CREATE TABLE clanker_token_reservations (id TEXT PRIMARY KEY, room TEXT NOT NULL, tokens INTEGER NOT NULL, expires_at INTEGER NOT NULL);");
  legacy.query("INSERT INTO clanker_token_usage (room, tokens, recorded_at) VALUES ('mine', 999, ?)").run(Date.now());
  legacy.close();

  const migrated = new TokenBudget(path, 1_000, 2_000);
  expect(migrated.snapshot("mine")).toMatchObject({ roomUsed: 0, globalUsed: 0 });
});

test("room-specific output limits are read dynamically", () => {
  const root = mkdtempSync(join(tmpdir(), "serverside-chat-token-limits-"));
  const limits = new Map([["small", 25], ["large", 150]]);
  const tokens = new TokenBudget(join(root, "usage.sqlite"), 100, 200, Date.now, (room) => limits.get(room) ?? 100);
  expect(tokens.snapshot("small").roomLimit).toBe(25);
  expect(() => tokens.reserve("small", 26)).toThrow("request exceeds the room token limit");
  expect(tokens.reserve("large", 120)).toBeDefined();
  limits.set("large", 100);
  expect(tokens.snapshot("large").roomLimit).toBe(100);
});
