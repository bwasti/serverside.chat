import { expect, test } from "bun:test";
import { AdaptiveRateLimiter } from "../src/rate-limit";

test("adaptive rate limits refill and apply escalating reconnect-resistant backoff", () => {
  let now = 1_000;
  const limiter = new AdaptiveRateLimiter(() => now);
  const policy = { capacity: 2, refillPerSecond: 1, baseBackoffMs: 1_000, maxBackoffMs: 8_000 };

  expect(limiter.consume("alice", policy).allowed).toBe(true);
  expect(limiter.consume("alice", policy).allowed).toBe(true);
  expect(limiter.consume("alice", policy)).toMatchObject({ allowed: false, retryAfterMs: 1_000 });
  now += 500;
  expect(limiter.consume("alice", policy).retryAfterMs).toBe(500);
  now += 500;
  expect(limiter.consume("alice", policy).allowed).toBe(true);
  expect(limiter.consume("alice", policy)).toMatchObject({ allowed: false, retryAfterMs: 2_000 });
  expect(limiter.consume("bob", policy).allowed).toBe(true);
});

test("retry time never expires before enough capacity has refilled", () => {
  let now = 1_000;
  const limiter = new AdaptiveRateLimiter(() => now);
  const policy = { capacity: 1, refillPerSecond: 1 / 3, baseBackoffMs: 1_000, maxBackoffMs: 8_000 };
  expect(limiter.consume("alice", policy).allowed).toBe(true);
  expect(limiter.consume("alice", policy).retryAfterMs).toBe(3_000);
  now += 3_000;
  expect(limiter.consume("alice", policy).allowed).toBe(true);
});
