import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

export type PrincipalKind = "user" | "anonymous" | "agent" | "system";
export type RoomRole = "owner" | "admin" | "contributor" | "viewer";
export type RoomVisibility = "public" | "private";
export type ContributionPolicy = "members" | "admins" | "disabled";
export type AgentMode = "passive" | "explicit" | "disabled";

export interface Principal {
  id: string;
  kind: PrincipalKind;
  handle: string;
  displayName: string;
  authenticated: boolean;
  keyFingerprint?: string;
  sshAlgorithm?: string;
  sshKeyBlob?: Buffer;
  requestedHandle?: string;
}

export interface RoomPolicy {
  name: string;
  ownerId: string;
  ownerHandle: string;
  visibility: RoomVisibility;
  contributions: ContributionPolicy;
  agentMode: AgentMode;
}

interface UserRow { id: string; handle: string; display_name: string; status: string }
interface RoomRow { name: string; owner_user_id: string; visibility: RoomVisibility; contribution_policy: ContributionPolicy; agent_mode: AgentMode }

const ROLE_WEIGHT: Record<RoomRole, number> = { viewer: 0, contributor: 1, admin: 2, owner: 3 };

export class AccountStore {
  private readonly db: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        handle TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS identities (
        provider TEXT NOT NULL,
        provider_subject TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        email TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(provider, provider_subject)
      );
      CREATE TABLE IF NOT EXISTS ssh_keys (
        fingerprint TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        algorithm TEXT NOT NULL,
        key_blob BLOB NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS rooms (
        name TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL REFERENCES users(id),
        visibility TEXT NOT NULL CHECK(visibility IN ('public','private')),
        contribution_policy TEXT NOT NULL CHECK(contribution_policy IN ('members','admins','disabled')),
        agent_mode TEXT NOT NULL CHECK(agent_mode IN ('passive','explicit','disabled')),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS room_memberships (
        room_name TEXT NOT NULL REFERENCES rooms(name) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('owner','admin','contributor','viewer')),
        created_at INTEGER NOT NULL,
        revoked_at INTEGER,
        PRIMARY KEY(room_name, user_id)
      );
      CREATE TABLE IF NOT EXISTS invites (
        id TEXT PRIMARY KEY,
        room_name TEXT NOT NULL REFERENCES rooms(name) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('admin','contributor','viewer')),
        token_hash TEXT NOT NULL UNIQUE,
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        max_uses INTEGER NOT NULL DEFAULT 1,
        uses INTEGER NOT NULL DEFAULT 0,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS web_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS agent_credentials (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        room_name TEXT NOT NULL REFERENCES rooms(name) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        scopes TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_name TEXT,
        actor_principal_id TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
    `);
  }

  ensureLocalOwner(handle: string, displayName = handle): Principal {
    const clean = normalizeHandle(handle);
    let row = this.db.query("SELECT id, handle, display_name, status FROM users WHERE handle = ?").get(clean) as UserRow | null;
    if (!row) {
      const id = crypto.randomUUID();
      this.db.query("INSERT INTO users(id, handle, display_name, created_at) VALUES (?, ?, ?, ?)").run(id, clean, displayName.slice(0, 80), Date.now());
      row = { id, handle: clean, display_name: displayName.slice(0, 80), status: "active" };
    }
    return userPrincipal(row);
  }

  ensureRoom(name: string, owner: Principal, defaults: Pick<RoomPolicy, "visibility" | "contributions" | "agentMode">): RoomPolicy {
    this.db.query("INSERT OR IGNORE INTO rooms(name, owner_user_id, visibility, contribution_policy, agent_mode, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(name, owner.id, defaults.visibility, defaults.contributions, defaults.agentMode, Date.now());
    this.db.query("INSERT OR IGNORE INTO room_memberships(room_name, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(name, owner.id, Date.now());
    return this.roomPolicy(name)!;
  }

  roomPolicy(name: string): RoomPolicy | undefined {
    const room = this.db.query("SELECT name, owner_user_id, visibility, contribution_policy, agent_mode FROM rooms WHERE name = ?").get(name) as RoomRow | null;
    if (!room) return undefined;
    const owner = this.db.query("SELECT id, handle, display_name, status FROM users WHERE id = ?").get(room.owner_user_id) as UserRow;
    return { name: room.name, ownerId: room.owner_user_id, ownerHandle: owner.handle, visibility: room.visibility, contributions: room.contribution_policy, agentMode: room.agent_mode };
  }

  updateRoomPolicy(actor: Principal, roomName: string, changes: Partial<Pick<RoomPolicy, "visibility" | "contributions" | "agentMode">>): RoomPolicy {
    if (!this.isAdmin(actor, roomName)) throw new Error("room administration requires an admin");
    const current = this.roomPolicy(roomName);
    if (!current) throw new Error("room not found");
    const visibility = changes.visibility ?? current.visibility;
    const contributions = changes.contributions ?? current.contributions;
    const agentMode = changes.agentMode ?? current.agentMode;
    this.db.query("UPDATE rooms SET visibility = ?, contribution_policy = ?, agent_mode = ? WHERE name = ?").run(visibility, contributions, agentMode, roomName);
    this.audit(actor, roomName, "room.policy.update", JSON.stringify({ visibility, contributions, agentMode }));
    return this.roomPolicy(roomName)!;
  }

  enrollSshKey(userId: string, algorithm: string, keyBlob: Buffer, label = ""): string {
    const fingerprint = sshFingerprint(keyBlob);
    this.db.query("INSERT OR IGNORE INTO ssh_keys(fingerprint, user_id, algorithm, key_blob, label, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(fingerprint, userId, algorithm, keyBlob, label.slice(0, 120), Date.now());
    return fingerprint;
  }

  enrollOpenSshKey(userId: string, value: string, fallbackLabel = "bootstrap key"): string {
    const [algorithm, encoded, ...comment] = value.trim().split(/\s+/);
    if (!algorithm?.startsWith("ssh-") || !encoded) throw new Error("invalid OpenSSH public key");
    return this.enrollSshKey(userId, algorithm, Buffer.from(encoded, "base64"), comment.join(" ") || fallbackLabel);
  }

  principalForKey(algorithm: string, keyBlob: Buffer, requestedHandle = "guest"): Principal {
    const fingerprint = sshFingerprint(keyBlob);
    const row = this.db.query(`SELECT u.id, u.handle, u.display_name, u.status
      FROM ssh_keys k JOIN users u ON u.id = k.user_id
      WHERE k.fingerprint = ? AND k.algorithm = ? AND k.revoked_at IS NULL`).get(fingerprint, algorithm) as UserRow | null;
    if (!row || row.status !== "active") return anonymousPrincipal(fingerprint, requestedHandle, algorithm, keyBlob);
    this.db.query("UPDATE ssh_keys SET last_used_at = ? WHERE fingerprint = ?").run(Date.now(), fingerprint);
    return { ...userPrincipal(row), keyFingerprint: fingerprint, sshAlgorithm: algorithm, sshKeyBlob: keyBlob };
  }

  roleFor(principal: Principal, roomName: string): RoomRole | undefined {
    if (!principal.authenticated || principal.kind !== "user") return undefined;
    const row = this.db.query("SELECT role FROM room_memberships WHERE room_name = ? AND user_id = ? AND revoked_at IS NULL").get(roomName, principal.id) as { role: RoomRole } | null;
    return row?.role;
  }

  canView(principal: Principal, roomName: string): boolean {
    const policy = this.roomPolicy(roomName);
    return Boolean(policy && (policy.visibility === "public" || this.roleFor(principal, roomName)));
  }

  canContribute(principal: Principal, roomName: string): boolean {
    const policy = this.roomPolicy(roomName);
    const role = this.roleFor(principal, roomName);
    if (!policy || !role || policy.contributions === "disabled") return false;
    return policy.contributions === "admins" ? ROLE_WEIGHT[role] >= ROLE_WEIGHT.admin : ROLE_WEIGHT[role] >= ROLE_WEIGHT.contributor;
  }

  canInvokeAgent(principal: Principal, roomName: string): boolean {
    const policy = this.roomPolicy(roomName);
    return Boolean(policy && policy.agentMode !== "disabled" && this.canContribute(principal, roomName));
  }

  canPromote(principal: Principal, roomName: string): boolean { return this.roleFor(principal, roomName) === "owner"; }
  isAdmin(principal: Principal, roomName: string): boolean {
    const role = this.roleFor(principal, roomName);
    return Boolean(role && ROLE_WEIGHT[role] >= ROLE_WEIGHT.admin);
  }

  createInvite(actor: Principal, roomName: string, role: Exclude<RoomRole, "owner">, ttlMs = 24 * 60 * 60 * 1_000): string {
    if (!this.isAdmin(actor, roomName)) throw new Error("room administration requires an admin");
    const token = randomBytes(18).toString("base64url");
    this.db.query("INSERT INTO invites(id, room_name, role, token_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), roomName, role, tokenHash(token), actor.id, Date.now(), Date.now() + Math.max(60_000, ttlMs));
    this.audit(actor, roomName, "invite.create", role);
    return token;
  }

  redeemInvite(principal: Principal, token: string): { roomName: string; role: RoomRole } {
    if (!principal.authenticated || principal.kind !== "user") throw new Error("sign in before redeeming an invite");
    const row = this.db.query("SELECT id, room_name, role, expires_at, max_uses, uses, revoked_at FROM invites WHERE token_hash = ?").get(tokenHash(token)) as { id: string; room_name: string; role: RoomRole; expires_at: number; max_uses: number; uses: number; revoked_at?: number } | null;
    if (!row || row.revoked_at || row.expires_at <= Date.now() || row.uses >= row.max_uses) throw new Error("invite is invalid or expired");
    const existing = this.roleFor(principal, row.room_name);
    const grantedRole = existing && ROLE_WEIGHT[existing] >= ROLE_WEIGHT[row.role] ? existing : row.role;
    this.db.transaction(() => {
      this.db.query("INSERT INTO room_memberships(room_name, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(room_name, user_id) DO UPDATE SET role = excluded.role, revoked_at = NULL")
        .run(row.room_name, principal.id, grantedRole, Date.now());
      this.db.query("UPDATE invites SET uses = uses + 1 WHERE id = ?").run(row.id);
    })();
    this.audit(principal, row.room_name, "invite.redeem", grantedRole);
    return { roomName: row.room_name, role: grantedRole };
  }

  redeem(principal: Principal, token: string): { principal: Principal; roomName: string; role: RoomRole } {
    if (!principal.authenticated) return this.redeemSshInvite(principal, token);
    return { principal, ...this.redeemInvite(principal, token) };
  }

  redeemSshInvite(principal: Principal, token: string): { principal: Principal; roomName: string; role: RoomRole } {
    if (principal.authenticated || principal.kind !== "anonymous" || !principal.sshAlgorithm || !principal.sshKeyBlob || !principal.keyFingerprint) throw new Error("an unregistered SSH key is required");
    if (sshFingerprint(principal.sshKeyBlob) !== principal.keyFingerprint) throw new Error("SSH key identity mismatch");
    const invite = this.db.query("SELECT id, room_name, role, expires_at, max_uses, uses, revoked_at FROM invites WHERE token_hash = ?").get(tokenHash(token)) as { id: string; room_name: string; role: RoomRole; expires_at: number; max_uses: number; uses: number; revoked_at?: number } | null;
    if (!invite || invite.revoked_at || invite.expires_at <= Date.now() || invite.uses >= invite.max_uses) throw new Error("invite is invalid or expired");
    const base = normalizeHandle(principal.requestedHandle ?? "user");
    let handle = base;
    let suffix = 1;
    while (this.db.query("SELECT 1 AS found FROM users WHERE handle = ?").get(handle)) handle = `${base.slice(0, 24)}-${suffix++}`;
    const userId = crypto.randomUUID();
    const now = Date.now();
    const fingerprint = principal.keyFingerprint;
    const algorithm = principal.sshAlgorithm;
    const keyBlob = principal.sshKeyBlob;
    this.db.transaction(() => {
      this.db.query("INSERT INTO users(id, handle, display_name, created_at) VALUES (?, ?, ?, ?)").run(userId, handle, handle, now);
      this.db.query("INSERT INTO ssh_keys(fingerprint, user_id, algorithm, key_blob, label, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(fingerprint, userId, algorithm, keyBlob, "invite enrollment", now, now);
      this.db.query("INSERT INTO room_memberships(room_name, user_id, role, created_at) VALUES (?, ?, ?, ?)").run(invite.room_name, userId, invite.role, now);
      this.db.query("UPDATE invites SET uses = uses + 1 WHERE id = ? AND uses < max_uses").run(invite.id);
    })();
    const authenticated: Principal = { id: userId, kind: "user", handle, displayName: handle, authenticated: true, keyFingerprint: fingerprint, sshAlgorithm: algorithm, sshKeyBlob: keyBlob };
    this.audit(authenticated, invite.room_name, "invite.redeem.ssh", invite.role);
    return { principal: authenticated, roomName: invite.room_name, role: invite.role };
  }

  linkIdentity(userId: string, provider: string, subject: string, email?: string): void {
    this.db.query("INSERT INTO identities(provider, provider_subject, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(provider.slice(0, 40), subject.slice(0, 255), userId, email?.slice(0, 320) ?? null, Date.now());
  }

  audit(actor: Principal, roomName: string | undefined, action: string, target = ""): void {
    this.db.query("INSERT INTO audit_events(room_name, actor_principal_id, action, target, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(roomName ?? null, actor.id, action.slice(0, 80), target.slice(0, 500), Date.now());
  }

  close(): void { this.db.close(); }
}

export function sshFingerprint(keyBlob: Buffer): string {
  return `SHA256:${createHash("sha256").update(keyBlob).digest("base64").replace(/=+$/, "")}`;
}

export function anonymousPrincipal(fingerprint: string, requestedHandle = "guest", sshAlgorithm?: string, sshKeyBlob?: Buffer): Principal {
  const suffix = fingerprint.replace(/^SHA256:/, "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 6).toLowerCase();
  return { id: `anonymous:${fingerprint}`, kind: "anonymous", handle: `guest-${suffix || normalizeHandle(requestedHandle)}`, displayName: "Anonymous", authenticated: false, keyFingerprint: fingerprint, sshAlgorithm, sshKeyBlob, requestedHandle: normalizeHandle(requestedHandle) };
}

function userPrincipal(row: UserRow): Principal {
  return { id: row.id, kind: "user", handle: row.handle, displayName: row.display_name, authenticated: true };
}

function normalizeHandle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]/g, "").slice(0, 32) || "user";
}

function tokenHash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
