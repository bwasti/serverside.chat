import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

export const DEFAULT_ROOM_CLANKER_TOKENS_PER_HOUR = 250_000;
export const DEFAULT_GLOBAL_CLANKER_TOKENS_PER_HOUR = 2_000_000;
const WINDOW_MS = 60 * 60_000;

interface TotalRow { total: number }

export interface TokenBudgetSnapshot {
  roomUsed: number;
  roomLimit: number;
  globalUsed: number;
  globalLimit: number;
}

export interface TokenReservation {
  readonly estimatedTokens: number;
  commit(actualTokens?: number): void;
}

export class TokenBudgetExceededError extends Error {}

/**
 * Durable, process-safe rolling token accounting. Reservations are stored before
 * provider dispatch, so concurrent calls cannot independently pass the same cap.
 * A crashed request remains conservatively charged until the hourly window ends.
 */
export class TokenBudget {
  private readonly db: Database;
  private readonly listeners = new Set<(room: string, snapshot: TokenBudgetSnapshot) => void>();

  constructor(
    path: string,
    readonly roomLimit = DEFAULT_ROOM_CLANKER_TOKENS_PER_HOUR,
    readonly globalLimit = DEFAULT_GLOBAL_CLANKER_TOKENS_PER_HOUR,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(roomLimit) || roomLimit < 1) throw new Error("room token limit must be a positive integer");
    if (!Number.isSafeInteger(globalLimit) || globalLimit < roomLimit) throw new Error("global token limit must be at least the room token limit");
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS clanker_token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room TEXT NOT NULL,
        tokens INTEGER NOT NULL CHECK(tokens > 0),
        recorded_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS clanker_token_usage_room_time ON clanker_token_usage(room, recorded_at);
      CREATE INDEX IF NOT EXISTS clanker_token_usage_time ON clanker_token_usage(recorded_at);
      CREATE TABLE IF NOT EXISTS clanker_token_reservations (
        id TEXT PRIMARY KEY,
        room TEXT NOT NULL,
        tokens INTEGER NOT NULL CHECK(tokens > 0),
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS clanker_token_reservations_room_expiry ON clanker_token_reservations(room, expires_at);
      CREATE INDEX IF NOT EXISTS clanker_token_reservations_expiry ON clanker_token_reservations(expires_at);
    `);
  }

  subscribe(listener: (room: string, snapshot: TokenBudgetSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reserve(room: string, estimatedTokens: number): TokenReservation {
    const safeRoom = room.trim().slice(0, 64);
    const tokens = Math.max(1, Math.ceil(estimatedTokens));
    if (!safeRoom || !Number.isSafeInteger(tokens)) throw new Error("invalid token reservation");
    const now = this.now();
    const id = crypto.randomUUID();
    this.db.transaction(() => {
      this.prune(now);
      const roomUsed = this.total(now, safeRoom);
      const globalUsed = this.total(now);
      if (tokens > this.roomLimit) throw new TokenBudgetExceededError("clanker request exceeds the room token limit");
      if (roomUsed + tokens > this.roomLimit) throw this.limitError("room", safeRoom, tokens, now);
      if (globalUsed + tokens > this.globalLimit) throw this.limitError("global", safeRoom, tokens, now);
      this.db.query("INSERT INTO clanker_token_reservations (id, room, tokens, expires_at) VALUES (?, ?, ?, ?)").run(id, safeRoom, tokens, now + WINDOW_MS);
    }).immediate();
    this.emit(safeRoom);
    let settled = false;
    return {
      estimatedTokens: tokens,
      commit: (actualTokens?: number) => {
        if (settled) return;
        settled = true;
        const charged = validUsage(actualTokens) ?? tokens;
        const recordedAt = this.now();
        this.db.transaction(() => {
          this.db.query("DELETE FROM clanker_token_reservations WHERE id = ?").run(id);
          this.db.query("INSERT INTO clanker_token_usage (room, tokens, recorded_at) VALUES (?, ?, ?)").run(safeRoom, charged, recordedAt);
          this.prune(recordedAt);
        }).immediate();
        this.emit(safeRoom);
      },
    };
  }

  snapshot(room: string): TokenBudgetSnapshot {
    const now = this.now();
    this.prune(now);
    return { roomUsed: this.total(now, room), roomLimit: this.roomLimit, globalUsed: this.total(now), globalLimit: this.globalLimit };
  }

  renameRoom(previousName: string, name: string): void {
    if (previousName === name) return;
    this.db.transaction(() => {
      this.db.query("UPDATE clanker_token_usage SET room = ? WHERE room = ?").run(name, previousName);
      this.db.query("UPDATE clanker_token_reservations SET room = ? WHERE room = ?").run(name, previousName);
    }).immediate();
    this.emit(name);
  }

  private total(now: number, room?: string): number {
    const cutoff = now - WINDOW_MS;
    const usage = room
      ? this.db.query("SELECT COALESCE(SUM(tokens), 0) AS total FROM clanker_token_usage WHERE room = ? AND recorded_at >= ?").get(room, cutoff) as TotalRow
      : this.db.query("SELECT COALESCE(SUM(tokens), 0) AS total FROM clanker_token_usage WHERE recorded_at >= ?").get(cutoff) as TotalRow;
    const reserved = room
      ? this.db.query("SELECT COALESCE(SUM(tokens), 0) AS total FROM clanker_token_reservations WHERE room = ? AND expires_at > ?").get(room, now) as TotalRow
      : this.db.query("SELECT COALESCE(SUM(tokens), 0) AS total FROM clanker_token_reservations WHERE expires_at > ?").get(now) as TotalRow;
    return Number(usage.total) + Number(reserved.total);
  }

  private prune(now: number): void {
    this.db.query("DELETE FROM clanker_token_usage WHERE recorded_at < ?").run(now - WINDOW_MS);
    this.db.query("DELETE FROM clanker_token_reservations WHERE expires_at <= ?").run(now);
  }

  private limitError(scope: "room" | "global", room: string, requested: number, now: number): TokenBudgetExceededError {
    const roomFilter = scope === "room" ? "room = ? AND " : "";
    const params = scope === "room" ? [room, now - WINDOW_MS, room, now] : [now - WINDOW_MS, now];
    const usageTimes = this.db.query(`SELECT tokens, recorded_at + ${WINDOW_MS} AS available_at FROM clanker_token_usage WHERE ${roomFilter}recorded_at >= ? ORDER BY recorded_at`).all(...(scope === "room" ? params.slice(0, 2) : params.slice(0, 1))) as Array<{ tokens: number; available_at: number }>;
    const reservationTimes = this.db.query(`SELECT tokens, expires_at AS available_at FROM clanker_token_reservations WHERE ${roomFilter}expires_at > ? ORDER BY expires_at`).all(...(scope === "room" ? params.slice(2) : params.slice(1))) as Array<{ tokens: number; available_at: number }>;
    const entries = usageTimes.concat(reservationTimes).sort((left, right) => left.available_at - right.available_at);
    const limit = scope === "room" ? this.roomLimit : this.globalLimit;
    let used = this.total(now, scope === "room" ? room : undefined);
    let next = now + WINDOW_MS;
    for (let index = 0; index < entries.length;) {
      next = entries[index]!.available_at;
      while (entries[index]?.available_at === next) used -= entries[index++]!.tokens;
      if (used + requested <= limit) break;
    }
    const waitMinutes = Math.max(1, Math.ceil((next - now) / 60_000));
    const label = scope === "room" ? "room clanker token limit" : "global clanker token limit";
    return new TokenBudgetExceededError(`${label} reached · retry in ${waitMinutes}m`);
  }

  private emit(room: string): void {
    if (!this.listeners.size) return;
    const snapshot = this.snapshot(room);
    for (const listener of this.listeners) listener(room, snapshot);
  }
}

export function estimateProviderTokens(serializedRequest: string, maxOutputTokens: number): number {
  // UTF-8 bytes are a deliberately conservative upper bound for current BPE tokenizers.
  return Buffer.byteLength(serializedRequest, "utf8") + Math.max(0, Math.ceil(maxOutputTokens));
}

export function providerTokenUsage(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  return validUsage((value as { usage?: { total_tokens?: unknown } }).usage?.total_tokens);
}

function validUsage(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
