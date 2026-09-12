export interface RateLimitPolicy {
  capacity: number;
  refillPerSecond: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterMs: number;
  remaining: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
  blockedUntil: number;
  strikes: number;
  lastSeen: number;
}

export const RATE_LIMITS = {
  anonymousHttp: { capacity: 30, refillPerSecond: 0.5, baseBackoffMs: 2_000, maxBackoffMs: 5 * 60_000 },
  authenticatedHttp: { capacity: 120, refillPerSecond: 2, baseBackoffMs: 1_000, maxBackoffMs: 60_000 },
  anonymousSocket: { capacity: 30, refillPerSecond: 15, baseBackoffMs: 5_000, maxBackoffMs: 5 * 60_000 },
  authenticatedSocket: { capacity: 80, refillPerSecond: 40, baseBackoffMs: 1_000, maxBackoffMs: 60_000 },
  anonymousChat: { capacity: 2, refillPerSecond: 1 / 30, baseBackoffMs: 15_000, maxBackoffMs: 15 * 60_000 },
  authenticatedChat: { capacity: 8, refillPerSecond: 1 / 3, baseBackoffMs: 2_000, maxBackoffMs: 2 * 60_000 },
  authenticatedCommand: { capacity: 12, refillPerSecond: 1, baseBackoffMs: 1_000, maxBackoffMs: 60_000 },
  agentRequest: { capacity: 2, refillPerSecond: 1 / 30, baseBackoffMs: 10_000, maxBackoffMs: 10 * 60_000 },
  sshConnection: { capacity: 10, refillPerSecond: 1 / 15, baseBackoffMs: 5_000, maxBackoffMs: 10 * 60_000 },
  sshOperation: { capacity: 120, refillPerSecond: 30, baseBackoffMs: 1_000, maxBackoffMs: 60_000 },
} as const satisfies Record<string, RateLimitPolicy>;

/** Token buckets with escalating cooldowns. State is bounded and shared across reconnects. */
export class AdaptiveRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly now: () => number = Date.now, private readonly maximumEntries = 20_000) {}

  consume(key: string, policy: RateLimitPolicy, cost = 1): RateLimitDecision {
    const now = this.now();
    const boundedCost = Math.max(0.001, Math.min(policy.capacity, cost));
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: policy.capacity, updatedAt: now, blockedUntil: 0, strikes: 0, lastSeen: now };
      this.buckets.set(key, bucket);
      this.prune(now, policy.maxBackoffMs);
    }
    bucket.lastSeen = now;
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(policy.capacity, bucket.tokens + elapsed / 1_000 * policy.refillPerSecond);
    bucket.updatedAt = now;
    if (now < bucket.blockedUntil) return { allowed: false, retryAfterMs: bucket.blockedUntil - now, remaining: Math.floor(bucket.tokens) };
    if (bucket.tokens >= boundedCost) {
      bucket.tokens -= boundedCost;
      if (bucket.tokens >= policy.capacity * 0.75 && bucket.strikes) bucket.strikes--;
      return { allowed: true, retryAfterMs: 0, remaining: Math.floor(bucket.tokens) };
    }
    bucket.strikes = Math.min(20, bucket.strikes + 1);
    const refillWait = policy.refillPerSecond > 0 ? (boundedCost - bucket.tokens) / policy.refillPerSecond * 1_000 : policy.maxBackoffMs;
    const backoff = Math.min(policy.maxBackoffMs, Math.max(refillWait, policy.baseBackoffMs * 2 ** (bucket.strikes - 1)));
    bucket.blockedUntil = now + backoff;
    return { allowed: false, retryAfterMs: backoff, remaining: 0 };
  }

  private prune(now: number, maximumBackoffMs: number): void {
    if (this.buckets.size <= this.maximumEntries) return;
    const staleBefore = now - Math.max(60_000, maximumBackoffMs * 2);
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastSeen < staleBefore && bucket.blockedUntil <= now) this.buckets.delete(key);
      if (this.buckets.size <= this.maximumEntries) return;
    }
    while (this.buckets.size > this.maximumEntries) this.buckets.delete(this.buckets.keys().next().value!);
  }
}

export function retrySeconds(decision: RateLimitDecision): number {
  return Math.max(1, Math.ceil(decision.retryAfterMs / 1_000));
}
