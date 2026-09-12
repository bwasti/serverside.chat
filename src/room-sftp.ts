import { constants as fsConstants } from "node:fs";
import { posix } from "node:path";
import type { Attributes, FileEntry, SFTPWrapper } from "ssh2";
import type { AccountStore, Principal } from "./auth";
import type { RoomDirectory } from "./room-directory";
import { MAX_WORKSPACE_FILE_BYTES, type RoomWorkspace } from "./workspace";
import { retrySeconds, type RateLimitDecision } from "./rate-limit";

type FileHandle = {
  kind: "file";
  workspace: RoomWorkspace;
  roomName: string;
  path: string;
  content: Buffer;
  revision: string | null;
  readable: boolean;
  writable: boolean;
  append: boolean;
  dirty: boolean;
};
type DirectoryHandle = { kind: "directory"; entries: FileEntry[]; read: boolean };
type OpenHandle = FileHandle | DirectoryHandle;
type VirtualTarget = { kind: "root"; path: "/" } | { kind: "room"; path: string; roomName: string; workspace: RoomWorkspace; relativePath: string };

const MAX_OPEN_HANDLES = 16;
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const OPEN_MODE = { READ: 0x01, WRITE: 0x02, APPEND: 0x04, CREAT: 0x08, TRUNC: 0x10, EXCL: 0x20 } as const;
const STATUS = { OK: 0, EOF: 1, NO_SUCH_FILE: 2, PERMISSION_DENIED: 3, FAILURE: 4, OP_UNSUPPORTED: 8 } as const;
const DIRECTORY_MODE = fsConstants.S_IFDIR | 0o755;
const FILE_MODE = fsConstants.S_IFREG | 0o644;

/** Attach a room-scoped virtual filesystem. Host paths and .git are never returned to the client. */
export function attachRoomSftp(sftp: SFTPWrapper, principal: Principal, accounts: AccountStore, directory: RoomDirectory, rateLimit?: () => RateLimitDecision): void {
  const handles = new Map<number, OpenHandle>();
  let nextHandle = 1;

  const allocate = (value: OpenHandle): Buffer => {
    if (handles.size >= MAX_OPEN_HANDLES) throw new Error("too many open files");
    if (value.kind === "file" && bufferedBytes(handles) + value.content.length > MAX_BUFFERED_BYTES) throw new Error("open file buffers exceed 2 MiB limit");
    const id = nextHandle++;
    handles.set(id, value);
    const handle = Buffer.alloc(4);
    handle.writeUInt32BE(id);
    return handle;
  };
  const lookup = (handle: Buffer): OpenHandle => {
    if (handle.length !== 4) throw new Error("invalid handle");
    const value = handles.get(handle.readUInt32BE(0));
    if (!value) throw new Error("invalid handle");
    return value;
  };
  const resolveTarget = (path: string): VirtualTarget => {
    if (path.includes("\0")) throw new Error("invalid path");
    const normalized = posix.resolve("/", path || ".");
    if (normalized === "/") return { kind: "root", path: "/" };
    const [roomName, ...rest] = normalized.slice(1).split("/");
    const workspace = roomName ? directory.workspaces.get(roomName) : undefined;
    if (!roomName || !workspace || !accounts.canView(principal, roomName)) throw new Error("file not found");
    return { kind: "room", path: normalized, roomName, workspace, relativePath: rest.join("/") };
  };
  const requireRoom = (path: string): Extract<VirtualTarget, { kind: "room" }> => {
    const target = resolveTarget(path);
    if (target.kind !== "room") throw new Error("operation is not permitted on the virtual root");
    return target;
  };
  const requireWrite = (roomName: string): void => {
    if (!accounts.canEditSource(principal, roomName)) throw new Error("room source is read-only");
  };
  const audit = (roomName: string, action: string, target = ""): void => accounts.audit(principal, roomName, action, target);
  const replyError = (requestId: number, error: unknown): void => {
    const message = error instanceof Error ? error.message : "filesystem operation failed";
    const code = /read-only|not permitted|sign in|visible|permission/i.test(message)
      ? STATUS.PERMISSION_DENIED
      : /not found|directory not found/i.test(message) ? STATUS.NO_SUCH_FILE : STATUS.FAILURE;
    sftp.status(requestId, code, message.slice(0, 160));
  };
  const guard = (requestId: number, operation: () => void): void => {
    try {
      const decision = rateLimit?.();
      if (decision && !decision.allowed) throw new Error(`rate limited · retry in ${retrySeconds(decision)}s`);
      operation();
    } catch (error) { replyError(requestId, error); }
  };

  const attrsFor = (kind: "file" | "directory", size: number, modifiedAt = Date.now()): Attributes => ({
    mode: kind === "directory" ? DIRECTORY_MODE : FILE_MODE,
    uid: 0,
    gid: 0,
    size,
    atime: Math.floor(modifiedAt / 1_000),
    mtime: Math.floor(modifiedAt / 1_000),
  });
  const entryFor = (filename: string, kind: "file" | "directory", size: number, modifiedAt: number): FileEntry => {
    const attrs = attrsFor(kind, size, modifiedAt);
    return { filename, longname: `${kind === "directory" ? "d" : "-"}rw-r--r-- 1 room room ${String(size).padStart(8)} ${filename}`, attrs };
  };
  const statTarget = (target: VirtualTarget): Attributes => {
    if (target.kind === "root" || !target.relativePath) return attrsFor("directory", 0);
    const info = target.workspace.stat(target.relativePath);
    return attrsFor(info.kind, info.bytes, info.modifiedAt);
  };

  sftp.on("REALPATH", (requestId, path) => guard(requestId, () => {
    const target = resolveTarget(path);
    sftp.name(requestId, [{ filename: target.path, longname: target.path, attrs: statTarget(target) }]);
  }));

  const onStat = (requestId: number, path: string) => guard(requestId, () => sftp.attrs(requestId, statTarget(resolveTarget(path))));
  sftp.on("STAT", onStat).on("LSTAT", onStat);

  sftp.on("OPENDIR", (requestId, path) => guard(requestId, () => {
    const target = resolveTarget(path);
    let entries: FileEntry[];
    if (target.kind === "root") {
      entries = directory.rooms.filter((room) => accounts.canView(principal, room.name)).map((room) => entryFor(room.name, "directory", 0, room.serviceStartedAt.getTime()));
    } else {
      entries = target.workspace.listDirectory(target.relativePath).map((entry) => entryFor(entry.name, entry.kind, entry.bytes, entry.modifiedAt));
    }
    sftp.handle(requestId, allocate({ kind: "directory", entries, read: false }));
  }));
  sftp.on("READDIR", (requestId, handle) => guard(requestId, () => {
    const opened = lookup(handle);
    if (opened.kind !== "directory") throw new Error("not a directory handle");
    if (opened.read || !opened.entries.length) sftp.status(requestId, STATUS.EOF);
    else { opened.read = true; sftp.name(requestId, opened.entries); }
  }));

  sftp.on("OPEN", (requestId, path, flags) => guard(requestId, () => {
    const target = requireRoom(path);
    if (!target.relativePath) throw new Error("cannot open a room directory as a file");
    const readable = Boolean(flags & OPEN_MODE.READ);
    const writable = Boolean(flags & OPEN_MODE.WRITE);
    if (!readable && !writable) throw new Error("invalid open mode");
    if (writable) requireWrite(target.roomName);
    const revision = target.workspace.fileRevision(target.relativePath);
    const exists = revision !== null;
    if (!exists && !(flags & OPEN_MODE.CREAT)) throw new Error("file not found");
    if (exists && (flags & OPEN_MODE.CREAT) && (flags & OPEN_MODE.EXCL)) throw new Error("file already exists");
    let content = exists ? target.workspace.readFileBytes(target.relativePath) : Buffer.alloc(0);
    const truncate = writable && Boolean(flags & OPEN_MODE.TRUNC);
    if (truncate) content = Buffer.alloc(0);
    sftp.handle(requestId, allocate({
      kind: "file", workspace: target.workspace, roomName: target.roomName, path: target.relativePath,
      content, revision, readable, writable, append: Boolean(flags & OPEN_MODE.APPEND), dirty: truncate || !exists,
    }));
  }));
  sftp.on("READ", (requestId, handle, offset, length) => guard(requestId, () => {
    const opened = lookup(handle);
    if (opened.kind !== "file" || !opened.readable) throw new Error("file is not open for reading");
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) throw new Error("invalid read range");
    if (offset >= opened.content.length) { sftp.status(requestId, STATUS.EOF); return; }
    sftp.data(requestId, opened.content.subarray(offset, Math.min(opened.content.length, offset + length)));
  }));
  sftp.on("WRITE", (requestId, handle, offset, data) => guard(requestId, () => {
    const opened = lookup(handle);
    if (opened.kind !== "file" || !opened.writable) throw new Error("file is not open for writing");
    const position = opened.append ? opened.content.length : offset;
    if (!Number.isSafeInteger(position) || position < 0 || position + data.length > MAX_WORKSPACE_FILE_BYTES) throw new Error("file exceeds 512 KiB limit");
    if (position + data.length > opened.content.length) {
      if (bufferedBytes(handles) - opened.content.length + position + data.length > MAX_BUFFERED_BYTES) throw new Error("open file buffers exceed 2 MiB limit");
      const expanded = Buffer.alloc(position + data.length);
      opened.content.copy(expanded);
      opened.content = expanded;
    }
    data.copy(opened.content, position);
    opened.dirty = true;
    sftp.status(requestId, STATUS.OK);
  }));
  sftp.on("FSTAT", (requestId, handle) => guard(requestId, () => {
    const opened = lookup(handle);
    sftp.attrs(requestId, opened.kind === "directory" ? attrsFor("directory", 0) : attrsFor("file", opened.content.length));
  }));
  sftp.on("FSETSTAT", (requestId, handle, attrs) => guard(requestId, () => {
    const opened = lookup(handle);
    if (opened.kind !== "file" || !opened.writable) throw new Error("file is not open for writing");
    if (Object.prototype.hasOwnProperty.call(attrs, "size")) {
      const size = Number(attrs.size);
      if (bufferedBytes(handles) - opened.content.length + size > MAX_BUFFERED_BYTES) throw new Error("open file buffers exceed 2 MiB limit");
      resizeOpenFile(opened, size);
    }
    sftp.status(requestId, STATUS.OK);
  }));
  sftp.on("CLOSE", (requestId, handle) => guard(requestId, () => {
    const id = handle.length === 4 ? handle.readUInt32BE(0) : -1;
    const opened = lookup(handle);
    if (opened.kind === "file" && opened.dirty) {
      opened.workspace.writeFileBytes(opened.path, opened.content, opened.revision);
      audit(opened.roomName, "sftp.write", `${opened.path} ${opened.content.length}B`);
    }
    handles.delete(id);
    sftp.status(requestId, STATUS.OK);
  }));

  sftp.on("MKDIR", (requestId, path) => guard(requestId, () => {
    const target = requireRoom(path); requireWrite(target.roomName);
    if (!target.relativePath) throw new Error("operation is not permitted on the room root");
    target.workspace.createDirectory(target.relativePath); audit(target.roomName, "sftp.mkdir", target.relativePath);
    sftp.status(requestId, STATUS.OK);
  }));
  sftp.on("REMOVE", (requestId, path) => guard(requestId, () => {
    const target = requireRoom(path); requireWrite(target.roomName);
    target.workspace.deleteFile(target.relativePath); audit(target.roomName, "sftp.remove", target.relativePath);
    sftp.status(requestId, STATUS.OK);
  }));
  sftp.on("RMDIR", (requestId, path) => guard(requestId, () => {
    const target = requireRoom(path); requireWrite(target.roomName);
    target.workspace.removeDirectory(target.relativePath); audit(target.roomName, "sftp.rmdir", target.relativePath);
    sftp.status(requestId, STATUS.OK);
  }));
  sftp.on("RENAME", (requestId, oldPath, newPath) => guard(requestId, () => {
    const source = requireRoom(oldPath); const target = requireRoom(newPath);
    if (source.roomName !== target.roomName) throw new Error("entries cannot move between rooms");
    requireWrite(source.roomName);
    source.workspace.renamePath(source.relativePath, target.relativePath);
    audit(source.roomName, "sftp.rename", `${source.relativePath} -> ${target.relativePath}`);
    sftp.status(requestId, STATUS.OK);
  }));
  sftp.on("SETSTAT", (requestId, path, attrs) => guard(requestId, () => {
    const target = requireRoom(path); requireWrite(target.roomName);
    const info = target.workspace.stat(target.relativePath);
    if (info.kind === "file" && Object.prototype.hasOwnProperty.call(attrs, "size")) {
      const revision = target.workspace.fileRevision(target.relativePath);
      let content = target.workspace.readFileBytes(target.relativePath);
      const size = Number(attrs.size);
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_WORKSPACE_FILE_BYTES) throw new Error("invalid file size");
      if (size !== content.length) {
        const resized = Buffer.alloc(size);
        content.copy(resized, 0, 0, Math.min(content.length, size));
        content = resized;
        target.workspace.writeFileBytes(target.relativePath, content, revision);
        audit(target.roomName, "sftp.truncate", `${target.relativePath} ${size}B`);
      }
    }
    // Ownership, mode, and timestamps are virtual and intentionally normalized.
    sftp.status(requestId, STATUS.OK);
  }));

  const unsupported = (requestId: number) => sftp.status(requestId, STATUS.OP_UNSUPPORTED);
  sftp.on("READLINK", unsupported).on("SYMLINK", unsupported).on("EXTENDED", unsupported);
}

function resizeOpenFile(opened: FileHandle, requestedSize: number): void {
  const size = Number(requestedSize);
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_WORKSPACE_FILE_BYTES) throw new Error("invalid file size");
  if (size === opened.content.length) return;
  const resized = Buffer.alloc(size);
  opened.content.copy(resized, 0, 0, Math.min(opened.content.length, size));
  opened.content = resized;
  opened.dirty = true;
}

function bufferedBytes(handles: Map<number, OpenHandle>): number {
  let bytes = 0;
  for (const opened of handles.values()) if (opened.kind === "file") bytes += opened.content.length;
  return bytes;
}
