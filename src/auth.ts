import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { Database } from "bun:sqlite";

export type PrincipalKind = "user" | "anonymous" | "clanker" | "system";
export type RoomRole = "owner" | "admin" | "contributor" | "viewer";
export type SiteRole = "admin" | "member";
export type AccountPlan = "free" | "pro";
export type RoomVisibility = "public" | "private";
export type ContributionPolicy = "members" | "authenticated" | "admins" | "disabled";
export type ClankerMode = "passive" | "explicit" | "disabled";

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
  clankerMode: ClankerMode;
  system: boolean;
}

export interface ArchivedRoom extends RoomPolicy {
  archiveId: string;
  storageName: string;
  archivedAt: number;
}

export interface AccountProfile {
  siteRole: SiteRole;
  plan: AccountPlan;
  ownedRooms: number;
  roomLimit: number;
}

export interface AccountSettings extends AccountProfile {
  handle: string;
  displayName: string;
  providers: string[];
  sshKeys: number;
}

export interface WebSession {
  sessionToken: string;
  expiresAt: number;
}

export interface MountCredential {
  username: string;
  password: string;
  roomName: string;
  expiresAt: number;
  readOnly: boolean;
}

export type RoomDomainStatus = "pending" | "active";

export interface RoomDomain {
  hostname: string;
  roomName: string;
  status: RoomDomainStatus;
  challengeName: string;
  challengeValue: string;
  createdAt: number;
  lastCheckedAt?: number;
  verifiedAt?: number;
}

export interface SshPairing {
  code: string;
  expiresAt: number;
  roomName?: string;
}

export interface AccountLink {
  code: string;
  expiresAt: number;
}

export interface IdentityProfile {
  provider: string;
  subject: string;
  handle: string;
  displayName?: string;
  email?: string;
}

export interface OAuthFlow {
  state: string;
  browserToken: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  expiresAt: number;
  linkUserId?: string;
}

interface UserRow { id: string; handle: string; display_name: string; status: string }
interface RoomRow { name: string; owner_user_id: string; visibility: RoomVisibility; contribution_policy: Exclude<ContributionPolicy, "authenticated">; authenticated_contributions: number; clanker_mode: ClankerMode; system: number; created_at?: number }
interface ArchivedRoomRow { id: string; original_name: string; owner_user_id: string; owner_handle: string; visibility: RoomVisibility; contribution_policy: Exclude<ContributionPolicy, "authenticated">; authenticated_contributions: number; clanker_mode: ClankerMode; room_created_at: number; storage_name: string; archived_at: number }
interface InviteRow { id: string; room_name: string; role: RoomRole; expires_at: number; max_uses: number; uses: number; revoked_at?: number }
interface RoomDomainRow { hostname: string; room_name: string; verification_token: string; status: RoomDomainStatus; created_at: number; last_checked_at?: number; verified_at?: number }

const ROLE_WEIGHT: Record<RoomRole, number> = { viewer: 0, contributor: 1, admin: 2, owner: 3 };
export const ACCOUNT_ROOM_LIMITS = { free: 5, pro: 25, siteAdmin: 100 } as const;
export const ACCOUNT_ROOM_ARCHIVE_LIMITS = { free: 10, pro: 50, siteAdmin: 200 } as const;
const ROOM_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const ROOM_DOMAIN_LIMIT = 5;

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
        site_role TEXT NOT NULL DEFAULT 'member' CHECK(site_role IN ('admin','member')),
        plan TEXT NOT NULL DEFAULT 'free' CHECK(plan IN ('free','pro')),
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
        authenticated_contributions INTEGER NOT NULL DEFAULT 0 CHECK(authenticated_contributions IN (0,1)),
        clanker_mode TEXT NOT NULL CHECK(clanker_mode IN ('passive','explicit','disabled')),
        system INTEGER NOT NULL DEFAULT 0 CHECK(system IN (0,1)),
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
      CREATE TABLE IF NOT EXISTS room_preferences (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        room_name TEXT NOT NULL REFERENCES rooms(name) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, room_name)
      );
      CREATE TABLE IF NOT EXISTS room_archives (
        id TEXT PRIMARY KEY,
        original_name TEXT NOT NULL,
        owner_user_id TEXT NOT NULL REFERENCES users(id),
        visibility TEXT NOT NULL CHECK(visibility IN ('public','private')),
        contribution_policy TEXT NOT NULL CHECK(contribution_policy IN ('members','admins','disabled')),
        authenticated_contributions INTEGER NOT NULL DEFAULT 0 CHECK(authenticated_contributions IN (0,1)),
        clanker_mode TEXT NOT NULL CHECK(clanker_mode IN ('passive','explicit','disabled')),
        room_created_at INTEGER NOT NULL,
        storage_name TEXT NOT NULL UNIQUE,
        archived_at INTEGER NOT NULL,
        archived_by_principal_id TEXT NOT NULL,
        restored_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS archived_room_memberships (
        archive_id TEXT NOT NULL REFERENCES room_archives(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('owner','admin','contributor','viewer')),
        created_at INTEGER NOT NULL,
        revoked_at INTEGER,
        PRIMARY KEY(archive_id, user_id)
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
      CREATE TABLE IF NOT EXISTS ssh_pairings (
        id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL UNIQUE,
        fingerprint TEXT NOT NULL,
        algorithm TEXT NOT NULL,
        key_blob BLOB NOT NULL,
        requested_handle TEXT NOT NULL DEFAULT '',
        requested_from TEXT NOT NULL DEFAULT '',
        invite_id TEXT REFERENCES invites(id),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_flows (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        state_hash TEXT NOT NULL UNIQUE,
        browser_hash TEXT NOT NULL,
        nonce TEXT NOT NULL,
        code_verifier TEXT NOT NULL,
        return_to TEXT NOT NULL DEFAULT '/',
        link_user_id TEXT REFERENCES users(id),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS account_links (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS clanker_credentials (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        room_name TEXT NOT NULL REFERENCES rooms(name) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        scopes TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS mount_credentials (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        room_name TEXT NOT NULL REFERENCES rooms(name) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS room_domains (
        hostname TEXT PRIMARY KEY,
        room_name TEXT NOT NULL REFERENCES rooms(name) ON DELETE CASCADE,
        verification_token TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active')),
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at INTEGER NOT NULL,
        last_checked_at INTEGER,
        verified_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS room_domains_room ON room_domains(room_name);
      CREATE INDEX IF NOT EXISTS room_domains_active ON room_domains(hostname, status);
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_name TEXT,
        actor_principal_id TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS server_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.db.transaction(() => {
      const columns = (table: string) => new Set(
        (this.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name),
      );
      const rooms = columns("rooms");
      if (rooms.has("agent_mode") && !rooms.has("clanker_mode")) {
        this.db.exec("ALTER TABLE rooms RENAME COLUMN agent_mode TO clanker_mode");
      }
      const archives = columns("room_archives");
      if (archives.has("agent_mode") && !archives.has("clanker_mode")) {
        this.db.exec("ALTER TABLE room_archives RENAME COLUMN agent_mode TO clanker_mode");
      }
      const hasLegacyCredentials = Boolean(this.db.query(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'agent_credentials'",
      ).get());
      if (hasLegacyCredentials) {
        this.db.exec(`
          INSERT OR IGNORE INTO clanker_credentials(id, owner_user_id, room_name, token_hash, scopes, created_at, expires_at, revoked_at)
          SELECT id, owner_user_id, room_name, token_hash, scopes, created_at, expires_at, revoked_at FROM agent_credentials;
          DROP TABLE agent_credentials;
        `);
      }
    })();
    const userColumns = new Set((this.db.query("PRAGMA table_info(users)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!userColumns.has("site_role")) this.db.exec("ALTER TABLE users ADD COLUMN site_role TEXT NOT NULL DEFAULT 'member' CHECK(site_role IN ('admin','member'))");
    if (!userColumns.has("plan")) this.db.exec("ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free' CHECK(plan IN ('free','pro'))");
    const roomColumns = new Set((this.db.query("PRAGMA table_info(rooms)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!roomColumns.has("system")) this.db.exec("ALTER TABLE rooms ADD COLUMN system INTEGER NOT NULL DEFAULT 0 CHECK(system IN (0,1))");
    if (!roomColumns.has("authenticated_contributions")) this.db.exec("ALTER TABLE rooms ADD COLUMN authenticated_contributions INTEGER NOT NULL DEFAULT 0 CHECK(authenticated_contributions IN (0,1))");
    const archiveColumns = new Set((this.db.query("PRAGMA table_info(room_archives)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!archiveColumns.has("authenticated_contributions")) this.db.exec("ALTER TABLE room_archives ADD COLUMN authenticated_contributions INTEGER NOT NULL DEFAULT 0 CHECK(authenticated_contributions IN (0,1))");
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

  ensureRoom(name: string, owner: Principal, defaults: Pick<RoomPolicy, "visibility" | "contributions" | "clankerMode">): RoomPolicy {
    validateRoomName(name);
    const contribution = storedContribution(defaults.contributions);
    this.db.query("INSERT OR IGNORE INTO rooms(name, owner_user_id, visibility, contribution_policy, authenticated_contributions, clanker_mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(name, owner.id, defaults.visibility, contribution.policy, contribution.authenticated, defaults.clankerMode, Date.now());
    this.db.query("INSERT OR IGNORE INTO room_memberships(room_name, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(name, owner.id, Date.now());
    return this.roomPolicy(name)!;
  }

  ensureSystemRoom(name: string, owner: Principal, defaults: Pick<RoomPolicy, "visibility" | "contributions" | "clankerMode">): RoomPolicy {
    validateRoomName(name);
    const contribution = storedContribution(defaults.contributions);
    this.db.transaction(() => {
      this.db.query("INSERT OR IGNORE INTO rooms(name, owner_user_id, visibility, contribution_policy, authenticated_contributions, clanker_mode, system, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)")
        .run(name, owner.id, defaults.visibility, contribution.policy, contribution.authenticated, defaults.clankerMode, Date.now());
      this.db.query("UPDATE rooms SET visibility = ?, contribution_policy = ?, authenticated_contributions = ?, clanker_mode = ?, system = 1 WHERE name = ?")
        .run(defaults.visibility, contribution.policy, contribution.authenticated, defaults.clankerMode, name);
      this.db.query("INSERT OR IGNORE INTO room_memberships(room_name, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(name, owner.id, Date.now());
    })();
    return this.roomPolicy(name)!;
  }

  ensureSystemMembership(principal: Principal, roomName: string): void {
    if (!principal.authenticated || principal.kind !== "user") return;
    const policy = this.roomPolicy(roomName);
    if (!policy?.system) throw new Error("system room not found");
    this.db.query(`INSERT INTO room_memberships(room_name, user_id, role, created_at)
      VALUES (?, ?, 'contributor', ?)
      ON CONFLICT(room_name, user_id) DO UPDATE SET revoked_at = NULL`).run(roomName, principal.id, Date.now());
  }

  seedRoomsOnce(owner: Principal, rooms: Array<{ name: string } & Pick<RoomPolicy, "visibility" | "contributions" | "clankerMode">>): void {
    if (this.db.query("SELECT 1 AS found FROM server_settings WHERE key = 'rooms.seeded'").get()) return;
    if (!this.listRooms().length) for (const { name, ...defaults } of rooms) this.ensureRoom(name, owner, defaults);
    this.db.query("INSERT OR IGNORE INTO server_settings(key, value) VALUES ('rooms.seeded', '1')").run();
  }

  ensureSiteAdmin(principal: Principal): void {
    if (!principal.authenticated || principal.kind !== "user") throw new Error("an authenticated account is required");
    const result = this.db.query("UPDATE users SET site_role = 'admin' WHERE id = ? AND site_role != 'admin'").run(principal.id);
    if (result.changes) this.audit(principal, undefined, "account.site-role", "admin");
  }

  accountProfile(principal: Principal): AccountProfile {
    if (!principal.authenticated || principal.kind !== "user") return { siteRole: "member", plan: "free", ownedRooms: 0, roomLimit: 0 };
    const row = this.db.query("SELECT site_role, plan FROM users WHERE id = ? AND status = 'active'").get(principal.id) as { site_role: SiteRole; plan: AccountPlan } | null;
    if (!row) return { siteRole: "member", plan: "free", ownedRooms: 0, roomLimit: 0 };
    const ownedRooms = this.ownedRoomCount(principal);
    return { siteRole: row.site_role, plan: row.plan, ownedRooms, roomLimit: row.site_role === "admin" ? ACCOUNT_ROOM_LIMITS.siteAdmin : ACCOUNT_ROOM_LIMITS[row.plan] };
  }

  accountSettings(principal: Principal): AccountSettings {
    if (!principal.authenticated || principal.kind !== "user") throw new Error("sign in to view account settings");
    const row = this.db.query("SELECT handle, display_name FROM users WHERE id = ? AND status = 'active'").get(principal.id) as Pick<UserRow, "handle" | "display_name"> | null;
    if (!row) throw new Error("account is unavailable");
    const profile = this.accountProfile(principal);
    const providers = (this.db.query("SELECT provider FROM identities WHERE user_id = ? ORDER BY provider").all(principal.id) as Array<{ provider: string }>).map(({ provider }) => provider);
    const sshKeys = (this.db.query("SELECT COUNT(*) AS count FROM ssh_keys WHERE user_id = ? AND revoked_at IS NULL").get(principal.id) as { count: number }).count;
    return { ...profile, handle: row.handle, displayName: row.display_name, providers, sshKeys };
  }

  updateDisplayName(principal: Principal, value: string): Principal {
    if (!principal.authenticated || principal.kind !== "user") throw new Error("sign in to update account settings");
    const displayName = value.replace(/[\r\n\0]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!displayName) throw new Error("display name is required");
    const result = this.db.query("UPDATE users SET display_name = ? WHERE id = ? AND status = 'active'").run(displayName, principal.id);
    if (!result.changes) throw new Error("account is unavailable");
    this.audit(principal, undefined, "account.display-name");
    return { ...principal, displayName };
  }

  isSiteAdmin(principal: Principal): boolean {
    if (!principal.authenticated || principal.kind !== "user") return false;
    return Boolean(this.db.query("SELECT 1 AS found FROM users WHERE id = ? AND status = 'active' AND site_role = 'admin'").get(principal.id));
  }

  listRooms(): RoomPolicy[] {
    const rows = this.db.query("SELECT name FROM rooms ORDER BY system DESC, created_at, name").all() as Array<{ name: string }>;
    return rows.map((row) => this.roomPolicy(row.name)!).filter(Boolean);
  }

  ownedRoomCount(principal: Principal): number {
    if (!principal.authenticated || principal.kind !== "user") return 0;
    return (this.db.query("SELECT COUNT(*) AS count FROM rooms WHERE owner_user_id = ? AND system = 0").get(principal.id) as { count: number }).count;
  }

  ownedRoomNames(principal: Principal): string[] {
    if (!principal.authenticated || principal.kind !== "user") return [];
    return (this.db.query("SELECT name FROM rooms WHERE owner_user_id = ? AND system = 0 ORDER BY created_at, name").all(principal.id) as Array<{ name: string }>).map((row) => row.name);
  }

  createRoom(actor: Principal, name: string, defaults: Pick<RoomPolicy, "visibility" | "contributions" | "clankerMode"> = { visibility: "public", contributions: "members", clankerMode: "passive" }): RoomPolicy {
    if (!actor.authenticated || actor.kind !== "user") throw new Error("sign in before creating a room");
    validateRoomName(name);
    if (this.roomPolicy(name)) throw new Error("room name is already in use");
    const profile = this.accountProfile(actor);
    if (profile.ownedRooms >= profile.roomLimit) throw new Error(`${profile.plan} accounts can own at most ${profile.roomLimit} rooms`);
    const contribution = storedContribution(defaults.contributions);
    this.db.transaction(() => {
      this.db.query("INSERT INTO rooms(name, owner_user_id, visibility, contribution_policy, authenticated_contributions, clanker_mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(name, actor.id, defaults.visibility, contribution.policy, contribution.authenticated, defaults.clankerMode, Date.now());
      this.db.query("INSERT INTO room_memberships(room_name, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(name, actor.id, Date.now());
    })();
    this.audit(actor, name, "room.create");
    return this.roomPolicy(name)!;
  }

  renameRoom(actor: Principal, oldName: string, newName: string): RoomPolicy {
    validateRoomName(newName);
    if (!this.canManageRoom(actor, oldName)) throw new Error("renaming a room requires its owner or a site admin");
    if (this.roomPolicy(newName)) throw new Error("room name is already in use");
    const current = this.roomPolicy(oldName);
    if (!current) throw new Error("room not found");
    if (current.system) throw new Error("system rooms cannot be renamed");
    this.db.transaction(() => {
      this.db.query(`INSERT INTO rooms(name, owner_user_id, visibility, contribution_policy, authenticated_contributions, clanker_mode, created_at)
        SELECT ?, owner_user_id, visibility, contribution_policy, authenticated_contributions, clanker_mode, created_at FROM rooms WHERE name = ?`).run(newName, oldName);
      this.db.query(`INSERT INTO room_memberships(room_name, user_id, role, created_at, revoked_at)
        SELECT ?, user_id, role, created_at, revoked_at FROM room_memberships WHERE room_name = ?`).run(newName, oldName);
      this.db.query("UPDATE invites SET room_name = ? WHERE room_name = ?").run(newName, oldName);
      this.db.query("UPDATE clanker_credentials SET room_name = ? WHERE room_name = ?").run(newName, oldName);
      this.db.query("UPDATE mount_credentials SET room_name = ? WHERE room_name = ?").run(newName, oldName);
      this.db.query("UPDATE room_domains SET room_name = ? WHERE room_name = ?").run(newName, oldName);
      this.db.query("UPDATE room_preferences SET room_name = ? WHERE room_name = ?").run(newName, oldName);
      this.db.query("UPDATE audit_events SET room_name = ? WHERE room_name = ?").run(newName, oldName);
      this.db.query("DELETE FROM rooms WHERE name = ?").run(oldName);
    })();
    this.audit(actor, newName, "room.rename", oldName);
    return this.roomPolicy(newName)!;
  }

  deleteRoom(actor: Principal, name: string): void {
    if (!this.canManageRoom(actor, name)) throw new Error("deleting a room requires its owner or a site admin");
    const current = this.roomPolicy(name);
    if (!current) throw new Error("room not found");
    if (current.system) throw new Error("system rooms cannot be deleted");
    this.audit(actor, name, "room.delete");
    this.db.query("DELETE FROM rooms WHERE name = ?").run(name);
  }

  archiveRoom(actor: Principal, name: string, archiveId: string, storageName: string): ArchivedRoom {
    if (!this.canManageRoom(actor, name)) throw new Error("deleting a room requires its owner or a site admin");
    if (!/^[0-9a-f-]{36}$/.test(archiveId) || !/^[0-9]+-[0-9a-f]{8}-[a-z0-9][a-z0-9-]{0,31}$/.test(storageName)) throw new Error("room archive identity is invalid");
    const current = this.db.query("SELECT name, owner_user_id, visibility, contribution_policy, authenticated_contributions, clanker_mode, system, created_at FROM rooms WHERE name = ?").get(name) as RoomRow | null;
    if (!current) throw new Error("room not found");
    if (current.system) throw new Error("system rooms cannot be deleted");
    const owner = this.db.query("SELECT site_role, plan FROM users WHERE id = ? AND status = 'active'").get(current.owner_user_id) as { site_role: SiteRole; plan: AccountPlan } | null;
    if (!owner) throw new Error("room owner not found");
    const archiveLimit = owner.site_role === "admin" ? ACCOUNT_ROOM_ARCHIVE_LIMITS.siteAdmin : ACCOUNT_ROOM_ARCHIVE_LIMITS[owner.plan];
    const archiveCount = (this.db.query("SELECT COUNT(*) AS count FROM room_archives WHERE owner_user_id = ? AND restored_at IS NULL").get(current.owner_user_id) as { count: number }).count;
    if (archiveCount >= archiveLimit) throw new Error(`archive limit reached · restore an archived room before deleting another`);
    const archivedAt = Date.now();
    this.db.transaction(() => {
      this.db.query(`INSERT INTO room_archives(id, original_name, owner_user_id, visibility, contribution_policy, authenticated_contributions, clanker_mode, room_created_at, storage_name, archived_at, archived_by_principal_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(archiveId, name, current.owner_user_id, current.visibility, current.contribution_policy, current.authenticated_contributions, current.clanker_mode, current.created_at ?? archivedAt, storageName, archivedAt, actor.id);
      this.db.query(`INSERT INTO archived_room_memberships(archive_id, user_id, role, created_at, revoked_at)
        SELECT ?, user_id, role, created_at, revoked_at FROM room_memberships WHERE room_name = ?`).run(archiveId, name);
      this.audit(actor, name, "room.archive", archiveId);
      this.db.query("DELETE FROM rooms WHERE name = ?").run(name);
    })();
    return this.archivedRoomFromRow({ id: archiveId, original_name: name, owner_user_id: current.owner_user_id, owner_handle: this.userHandle(current.owner_user_id), visibility: current.visibility, contribution_policy: current.contribution_policy, authenticated_contributions: current.authenticated_contributions, clanker_mode: current.clanker_mode, room_created_at: current.created_at ?? archivedAt, storage_name: storageName, archived_at: archivedAt });
  }

  archivedRooms(actor: Principal): ArchivedRoom[] {
    if (!actor.authenticated || actor.kind !== "user") return [];
    const rows = this.db.query(`SELECT a.id, a.original_name, a.owner_user_id, u.handle AS owner_handle, a.visibility, a.contribution_policy, a.authenticated_contributions, a.clanker_mode, a.room_created_at, a.storage_name, a.archived_at
      FROM room_archives a JOIN users u ON u.id = a.owner_user_id
      WHERE a.restored_at IS NULL AND (? = 1 OR a.owner_user_id = ?)
      ORDER BY a.archived_at DESC`).all(this.isSiteAdmin(actor) ? 1 : 0, actor.id) as ArchivedRoomRow[];
    return rows.map((row) => this.archivedRoomFromRow(row));
  }

  restoreRoom(actor: Principal, archiveId: string): RoomPolicy {
    const archive = this.archivedRooms(actor).find((candidate) => candidate.archiveId === archiveId);
    if (!archive) throw new Error("archived room not found");
    if (this.roomPolicy(archive.name)) throw new Error("room name is already in use");
    const owner = this.db.query("SELECT site_role, plan, status FROM users WHERE id = ?").get(archive.ownerId) as { site_role: SiteRole; plan: AccountPlan; status: string } | null;
    if (!owner || owner.status !== "active") throw new Error("the archived room owner is unavailable");
    const ownedRooms = (this.db.query("SELECT COUNT(*) AS count FROM rooms WHERE owner_user_id = ? AND system = 0").get(archive.ownerId) as { count: number }).count;
    const limit = owner.site_role === "admin" ? ACCOUNT_ROOM_LIMITS.siteAdmin : ACCOUNT_ROOM_LIMITS[owner.plan];
    if (ownedRooms >= limit) throw new Error(`${owner.plan} accounts can own at most ${limit} rooms`);
    this.db.transaction(() => {
      const contribution = storedContribution(archive.contributions);
      this.db.query("INSERT INTO rooms(name, owner_user_id, visibility, contribution_policy, authenticated_contributions, clanker_mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(archive.name, archive.ownerId, archive.visibility, contribution.policy, contribution.authenticated, archive.clankerMode, this.archiveCreatedAt(archive.archiveId));
      this.db.query(`INSERT INTO room_memberships(room_name, user_id, role, created_at, revoked_at)
        SELECT ?, user_id, role, created_at, revoked_at FROM archived_room_memberships WHERE archive_id = ?`).run(archive.name, archive.archiveId);
      this.db.query("UPDATE room_archives SET restored_at = ? WHERE id = ? AND restored_at IS NULL").run(Date.now(), archive.archiveId);
      this.audit(actor, archive.name, "room.restore", archive.archiveId);
    })();
    return this.roomPolicy(archive.name)!;
  }

  rollbackRoomRestore(archiveId: string, name: string): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM rooms WHERE name = ?").run(name);
      this.db.query("UPDATE room_archives SET restored_at = NULL WHERE id = ?").run(archiveId);
    })();
  }

  canManageRoom(principal: Principal, roomName: string): boolean {
    return this.isSiteAdmin(principal) || this.roleFor(principal, roomName) === "owner";
  }

  addRoomDomain(actor: Principal, roomName: string, hostname: string, reservedSuffix?: string): RoomDomain {
    this.assertDomainManager(actor, roomName);
    const normalized = normalizeDomain(hostname);
    const reserved = reservedSuffix ? normalizeDomain(reservedSuffix) : undefined;
    if (reserved && (normalized === reserved || normalized.endsWith(`.${reserved}`))) throw new Error("platform hostnames are assigned through room names");
    const existing = this.domainRow(normalized);
    if (existing) {
      if (existing.room_name !== roomName) throw new Error("domain is already registered to another room");
      return roomDomainFromRow(existing);
    }
    const count = (this.db.query("SELECT COUNT(*) AS count FROM room_domains WHERE room_name = ?").get(roomName) as { count: number }).count;
    if (count >= ROOM_DOMAIN_LIMIT) throw new Error(`a room can have at most ${ROOM_DOMAIN_LIMIT} custom domains`);
    const token = randomBytes(24).toString("base64url");
    this.db.query(`INSERT INTO room_domains(hostname, room_name, verification_token, status, created_by, created_at)
      VALUES (?, ?, ?, 'pending', ?, ?)`).run(normalized, roomName, token, actor.id, Date.now());
    this.audit(actor, roomName, "domain.add", normalized);
    return this.listRoomDomains(actor, roomName).find((domain) => domain.hostname === normalized)!;
  }

  listRoomDomains(actor: Principal, roomName: string): RoomDomain[] {
    this.assertDomainManager(actor, roomName);
    return (this.db.query(`SELECT hostname, room_name, verification_token, status, created_at, last_checked_at, verified_at
      FROM room_domains WHERE room_name = ? ORDER BY created_at, hostname`).all(roomName) as RoomDomainRow[]).map(roomDomainFromRow);
  }

  verifyRoomDomain(actor: Principal, roomName: string, hostname: string, txtValues: readonly string[]): RoomDomain {
    this.assertDomainManager(actor, roomName);
    const normalized = normalizeDomain(hostname);
    const row = this.domainRow(normalized);
    if (!row || row.room_name !== roomName) throw new Error("domain is not registered to this room");
    const now = Date.now();
    if (row.last_checked_at && now - row.last_checked_at < 15_000) throw new Error("wait a few seconds before checking DNS again");
    this.db.query("UPDATE room_domains SET last_checked_at = ? WHERE hostname = ?").run(now, normalized);
    const expected = `serverside-chat-verification=${row.verification_token}`;
    if (!txtValues.includes(expected)) throw new Error(`TXT record not found yet at _serverside-chat.${normalized}`);
    this.db.query("UPDATE room_domains SET status = 'active', verified_at = ? WHERE hostname = ?").run(now, normalized);
    this.audit(actor, roomName, "domain.verify", normalized);
    return roomDomainFromRow({ ...row, status: "active", last_checked_at: now, verified_at: now });
  }

  removeRoomDomain(actor: Principal, roomName: string, hostname: string): boolean {
    this.assertDomainManager(actor, roomName);
    const normalized = normalizeDomain(hostname);
    const result = this.db.query("DELETE FROM room_domains WHERE hostname = ? AND room_name = ?").run(normalized, roomName);
    if (result.changes) this.audit(actor, roomName, "domain.remove", normalized);
    return Boolean(result.changes);
  }

  roomForCustomDomain(hostname: string): string | undefined {
    let normalized: string;
    try { normalized = normalizeDomain(hostname); } catch { return undefined; }
    return (this.db.query("SELECT room_name FROM room_domains WHERE hostname = ? AND status = 'active'").get(normalized) as { room_name: string } | null)?.room_name;
  }

  private assertDomainManager(actor: Principal, roomName: string): void {
    const room = this.roomPolicy(roomName);
    if (!room) throw new Error("room not found");
    if (room.system) throw new Error("system rooms cannot have custom domains");
    if (!this.canManageRoom(actor, roomName)) throw new Error("custom domains require the room owner or a site admin");
  }

  private domainRow(hostname: string): RoomDomainRow | null {
    return this.db.query(`SELECT hostname, room_name, verification_token, status, created_at, last_checked_at, verified_at
      FROM room_domains WHERE hostname = ?`).get(hostname) as RoomDomainRow | null;
  }

  roomOrder(principal: Principal): string[] {
    if (!principal.authenticated || principal.kind !== "user") return [];
    return (this.db.query("SELECT room_name FROM room_preferences WHERE user_id = ? ORDER BY position, room_name").all(principal.id) as Array<{ room_name: string }>).map((row) => row.room_name);
  }

  saveRoomOrder(principal: Principal, names: string[]): void {
    if (!principal.authenticated || principal.kind !== "user") throw new Error("sign in to customize your room bar");
    if (names.length > 256 || new Set(names).size !== names.length || names.some((name) => !ROOM_NAME.test(name) || !this.canView(principal, name))) throw new Error("room order contains an unavailable room");
    const now = Date.now();
    this.db.transaction(() => {
      this.db.query("DELETE FROM room_preferences WHERE user_id = ?").run(principal.id);
      const insert = this.db.query("INSERT INTO room_preferences(user_id, room_name, position, updated_at) VALUES (?, ?, ?, ?)");
      names.forEach((name, position) => insert.run(principal.id, name, position, now));
    })();
  }

  private archivedRoomFromRow(row: ArchivedRoomRow): ArchivedRoom {
    return { archiveId: row.id, storageName: row.storage_name, archivedAt: row.archived_at, name: row.original_name, ownerId: row.owner_user_id, ownerHandle: row.owner_handle, visibility: row.visibility, contributions: contributionFromRow(row), clankerMode: row.clanker_mode, system: false };
  }

  private archiveCreatedAt(archiveId: string): number {
    const row = this.db.query("SELECT room_created_at FROM room_archives WHERE id = ? AND restored_at IS NULL").get(archiveId) as { room_created_at: number } | null;
    if (!row) throw new Error("archived room not found");
    return row.room_created_at;
  }

  private userHandle(userId: string): string {
    const row = this.db.query("SELECT handle FROM users WHERE id = ?").get(userId) as { handle: string } | null;
    if (!row) throw new Error("room owner not found");
    return row.handle;
  }

  roomPolicy(name: string): RoomPolicy | undefined {
    const room = this.db.query("SELECT name, owner_user_id, visibility, contribution_policy, authenticated_contributions, clanker_mode, system FROM rooms WHERE name = ?").get(name) as RoomRow | null;
    if (!room) return undefined;
    const owner = this.db.query("SELECT id, handle, display_name, status FROM users WHERE id = ?").get(room.owner_user_id) as UserRow;
    return { name: room.name, ownerId: room.owner_user_id, ownerHandle: owner.handle, visibility: room.visibility, contributions: contributionFromRow(room), clankerMode: room.clanker_mode, system: room.system === 1 };
  }

  updateRoomPolicy(actor: Principal, roomName: string, changes: Partial<Pick<RoomPolicy, "visibility" | "contributions" | "clankerMode">>): RoomPolicy {
    if (!this.isAdmin(actor, roomName)) throw new Error("room administration requires an admin");
    const current = this.roomPolicy(roomName);
    if (!current) throw new Error("room not found");
    if (current.system) throw new Error("system room policy is host-managed");
    const visibility = changes.visibility ?? current.visibility;
    const contributions = changes.contributions ?? current.contributions;
    const clankerMode = changes.clankerMode ?? current.clankerMode;
    const contribution = storedContribution(contributions);
    this.db.query("UPDATE rooms SET visibility = ?, contribution_policy = ?, authenticated_contributions = ?, clanker_mode = ? WHERE name = ?").run(visibility, contribution.policy, contribution.authenticated, clankerMode, roomName);
    this.audit(actor, roomName, "room.policy.update", JSON.stringify({ visibility, contributions, clankerMode }));
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

  authenticateIdentity(profile: IdentityProfile, linkTo?: Principal): { principal: Principal; created: boolean } {
    const provider = normalizeProvider(profile.provider);
    const subject = profile.subject.trim().slice(0, 255);
    if (!subject) throw new Error("identity subject is required");
    const existing = this.db.query(`SELECT u.id, u.handle, u.display_name, u.status
      FROM identities i JOIN users u ON u.id = i.user_id
      WHERE i.provider = ? AND i.provider_subject = ?`).get(provider, subject) as UserRow | null;
    if (existing) {
      if (existing.status !== "active") throw new Error("account is disabled");
      if (linkTo && existing.id !== linkTo.id) {
        this.transferUnprivilegedIdentity(existing, linkTo, provider, subject);
        return { principal: linkTo, created: false };
      }
      return { principal: userPrincipal(existing), created: false };
    }

    if (linkTo) {
      if (!linkTo.authenticated || linkTo.kind !== "user") throw new Error("an authenticated account is required for identity linking");
      this.db.query("INSERT INTO identities(provider, provider_subject, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(provider, subject, linkTo.id, profile.email?.trim().slice(0, 320) || null, Date.now());
      this.audit(linkTo, undefined, "identity.link", provider);
      return { principal: linkTo, created: false };
    }

    const handle = this.availableHandle(profile.handle);
    const displayName = (profile.displayName?.trim() || handle).slice(0, 80);
    const userId = crypto.randomUUID();
    const now = Date.now();
    this.db.transaction(() => {
      this.db.query("INSERT INTO users(id, handle, display_name, created_at) VALUES (?, ?, ?, ?)").run(userId, handle, displayName, now);
      this.db.query("INSERT INTO identities(provider, provider_subject, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(provider, subject, userId, profile.email?.trim().slice(0, 320) || null, now);
    })();
    const principal: Principal = { id: userId, kind: "user", handle, displayName, authenticated: true };
    this.audit(principal, undefined, "account.create", provider);
    return { principal, created: true };
  }

  createDevelopmentAccount(handle: string, displayName?: string): { principal: Principal; session: WebSession } {
    const account = this.authenticateIdentity({
      provider: "development",
      subject: randomBytes(24).toString("base64url"),
      handle,
      displayName,
    });
    return { principal: account.principal, session: this.createWebSession(account.principal) };
  }

  createOAuthFlow(providerName: string, returnTo = "/", ttlMs = 10 * 60 * 1_000, linkUserId?: string): OAuthFlow {
    const provider = normalizeProvider(providerName);
    const safeReturnTo = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo.slice(0, 2_048) : "/";
    const now = Date.now();
    this.db.query("DELETE FROM oauth_flows WHERE expires_at <= ?").run(now);
    const active = this.db.query("SELECT COUNT(*) AS count FROM oauth_flows").get() as { count: number };
    if (active.count >= 5_000) throw new Error("too many pending sign-ins");
    const state = randomBytes(32).toString("base64url");
    const browserToken = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(48).toString("base64url");
    const expiresAt = now + Math.max(60_000, Math.min(15 * 60 * 1_000, ttlMs));
    this.db.query("INSERT INTO oauth_flows(id, provider, state_hash, browser_hash, nonce, code_verifier, return_to, link_user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), provider, tokenHash(state), tokenHash(browserToken), nonce, codeVerifier, safeReturnTo, linkUserId ?? null, now, expiresAt);
    return { state, browserToken, nonce, codeVerifier, returnTo: safeReturnTo, expiresAt, linkUserId };
  }

  consumeOAuthFlow(providerName: string, state: string, browserToken: string): Omit<OAuthFlow, "state" | "browserToken"> {
    const provider = normalizeProvider(providerName);
    if (!/^[a-zA-Z0-9_-]{40,64}$/.test(state) || !/^[a-zA-Z0-9_-]{40,64}$/.test(browserToken)) throw new Error("sign-in request is invalid or expired");
    const row = this.db.query("SELECT id, nonce, code_verifier, return_to, link_user_id, expires_at FROM oauth_flows WHERE provider = ? AND state_hash = ? AND browser_hash = ?")
      .get(provider, tokenHash(state), tokenHash(browserToken)) as { id: string; nonce: string; code_verifier: string; return_to: string; link_user_id?: string; expires_at: number } | null;
    if (!row || row.expires_at <= Date.now()) throw new Error("sign-in request is invalid or expired");
    this.db.query("DELETE FROM oauth_flows WHERE id = ?").run(row.id);
    return { nonce: row.nonce, codeVerifier: row.code_verifier, returnTo: row.return_to, expiresAt: row.expires_at, linkUserId: row.link_user_id };
  }

  principalForUserId(userId: string): Principal | undefined {
    const row = this.db.query("SELECT id, handle, display_name, status FROM users WHERE id = ?").get(userId) as UserRow | null;
    return row?.status === "active" ? userPrincipal(row) : undefined;
  }

  createWebSession(principal: Principal, ttlMs = 30 * 24 * 60 * 60 * 1_000): WebSession {
    if (!principal.authenticated || principal.kind !== "user") throw new Error("an authenticated account is required");
    const sessionToken = randomBytes(32).toString("base64url");
    const now = Date.now();
    const expiresAt = now + Math.max(60_000, Math.min(90 * 24 * 60 * 60 * 1_000, ttlMs));
    this.db.query("INSERT INTO web_sessions(id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), principal.id, tokenHash(sessionToken), now, expiresAt);
    this.audit(principal, undefined, "web.session.create");
    return { sessionToken, expiresAt };
  }

  createAccountLink(principal: Principal, ttlMs = 10 * 60 * 1_000): AccountLink {
    if (!principal.authenticated || principal.kind !== "user") throw new Error("an authenticated account is required");
    const now = Date.now();
    this.db.query("DELETE FROM account_links WHERE expires_at <= ? OR user_id = ?").run(now, principal.id);
    const code = randomBytes(24).toString("base64url");
    const expiresAt = now + Math.max(60_000, Math.min(15 * 60 * 1_000, ttlMs));
    this.db.query("INSERT INTO account_links(id, token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), tokenHash(code), principal.id, now, expiresAt);
    this.audit(principal, undefined, "identity.bootstrap.create");
    return { code, expiresAt };
  }

  consumeAccountLink(code: string): Principal {
    if (!/^[a-zA-Z0-9_-]{32,64}$/.test(code)) throw new Error("account link is invalid or expired");
    const row = this.db.query("SELECT id, user_id, expires_at FROM account_links WHERE token_hash = ?").get(tokenHash(code)) as { id: string; user_id: string; expires_at: number } | null;
    if (!row || row.expires_at <= Date.now()) throw new Error("account link is invalid or expired");
    const principal = this.principalForUserId(row.user_id);
    if (!principal) throw new Error("account is no longer available");
    this.db.query("DELETE FROM account_links WHERE id = ?").run(row.id);
    this.audit(principal, undefined, "identity.bootstrap.consume");
    return principal;
  }

  createSshPairing(principal: Principal, requestedFrom = "", ttlMs = 10 * 60 * 1_000, inviteToken?: string): SshPairing {
    if (principal.authenticated || principal.kind !== "anonymous" || !principal.sshAlgorithm || !principal.sshKeyBlob || !principal.keyFingerprint) throw new Error("an unregistered verified SSH key is required");
    if (sshFingerprint(principal.sshKeyBlob) !== principal.keyFingerprint) throw new Error("SSH key identity mismatch");
    const now = Date.now();
    this.db.query("DELETE FROM ssh_pairings WHERE expires_at <= ? OR fingerprint = ?").run(now, principal.keyFingerprint);
    const active = this.db.query("SELECT COUNT(*) AS count FROM ssh_pairings").get() as { count: number };
    if (active.count >= 5_000) throw new Error("too many pending SSH sign-ins");
    const invite = inviteToken ? this.inviteForToken(inviteToken) : undefined;
    if (inviteToken && !invite) throw new Error("invite is invalid or expired");
    const code = randomBytes(18).toString("base64url");
    const expiresAt = now + Math.max(60_000, Math.min(15 * 60 * 1_000, ttlMs));
    this.db.query("INSERT INTO ssh_pairings(id, code_hash, fingerprint, algorithm, key_blob, requested_handle, requested_from, invite_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), tokenHash(code), principal.keyFingerprint, principal.sshAlgorithm, principal.sshKeyBlob, principal.requestedHandle ?? "", requestedFrom.slice(0, 120), invite?.id ?? null, now, expiresAt);
    return { code, expiresAt, roomName: invite?.room_name };
  }

  linkSshPairing(principal: Principal, code: string, label = "linked from browser"): { fingerprint: string; roomName?: string; role?: RoomRole } {
    if (!principal.authenticated || principal.kind !== "user") throw new Error("sign in before linking an SSH key");
    if (!/^[a-zA-Z0-9_-]{20,64}$/.test(code)) throw new Error("SSH link is invalid or expired");
    const pairing = this.db.query("SELECT id, fingerprint, algorithm, key_blob, invite_id, expires_at FROM ssh_pairings WHERE code_hash = ?")
      .get(tokenHash(code)) as { id: string; fingerprint: string; algorithm: string; key_blob: Buffer; invite_id?: string; expires_at: number } | null;
    if (!pairing || pairing.expires_at <= Date.now()) throw new Error("SSH link is invalid or expired");
    const owner = this.db.query("SELECT user_id, revoked_at FROM ssh_keys WHERE fingerprint = ?").get(pairing.fingerprint) as { user_id: string; revoked_at?: number } | null;
    if (owner && owner.user_id !== principal.id) throw new Error("SSH key is already linked to another account");
    const now = Date.now();
    this.db.transaction(() => {
      if (owner) this.db.query("UPDATE ssh_keys SET algorithm = ?, key_blob = ?, label = ?, revoked_at = NULL, last_used_at = ? WHERE fingerprint = ? AND user_id = ?")
        .run(pairing.algorithm, pairing.key_blob, label.slice(0, 120), now, pairing.fingerprint, principal.id);
      else this.db.query("INSERT INTO ssh_keys(fingerprint, user_id, algorithm, key_blob, label, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(pairing.fingerprint, principal.id, pairing.algorithm, pairing.key_blob, label.slice(0, 120), now, now);
      this.db.query("DELETE FROM ssh_pairings WHERE id = ?").run(pairing.id);
    })();
    this.audit(principal, undefined, "ssh.key.link", pairing.fingerprint);
    if (pairing.invite_id) {
      const invite = this.db.query("SELECT id, room_name, role, expires_at, max_uses, uses, revoked_at FROM invites WHERE id = ?").get(pairing.invite_id) as InviteRow | null;
      if (!this.validInvite(invite)) throw new Error("SSH key linked, but invite is invalid or expired");
      const role = this.grantInvite(principal, invite!);
      return { fingerprint: pairing.fingerprint, roomName: invite!.room_name, role };
    }
    return { fingerprint: pairing.fingerprint };
  }

  roleFor(principal: Principal, roomName: string): RoomRole | undefined {
    if (!principal.authenticated || principal.kind !== "user") return undefined;
    const row = this.db.query("SELECT role FROM room_memberships WHERE room_name = ? AND user_id = ? AND revoked_at IS NULL").get(roomName, principal.id) as { role: RoomRole } | null;
    return row?.role;
  }

  canView(principal: Principal, roomName: string): boolean {
    const policy = this.roomPolicy(roomName);
    return Boolean(policy && (policy.visibility === "public" || this.isSiteAdmin(principal) || this.roleFor(principal, roomName)));
  }

  canContribute(principal: Principal, roomName: string): boolean {
    const policy = this.roomPolicy(roomName);
    if (policy?.contributions === "authenticated") return principal.authenticated && principal.kind === "user" && this.canView(principal, roomName);
    const role = this.roleFor(principal, roomName);
    if (!policy || !role || policy.contributions === "disabled") return false;
    return policy.contributions === "admins" ? ROLE_WEIGHT[role] >= ROLE_WEIGHT.admin : ROLE_WEIGHT[role] >= ROLE_WEIGHT.contributor;
  }

  canEditSource(principal: Principal, roomName: string): boolean {
    const policy = this.roomPolicy(roomName);
    return Boolean(policy && !policy.system && this.canContribute(principal, roomName));
  }

  canInvokeClanker(principal: Principal, roomName: string): boolean {
    const policy = this.roomPolicy(roomName);
    return Boolean(policy && policy.clankerMode !== "disabled" && this.canContribute(principal, roomName));
  }

  canPromote(principal: Principal, roomName: string): boolean { return this.roleFor(principal, roomName) === "owner"; }
  isAdmin(principal: Principal, roomName: string): boolean {
    if (this.isSiteAdmin(principal)) return true;
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
    const row = this.inviteForToken(token);
    if (!row) throw new Error("invite is invalid or expired");
    return { roomName: row.room_name, role: this.grantInvite(principal, row) };
  }

  redeem(principal: Principal, token: string): { principal: Principal; roomName: string; role: RoomRole } {
    if (!principal.authenticated) throw new Error("create an account and link this SSH key before redeeming an invite");
    return { principal, ...this.redeemInvite(principal, token) };
  }

  principalForWebSession(sessionToken: string): Principal | undefined {
    if (!/^[a-zA-Z0-9_-]{40,64}$/.test(sessionToken)) return undefined;
    const row = this.db.query(`SELECT u.id, u.handle, u.display_name, u.status
      FROM web_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`).get(tokenHash(sessionToken), Date.now()) as UserRow | null;
    return row?.status === "active" ? userPrincipal(row) : undefined;
  }

  revokeWebSession(sessionToken: string): void {
    if (/^[a-zA-Z0-9_-]{40,64}$/.test(sessionToken)) this.db.query("UPDATE web_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL").run(Date.now(), tokenHash(sessionToken));
  }

  createMountCredential(principal: Principal, roomName: string, ttlMs = 90 * 24 * 60 * 60 * 1_000): MountCredential {
    if (!principal.authenticated || principal.kind !== "user") throw new Error("sign in before creating a mount credential");
    const policy = this.roomPolicy(roomName);
    if (!policy || !this.canView(principal, roomName)) throw new Error("room not found");
    if (policy.system) throw new Error("system rooms do not expose source mounts");
    const now = Date.now();
    const expiresAt = now + Math.max(60_000, Math.min(365 * 24 * 60 * 60 * 1_000, ttlMs));
    const id = randomBytes(12).toString("base64url");
    const username = `mount-${id}`;
    const password = `ssc_${randomBytes(32).toString("base64url")}`;
    this.db.transaction(() => {
      this.db.query("UPDATE mount_credentials SET revoked_at = ? WHERE user_id = ? AND room_name = ? AND revoked_at IS NULL").run(now, principal.id, roomName);
      this.db.query("DELETE FROM mount_credentials WHERE expires_at <= ? OR (user_id = ? AND room_name = ? AND revoked_at IS NOT NULL)").run(now, principal.id, roomName);
      this.db.query("INSERT INTO mount_credentials(id, user_id, room_name, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, principal.id, roomName, tokenHash(password), now, expiresAt);
    })();
    this.audit(principal, roomName, "mount.credential.rotate", username);
    return { username, password, roomName, expiresAt, readOnly: !this.canEditSource(principal, roomName) };
  }

  principalForMountCredential(username: string, password: string, roomName: string): Principal | undefined {
    const match = username.match(/^mount-([a-zA-Z0-9_-]{16})$/);
    if (!match || !/^ssc_[a-zA-Z0-9_-]{43}$/.test(password)) return undefined;
    const row = this.db.query(`SELECT u.id, u.handle, u.display_name, u.status
      FROM mount_credentials m JOIN users u ON u.id = m.user_id
      WHERE m.id = ? AND m.room_name = ? AND m.token_hash = ?
        AND m.revoked_at IS NULL AND m.expires_at > ?`).get(match[1]!, roomName, tokenHash(password), Date.now()) as UserRow | null;
    if (!row || row.status !== "active") return undefined;
    this.db.query("UPDATE mount_credentials SET last_used_at = ? WHERE id = ?").run(Date.now(), match[1]!);
    return userPrincipal(row);
  }

  revokeMountCredentials(principal: Principal, roomName: string): number {
    if (!principal.authenticated || principal.kind !== "user") throw new Error("sign in before revoking mount credentials");
    const result = this.db.query("UPDATE mount_credentials SET revoked_at = ? WHERE user_id = ? AND room_name = ? AND revoked_at IS NULL").run(Date.now(), principal.id, roomName);
    this.audit(principal, roomName, "mount.credential.revoke", String(result.changes));
    return result.changes;
  }

  linkIdentity(userId: string, provider: string, subject: string, email?: string): void {
    this.db.query("INSERT INTO identities(provider, provider_subject, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(provider.slice(0, 40), subject.slice(0, 255), userId, email?.slice(0, 320) ?? null, Date.now());
  }

  audit(actor: Principal, roomName: string | undefined, action: string, target = ""): void {
    this.db.query("INSERT INTO audit_events(room_name, actor_principal_id, action, target, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(roomName ?? null, actor.id, action.slice(0, 80), target.slice(0, 500), Date.now());
  }

  private availableHandle(value: string): string {
    const base = normalizeHandle(value);
    let handle = base;
    let suffix = 1;
    while (this.db.query("SELECT 1 AS found FROM users WHERE handle = ?").get(handle)) {
      const marker = `-${suffix++}`;
      handle = `${base.slice(0, 32 - marker.length)}${marker}`;
    }
    return handle;
  }

  private transferUnprivilegedIdentity(source: UserRow, target: Principal, provider: string, subject: string): void {
    if (!target.authenticated || target.kind !== "user") throw new Error("an authenticated account is required for identity linking");
    const count = (sql: string) => (this.db.query(sql).get(source.id) as { count: number }).count;
    const established = count("SELECT COUNT(*) AS count FROM rooms WHERE owner_user_id = ?")
      + count("SELECT COUNT(*) AS count FROM room_memberships WHERE user_id = ? AND revoked_at IS NULL")
      + count("SELECT COUNT(*) AS count FROM ssh_keys WHERE user_id = ?")
      + count("SELECT COUNT(*) AS count FROM clanker_credentials WHERE owner_user_id = ?")
      + count("SELECT COUNT(*) AS count FROM mount_credentials WHERE user_id = ?")
      + Math.max(0, count("SELECT COUNT(*) AS count FROM identities WHERE user_id = ?") - 1);
    if (established) throw new Error("this identity is already linked to another account and cannot be merged automatically");

    const now = Date.now();
    this.db.transaction(() => {
      this.db.query("UPDATE identities SET user_id = ? WHERE provider = ? AND provider_subject = ? AND user_id = ?")
        .run(target.id, provider, subject, source.id);
      this.db.query("UPDATE web_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(now, source.id);
      this.db.query("UPDATE users SET status = 'disabled' WHERE id = ?").run(source.id);
    })();
    this.audit(target, undefined, "identity.consolidate", `${provider}:${source.handle}`);
  }

  private inviteForToken(token: string): InviteRow | undefined {
    const row = this.db.query("SELECT id, room_name, role, expires_at, max_uses, uses, revoked_at FROM invites WHERE token_hash = ?").get(tokenHash(token)) as InviteRow | null;
    return this.validInvite(row) ? row! : undefined;
  }

  private validInvite(row: InviteRow | null): boolean {
    return Boolean(row && !row.revoked_at && row.expires_at > Date.now() && row.uses < row.max_uses);
  }

  private grantInvite(principal: Principal, row: InviteRow): RoomRole {
    const existing = this.roleFor(principal, row.room_name);
    const grantedRole = existing && ROLE_WEIGHT[existing] >= ROLE_WEIGHT[row.role] ? existing : row.role;
    this.db.transaction(() => {
      this.db.query("INSERT INTO room_memberships(room_name, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(room_name, user_id) DO UPDATE SET role = excluded.role, revoked_at = NULL")
        .run(row.room_name, principal.id, grantedRole, Date.now());
      this.db.query("UPDATE invites SET uses = uses + 1 WHERE id = ? AND uses < max_uses").run(row.id);
    })();
    this.audit(principal, row.room_name, "invite.redeem", grantedRole);
    return grantedRole;
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

function normalizeProvider(value: string): string {
  const provider = value.toLowerCase().trim();
  if (!/^[a-z0-9_-]{1,40}$/.test(provider)) throw new Error("identity provider is invalid");
  return provider;
}

function storedContribution(value: ContributionPolicy): { policy: Exclude<ContributionPolicy, "authenticated">; authenticated: 0 | 1 } {
  return value === "authenticated" ? { policy: "members", authenticated: 1 } : { policy: value, authenticated: 0 };
}

function contributionFromRow(row: Pick<RoomRow, "contribution_policy" | "authenticated_contributions">): ContributionPolicy {
  return row.authenticated_contributions === 1 ? "authenticated" : row.contribution_policy;
}

function validateRoomName(value: string): void {
  if (!ROOM_NAME.test(value)) throw new Error("room names use 1-32 lowercase letters, numbers, and dashes");
}

export function normalizeDomain(value: string): string {
  const hostname = domainToASCII(value.trim().replace(/\.$/, "").toLowerCase());
  if (!hostname || hostname.length > 253 || isIP(hostname) || !hostname.includes(".")) throw new Error("enter a public DNS hostname, such as example.com");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) throw new Error("local hostnames cannot be registered");
  if (!hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error("domain name is invalid");
  return hostname;
}

function roomDomainFromRow(row: RoomDomainRow): RoomDomain {
  return {
    hostname: row.hostname,
    roomName: row.room_name,
    status: row.status,
    challengeName: `_serverside-chat.${row.hostname}`,
    challengeValue: `serverside-chat-verification=${row.verification_token}`,
    createdAt: row.created_at,
    lastCheckedAt: row.last_checked_at ?? undefined,
    verifiedAt: row.verified_at ?? undefined,
  };
}

function tokenHash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
