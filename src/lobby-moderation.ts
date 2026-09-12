import type { Principal } from "./auth";

export interface LobbyModerationDecision {
  allowed: boolean;
  reason?: string;
}

export interface LobbyContentModerator {
  allows(text: string): Promise<boolean>;
}

interface WindowCounter { startedAt: number; count: number }

export const ANONYMOUS_LOBBY_LIMITS = {
  messageBytes: 600,
  perIdentityPerMinute: 3,
  perIdentityPerHour: 12,
  globalPerMinute: 30,
  globalPerHour: 200,
  concurrentReviews: 4,
} as const;

export class AnonymousLobbyGate {
  private readonly identityMinute = new Map<string, WindowCounter>();
  private readonly identityHour = new Map<string, WindowCounter>();
  private readonly globalMinute = new Map<string, WindowCounter>();
  private readonly globalHour = new Map<string, WindowCounter>();
  private reviewsInFlight = 0;

  constructor(private readonly moderator: LobbyContentModerator, private readonly now: () => number = Date.now, private readonly onError: (error: unknown) => void = () => {}) {}

  async review(principal: Principal, raw: string): Promise<LobbyModerationDecision> {
    if (principal.authenticated || principal.kind !== "anonymous") return { allowed: false, reason: "anonymous moderation is not applicable" };
    const text = raw.trim();
    if (!text) return { allowed: false };
    if (Buffer.byteLength(text, "utf8") > ANONYMOUS_LOBBY_LIMITS.messageBytes) return { allowed: false, reason: "anonymous messages are limited to 600 bytes" };
    const now = this.now();
    const withinIdentityLimit = this.consume(this.identityMinute, principal.id, now, 60_000, ANONYMOUS_LOBBY_LIMITS.perIdentityPerMinute)
      && this.consume(this.identityHour, principal.id, now, 60 * 60_000, ANONYMOUS_LOBBY_LIMITS.perIdentityPerHour);
    if (!withinIdentityLimit) return { allowed: false, reason: "anonymous message limit reached · try again later" };
    const withinGlobalLimit = this.consume(this.globalMinute, "lobby", now, 60_000, ANONYMOUS_LOBBY_LIMITS.globalPerMinute)
      && this.consume(this.globalHour, "lobby", now, 60 * 60_000, ANONYMOUS_LOBBY_LIMITS.globalPerHour);
    if (!withinGlobalLimit) return { allowed: false, reason: "anonymous message limit reached · try again later" };
    if (this.reviewsInFlight >= ANONYMOUS_LOBBY_LIMITS.concurrentReviews) return { allowed: false, reason: "lobby moderation is busy · try again shortly" };
    this.reviewsInFlight++;
    try {
      return await this.moderator.allows(text)
        ? { allowed: true }
        : { allowed: false, reason: "message was not posted" };
    } catch (error) {
      this.onError(error);
      return { allowed: false, reason: "lobby moderation is unavailable · try again later" };
    } finally {
      this.reviewsInFlight--;
    }
  }

  private consume(counters: Map<string, WindowCounter>, key: string, now: number, duration: number, limit: number): boolean {
    const current = counters.get(key);
    if (!current || now - current.startedAt >= duration) {
      counters.set(key, { startedAt: now, count: 1 });
      if (counters.size > 10_000) for (const [entryKey, entry] of counters) if (now - entry.startedAt >= duration) counters.delete(entryKey);
      return true;
    }
    current.count++;
    return current.count <= limit;
  }
}

interface ModerationResponse { choices?: Array<{ message?: { content?: string | null } }>; error?: { message?: string } }

export class FireworksLobbyModerator implements LobbyContentModerator {
  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly systemPrompt: string,
    private readonly baseUrl = "https://api.fireworks.ai/inference/v1",
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async allows(text: string): Promise<boolean> {
    const response = await this.fetcher(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "system", content: this.systemPrompt }, { role: "user", content: text }],
        max_tokens: 128,
        temperature: 0,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "lobby_moderation",
            schema: {
              type: "object",
              properties: { decision: { type: "string", enum: ["ALLOW", "BLOCK"] } },
              required: ["decision"],
              additionalProperties: false,
            },
          },
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await response.json()) as ModerationResponse;
    if (!response.ok) throw new Error(body.error?.message ?? `Fireworks returned HTTP ${response.status}`);
    const content = body.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("Fireworks returned no moderation verdict");
    let verdict: unknown;
    try { verdict = (JSON.parse(content) as { decision?: unknown }).decision; }
    catch { throw new Error("Fireworks returned an invalid moderation verdict"); }
    if (verdict !== "ALLOW" && verdict !== "BLOCK") throw new Error("Fireworks returned an invalid moderation verdict");
    return verdict === "ALLOW";
  }
}
