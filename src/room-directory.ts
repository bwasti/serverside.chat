import { existsSync, mkdirSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import type { AccountStore, Principal, RoomPolicy } from "./auth";
import { Room } from "./room";
import { RoomWorkspace } from "./workspace";

export interface RoomDirectoryEvent {
  kind: "create" | "rename" | "delete" | "restore";
  name: string;
  previousName?: string;
}

type ConfigureRoom = (room: Room, workspace: RoomWorkspace) => void;

export class RoomDirectory {
  readonly rooms: Room[] = [];
  readonly workspaces = new Map<string, RoomWorkspace>();
  readonly controlOrigin: string;
  readonly controlHostname: string;
  readonly roomSiteDomain?: string;
  private readonly listeners = new Set<(event: RoomDirectoryEvent) => void>();

  constructor(
    private readonly accounts: AccountStore,
    private readonly dataDir: string,
    private readonly webBaseUrl: string,
    private readonly configureRoom: ConfigureRoom = () => {},
    roomSiteDomain?: string,
  ) {
    const control = new URL(webBaseUrl);
    this.controlOrigin = control.origin;
    this.controlHostname = control.hostname.toLowerCase();
    this.roomSiteDomain = roomSiteDomain?.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "") || undefined;
    if (this.roomSiteDomain && !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(this.roomSiteDomain)) throw new Error("ROOM_SITE_DOMAIN must be a DNS hostname");
    for (const policy of accounts.listRooms()) this.add(policy);
  }

  room(name: string): Room | undefined { return this.rooms.find((room) => room.name === name); }

  chatUrl(name: string): string { return `${this.controlOrigin}/room/${encodeURIComponent(name)}`; }

  roomNameForSiteHostname(hostname: string): string | undefined {
    if (!this.roomSiteDomain) return undefined;
    const suffix = `.${this.roomSiteDomain}`;
    const normalized = hostname.toLowerCase().replace(/\.$/, "");
    if (!normalized.endsWith(suffix)) return undefined;
    const label = normalized.slice(0, -suffix.length);
    return /^[a-z0-9][a-z0-9-]{0,31}$/.test(label) && this.room(label) && !this.room(label)!.policy.system ? label : undefined;
  }

  isControlHostname(hostname: string): boolean { return hostname.toLowerCase().replace(/\.$/, "") === this.controlHostname; }

  subscribe(listener: (event: RoomDirectoryEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  ensureStarterRoom(principal: Principal): Room | undefined {
    if (!principal.authenticated || principal.kind !== "user") return undefined;
    const existing = this.accounts.ownedRoomNames(principal)[0];
    if (existing) return this.room(existing);
    const base = principal.handle.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "room";
    let name = base;
    for (let suffix = 2; this.accounts.roomPolicy(name); suffix++) {
      const marker = `-${suffix}`;
      name = `${base.slice(0, 32 - marker.length)}${marker}`;
    }
    return this.createRoom(principal, name);
  }

  prepareAccount(principal: Principal): Room | undefined {
    if (!principal.authenticated || principal.kind !== "user") return undefined;
    this.accounts.ensureSystemMembership(principal, "lobby");
    return this.ensureStarterRoom(principal);
  }

  createRoom(
    actor: Principal,
    name: string,
    defaults?: Pick<RoomPolicy, "visibility" | "contributions" | "agentMode">,
  ): Room {
    const policy = this.accounts.createRoom(actor, name, defaults);
    try {
      const room = this.add(policy);
      this.emit({ kind: "create", name });
      return room;
    } catch (error) {
      this.workspaces.delete(name);
      this.trashStorage(name);
      this.accounts.deleteRoom(actor, name);
      throw error;
    }
  }

  renameRoom(actor: Principal, oldName: string, newName: string): Room {
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(newName)) throw new Error("room names use 1-32 lowercase letters, numbers, and dashes");
    const oldRoom = this.room(oldName);
    if (!oldRoom) throw new Error("room not found");
    if (agentBusy(oldRoom)) throw new Error("wait for the room agent to finish before renaming");
    if (!this.accounts.canManageRoom(actor, oldName)) throw new Error("renaming a room requires its owner or a site admin");
    if (this.accounts.roomPolicy(newName)) throw new Error("room name is already in use");
    const oldDirectory = this.roomDataPath(oldName);
    const newDirectory = this.roomDataPath(newName);
    if (existsSync(newDirectory)) throw new Error("target room storage already exists");
    if (existsSync(oldDirectory)) renameSync(oldDirectory, newDirectory);
    let databaseRenamed = false;
    try {
      const policy = this.accounts.renameRoom(actor, oldName, newName);
      databaseRenamed = true;
      const index = this.rooms.indexOf(oldRoom);
      this.workspaces.delete(oldName);
      const room = this.materialize(policy);
      if (index >= 0) this.rooms.splice(index, 1, room);
      else this.rooms.push(room);
      this.emit({ kind: "rename", name: newName, previousName: oldName });
      return room;
    } catch (error) {
      this.workspaces.delete(newName);
      if (databaseRenamed) this.accounts.renameRoom(actor, newName, oldName);
      if (existsSync(newDirectory) && !existsSync(oldDirectory)) renameSync(newDirectory, oldDirectory);
      throw error;
    }
  }

  deleteRoom(actor: Principal, name: string): void {
    const room = this.room(name);
    if (!room) throw new Error("room not found");
    if (agentBusy(room)) throw new Error("wait for the room agent to finish before deleting");
    if (!this.accounts.canManageRoom(actor, name)) throw new Error("deleting a room requires its owner or a site admin");
    const source = this.roomDataPath(name);
    const archiveId = crypto.randomUUID();
    const storageName = `${Date.now()}-${archiveId.slice(0, 8)}-${name}`;
    const trashed = this.trashStorage(name, storageName);
    try {
      this.accounts.archiveRoom(actor, name, archiveId, storageName);
      const index = this.rooms.indexOf(room);
      if (index >= 0) this.rooms.splice(index, 1);
      this.workspaces.delete(name);
      this.emit({ kind: "delete", name });
    } catch (error) {
      if (existsSync(trashed) && !existsSync(source)) renameSync(trashed, source);
      throw error;
    }
  }

  restoreRoom(actor: Principal, name: string): Room {
    if (this.room(name) || this.accounts.roomPolicy(name)) throw new Error("room name is already in use");
    const archive = this.accounts.archivedRooms(actor).find((candidate) => candidate.name === name);
    if (!archive) throw new Error("archived room not found");
    const trashed = this.archivedStoragePath(archive.storageName);
    const target = this.roomDataPath(name);
    if (!existsSync(trashed)) throw new Error("archived room storage is unavailable");
    if (existsSync(target)) throw new Error("target room storage already exists");
    renameSync(trashed, target);
    let databaseRestored = false;
    let restored: Room | undefined;
    try {
      const policy = this.accounts.restoreRoom(actor, archive.archiveId);
      databaseRestored = true;
      restored = this.add(policy);
      this.emit({ kind: "restore", name });
      return restored;
    } catch (error) {
      if (restored) {
        const index = this.rooms.indexOf(restored);
        if (index >= 0) this.rooms.splice(index, 1);
      }
      this.workspaces.delete(name);
      if (databaseRestored) this.accounts.rollbackRoomRestore(archive.archiveId, name);
      if (existsSync(target) && !existsSync(trashed)) renameSync(target, trashed);
      throw error;
    }
  }

  private add(policy: RoomPolicy): Room {
    const room = this.materialize(policy);
    this.rooms.push(room);
    return room;
  }

  private materialize(policy: RoomPolicy): Room {
    const room = new Room(policy.name, 250, this.pageUrl(policy), policy.ownerHandle, `${this.dataDir}/rooms/${policy.name}/room-state.json`, this.accounts);
    const workspace = new RoomWorkspace(this.dataDir, policy.name);
    this.workspaces.set(policy.name, workspace);
    room.setVersionGraph(workspace.versionGraph());
    room.addAgentLink("head", `${room.pageUrl}?__ref=head`);
    for (const preview of workspace.visiblePreviews()) room.addAgentLink(preview.description, `${room.pageUrl}?__ref=${preview.id}`);
    this.configureRoom(room, workspace);
    return room;
  }

  private pageUrl(policy: RoomPolicy): string {
    if (policy.system) return this.chatUrl(policy.name);
    if (!this.roomSiteDomain) return `${this.webBaseUrl}/${encodeURIComponent(policy.name)}`;
    const control = new URL(this.controlOrigin);
    const port = control.port ? `:${control.port}` : "";
    return `${control.protocol}//${policy.name}.${this.roomSiteDomain}${port}`;
  }

  private roomDataPath(name: string): string { return resolve(this.dataDir, "rooms", name); }

  private trashStorage(name: string, storageName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${name}`): string {
    const source = this.roomDataPath(name);
    const trashRoot = resolve(this.dataDir, ".trash", "rooms");
    const trashed = resolve(trashRoot, storageName);
    if (existsSync(source)) {
      mkdirSync(trashRoot, { recursive: true });
      renameSync(source, trashed);
    }
    return trashed;
  }

  private archivedStoragePath(storageName: string): string {
    if (!/^[0-9]+-[0-9a-f]{8}-[a-z0-9][a-z0-9-]{0,31}$/.test(storageName)) throw new Error("archived room storage identity is invalid");
    return resolve(this.dataDir, ".trash", "rooms", storageName);
  }

  private emit(event: RoomDirectoryEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function agentBusy(room: Room): boolean {
  return room.agentState.status === "queued" || room.agentState.status === "thinking" || room.agentState.status === "working";
}
