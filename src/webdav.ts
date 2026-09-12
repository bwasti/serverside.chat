import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import type { AccountStore, Principal } from "./auth";
import type { RoomDirectory } from "./room-directory";
import { MAX_WORKSPACE_FILE_BYTES, type RoomWorkspace } from "./workspace";
import { AdaptiveRateLimiter, RATE_LIMITS, retrySeconds } from "./rate-limit";

const DAV_PREFIX = "/_dav/";
const DAV_METHODS = "OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL, MOVE, COPY, LOCK, UNLOCK";
const MAX_ACTIVE_LOCKS = 1_024;
const MAX_PRINCIPAL_LOCKS = 64;
const locks = new Map<string, { token: string; principalId: string; expiresAt: number }>();

class DavError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function handleWebDavRequest(request: Request, accounts: AccountStore, directory: RoomDirectory, rateLimiter?: AdaptiveRateLimiter, clientAddress = "direct"): Promise<Response> {
  let target: DavTarget;
  try { target = parseTarget(new URL(request.url), directory); }
  catch (error) { return davError(error); }

  const credentials = basicCredentials(request.headers.get("authorization"));
  const principal = credentials ? accounts.principalForMountCredential(credentials.username, credentials.password, target.roomName) : undefined;
  if (!principal) {
    const denied = rateLimiter?.consume(`webdav-unauthenticated:${clientAddress}`, RATE_LIMITS.anonymousHttp);
    if (denied && !denied.allowed) return davRateLimited(denied);
    return unauthorized(target.roomName);
  }
  const limited = rateLimiter?.consume(`webdav:${principal.id}`, RATE_LIMITS.authenticatedHttp);
  if (limited && !limited.allowed) return davRateLimited(limited);
  if (!accounts.canView(principal, target.roomName)) return davResponse("room not found\n", 404);

  const method = request.method.toUpperCase();
  try {
    if (method === "OPTIONS") return davResponse(null, 204);
    if (method === "PROPFIND") return propfind(request, target);
    if (method === "GET" || method === "HEAD") return readFile(request, target, method === "HEAD");
    if (method === "LOCK") return lock(request, target, principal, accounts);
    if (method === "UNLOCK") return unlock(request, target, principal, accounts);
    requireWrite(accounts, principal, target.roomName);
    assertUnlocked(request, target, principal);
    if (method === "PUT") return await put(request, target, principal, accounts);
    if (method === "DELETE") return remove(target, principal, accounts);
    if (method === "MKCOL") return makeCollection(request, target, principal, accounts);
    if (method === "MOVE") return move(request, target, principal, accounts, directory);
    if (method === "COPY") return copy(request, target, principal, accounts, directory);
    return davResponse("method not allowed\n", 405);
  } catch (error) {
    return davError(error);
  }
}

interface DavTarget {
  roomName: string;
  path: string;
  workspace: RoomWorkspace;
  href: string;
}

function parseTarget(url: URL, directory: RoomDirectory): DavTarget {
  if (!url.pathname.startsWith(DAV_PREFIX)) throw new DavError(404, "not found");
  const encoded = url.pathname.slice(DAV_PREFIX.length).split("/");
  const roomName = decodeSegment(encoded.shift() ?? "");
  const workspace = directory.workspaces.get(roomName);
  if (!workspace) throw new DavError(404, "room not found");
  const segments = encoded.filter(Boolean).map(decodeSegment);
  const path = segments.join("/");
  const href = `${DAV_PREFIX}${encodeURIComponent(roomName)}/${segments.map(encodeURIComponent).join("/")}${url.pathname.endsWith("/") && path ? "/" : ""}`;
  return { roomName, path, workspace, href };
}

function decodeSegment(value: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(value); }
  catch { throw new DavError(400, "invalid path encoding"); }
  if (!decoded || decoded === "." || decoded === ".." || decoded.toLowerCase() === ".git" || /[\\/\0]/.test(decoded)) throw new DavError(400, "invalid WebDAV path");
  return decoded;
}

function basicCredentials(header: string | null): { username: string; password: string } | undefined {
  const encoded = header?.match(/^Basic\s+([a-zA-Z0-9+/]+={0,2})$/i)?.[1];
  if (!encoded || encoded.length > 256) return undefined;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 1) return undefined;
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

function propfind(request: Request, target: DavTarget): Response {
  const depth = request.headers.get("depth")?.toLowerCase() ?? "1";
  if (depth === "infinity") return davResponse("WebDAV depth infinity is disabled\n", 403);
  if (depth !== "0" && depth !== "1") throw new DavError(400, "Depth must be 0 or 1");
  const info = target.workspace.stat(target.path);
  const resources = [{ target, info }];
  if (depth === "1" && info.kind === "directory") {
    for (const entry of target.workspace.listDirectory(target.path)) {
      const path = target.path ? `${target.path}/${entry.name}` : entry.name;
      resources.push({
        target: { ...target, path, href: `${DAV_PREFIX}${encodeURIComponent(target.roomName)}/${path.split("/").map(encodeURIComponent).join("/")}${entry.kind === "directory" ? "/" : ""}` },
        info: entry,
      });
    }
  }
  const body = `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:">${resources.map(resourceXml).join("")}</d:multistatus>`;
  return davResponse(body, 207, { "content-type": "application/xml; charset=utf-8" });
}

function resourceXml(resource: { target: DavTarget; info: { kind: "file" | "directory"; bytes: number; modifiedAt: number } }): string {
  const { target, info } = resource;
  const name = target.path ? posix.basename(target.path) : target.roomName;
  const revision = info.kind === "file" ? target.workspace.fileRevision(target.path) : null;
  const activeLock = currentLock(target);
  return `<d:response><d:href>${xml(target.href)}</d:href><d:propstat><d:prop>`
    + `<d:displayname>${xml(name)}</d:displayname>`
    + `<d:resourcetype>${info.kind === "directory" ? "<d:collection/>" : ""}</d:resourcetype>`
    + `<d:getcontentlength>${info.bytes}</d:getcontentlength>`
    + `<d:getlastmodified>${new Date(info.modifiedAt).toUTCString()}</d:getlastmodified>`
    + `<d:getcontenttype>${info.kind === "directory" ? "httpd/unix-directory" : contentType(target.path)}</d:getcontenttype>`
    + (revision ? `<d:getetag>${xml(etag(revision))}</d:getetag>` : "<d:getetag/>")
    + `<d:supportedlock><d:lockentry><d:lockscope><d:exclusive/></d:lockscope><d:locktype><d:write/></d:locktype></d:lockentry></d:supportedlock>`
    + `<d:lockdiscovery>${activeLock ? activeLockXml(activeLock.token, Math.max(1, Math.ceil((activeLock.expiresAt - Date.now()) / 1_000))) : ""}</d:lockdiscovery>`
    + `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}

function readFile(request: Request, target: DavTarget, head: boolean): Response {
  const info = target.workspace.stat(target.path);
  if (info.kind !== "file") return davResponse("cannot read a directory\n", 405);
  const content = target.workspace.readFileBytes(target.path);
  const revision = target.workspace.fileRevision(target.path)!;
  const headers: Record<string, string> = {
    "content-type": contentType(target.path),
    "content-length": String(content.length),
    etag: etag(revision),
    "last-modified": new Date(info.modifiedAt).toUTCString(),
  };
  if (request.headers.get("if-none-match")?.split(/\s*,\s*/).includes(etag(revision))) return davResponse(null, 304, headers);
  return davResponse(head ? null : content, 200, headers);
}

async function put(request: Request, target: DavTarget, principal: Principal, accounts: AccountStore): Promise<Response> {
  if (!target.path) throw new DavError(403, "cannot replace the room root");
  const parent = posix.dirname(target.path);
  const parentInfo = parent === "." ? target.workspace.stat("") : target.workspace.stat(parent);
  if (parentInfo.kind !== "directory") throw new DavError(409, "parent is not a directory");
  const content = await boundedBody(request, MAX_WORKSPACE_FILE_BYTES);
  const revision = existingRevision(target);
  checkPreconditions(request, revision);
  const result = target.workspace.writeFileBytes(target.path, content, revision);
  accounts.audit(principal, target.roomName, "webdav.write", `${target.path} ${result.bytes}B`);
  return davResponse(null, revision === null ? 201 : 204, { etag: etag(result.revision), location: target.href });
}

function remove(target: DavTarget, principal: Principal, accounts: AccountStore): Response {
  if (!target.path) throw new DavError(403, "cannot delete the room root");
  const info = target.workspace.stat(target.path);
  if (info.kind === "directory") target.workspace.removeDirectory(target.path);
  else target.workspace.deleteFile(target.path);
  clearLocks(target);
  accounts.audit(principal, target.roomName, "webdav.remove", target.path);
  return davResponse(null, 204);
}

function makeCollection(request: Request, target: DavTarget, principal: Principal, accounts: AccountStore): Response {
  if (!target.path) throw new DavError(405, "room root already exists");
  if (Number(request.headers.get("content-length") ?? 0) > 0) throw new DavError(415, "MKCOL request bodies are not supported");
  requireParentDirectory(target);
  target.workspace.createDirectory(target.path);
  accounts.audit(principal, target.roomName, "webdav.mkdir", target.path);
  return davResponse(null, 201, { location: target.href.endsWith("/") ? target.href : `${target.href}/` });
}

function move(request: Request, source: DavTarget, principal: Principal, accounts: AccountStore, directory: RoomDirectory): Response {
  if (!source.path) throw new DavError(403, "cannot move the room root");
  const destination = destinationTarget(request, source.roomName, directory);
  if (!destination.path) throw new DavError(403, "cannot replace the room root");
  assertUnlocked(request, destination, principal);
  const sourceInfo = source.workspace.stat(source.path);
  const destinationInfo = existingInfo(destination);
  if (destinationInfo && request.headers.get("overwrite")?.toUpperCase() === "F") throw new DavError(412, "destination exists");
  if (destinationInfo && (sourceInfo.kind !== "file" || destinationInfo.kind !== "file")) throw new DavError(409, "directory replacement is not supported");
  requireParentDirectory(destination);
  source.workspace.renamePath(source.path, destination.path);
  moveLock(source, destination);
  accounts.audit(principal, source.roomName, "webdav.move", `${source.path} -> ${destination.path}`);
  return davResponse(null, destinationInfo ? 204 : 201, { location: destination.href });
}

function copy(request: Request, source: DavTarget, principal: Principal, accounts: AccountStore, directory: RoomDirectory): Response {
  if (!source.path) throw new DavError(403, "cannot copy the room root");
  const destination = destinationTarget(request, source.roomName, directory);
  const sourceInfo = source.workspace.stat(source.path);
  if (sourceInfo.kind !== "file") throw new DavError(409, "recursive COPY is not supported");
  const destinationInfo = existingInfo(destination);
  if (destinationInfo?.kind === "directory") throw new DavError(409, "destination is a directory");
  if (destinationInfo && request.headers.get("overwrite")?.toUpperCase() === "F") throw new DavError(412, "destination exists");
  assertUnlocked(request, destination, principal);
  requireParentDirectory(destination);
  const content = source.workspace.readFileBytes(source.path);
  const result = destination.workspace.writeFileBytes(destination.path, content, destinationInfo ? destination.workspace.fileRevision(destination.path) : null);
  accounts.audit(principal, source.roomName, "webdav.copy", `${source.path} -> ${destination.path}`);
  return davResponse(null, destinationInfo ? 204 : 201, { etag: etag(result.revision), location: destination.href });
}

function destinationTarget(request: Request, roomName: string, directory: RoomDirectory): DavTarget {
  const raw = request.headers.get("destination");
  if (!raw || raw.length > 2_048) throw new DavError(400, "Destination header is required");
  let destination: URL;
  try { destination = new URL(raw, request.url); }
  catch { throw new DavError(400, "invalid Destination header"); }
  if (destination.host !== new URL(request.url).host || destination.search || destination.hash) throw new DavError(502, "cross-server destination is not permitted");
  const target = parseTarget(destination, directory);
  if (target.roomName !== roomName) throw new DavError(502, "entries cannot move between rooms");
  return target;
}

function lock(request: Request, target: DavTarget, principal: Principal, accounts: AccountStore): Response {
  requireWrite(accounts, principal, target.roomName);
  const existing = currentLock(target);
  const supplied = request.headers.get("if") ?? "";
  const seconds = lockSeconds(request.headers.get("timeout"));
  if (existing) {
    if (existing.principalId !== principal.id || !supplied.includes(existing.token)) throw new DavError(423, "resource is locked");
    existing.expiresAt = Date.now() + seconds * 1_000;
    return lockResponse(existing.token, seconds);
  }
  pruneLocks();
  if (locks.size >= MAX_ACTIVE_LOCKS || [...locks.values()].filter((entry) => entry.principalId === principal.id).length >= MAX_PRINCIPAL_LOCKS) throw new DavError(429, "too many active locks");
  const token = `opaquelocktoken:${randomBytes(16).toString("hex")}`;
  locks.set(lockKey(target), { token, principalId: principal.id, expiresAt: Date.now() + seconds * 1_000 });
  accounts.audit(principal, target.roomName, "webdav.lock", target.path);
  return lockResponse(token, seconds);
}

function unlock(request: Request, target: DavTarget, principal: Principal, accounts: AccountStore): Response {
  const existing = currentLock(target);
  const supplied = request.headers.get("lock-token")?.replace(/^<|>$/g, "");
  if (!existing || existing.principalId !== principal.id || supplied !== existing.token) throw new DavError(409, "lock token does not match");
  locks.delete(lockKey(target));
  accounts.audit(principal, target.roomName, "webdav.unlock", target.path);
  return davResponse(null, 204);
}

function lockResponse(token: string, seconds: number): Response {
  const body = `<?xml version="1.0" encoding="utf-8"?><d:prop xmlns:d="DAV:"><d:lockdiscovery>${activeLockXml(token, seconds)}</d:lockdiscovery></d:prop>`;
  return davResponse(body, 200, { "content-type": "application/xml; charset=utf-8", "lock-token": `<${token}>`, timeout: `Second-${seconds}` });
}

function activeLockXml(token: string, seconds: number): string {
  return `<d:activelock><d:locktype><d:write/></d:locktype><d:lockscope><d:exclusive/></d:lockscope><d:depth>infinity</d:depth><d:timeout>Second-${seconds}</d:timeout><d:locktoken><d:href>${xml(token)}</d:href></d:locktoken></d:activelock>`;
}

function currentLock(target: DavTarget) {
  const key = lockKey(target);
  const existing = locks.get(key);
  if (existing && existing.expiresAt <= Date.now()) { locks.delete(key); return undefined; }
  return existing;
}

function pruneLocks(): void {
  const now = Date.now();
  for (const [key, value] of locks) if (value.expiresAt <= now) locks.delete(key);
}

function assertUnlocked(request: Request, target: DavTarget, principal: Principal): void {
  const existing = currentLock(target);
  if (!existing) return;
  const supplied = `${request.headers.get("if") ?? ""} ${request.headers.get("lock-token") ?? ""}`;
  if (existing.principalId !== principal.id || !supplied.includes(existing.token)) throw new DavError(423, "resource is locked");
}

function clearLocks(target: DavTarget): void {
  const prefix = `${target.roomName}:${target.path}`;
  for (const key of locks.keys()) if (key === prefix || key.startsWith(`${prefix}/`)) locks.delete(key);
}

function moveLock(source: DavTarget, destination: DavTarget): void {
  const existing = currentLock(source);
  if (!existing) return;
  locks.delete(lockKey(source));
  locks.set(lockKey(destination), existing);
}

function lockKey(target: DavTarget): string { return `${target.roomName}:${target.path}`; }
function lockSeconds(header: string | null): number {
  const requested = Number(header?.match(/Second-(\d+)/i)?.[1] ?? 300);
  return Number.isFinite(requested) ? Math.max(30, Math.min(300, Math.floor(requested))) : 300;
}

function requireWrite(accounts: AccountStore, principal: Principal, roomName: string): void {
  if (!accounts.canEditSource(principal, roomName)) throw new DavError(403, "room source is read only");
}

function existingRevision(target: DavTarget): string | null {
  try { return target.workspace.fileRevision(target.path); }
  catch (error) { if (notFound(error)) return null; throw error; }
}

function requireParentDirectory(target: DavTarget): void {
  if (!target.path) throw new DavError(403, "room root is protected");
  const parent = posix.dirname(target.path);
  const info = parent === "." ? target.workspace.stat("") : target.workspace.stat(parent);
  if (info.kind !== "directory") throw new DavError(409, "parent is not a directory");
}

function existingInfo(target: DavTarget): { kind: "file" | "directory"; bytes: number; modifiedAt: number } | undefined {
  try { return target.workspace.stat(target.path); }
  catch (error) { if (notFound(error)) return undefined; throw error; }
}

function checkPreconditions(request: Request, revision: string | null): void {
  const ifMatch = request.headers.get("if-match");
  if (ifMatch && ifMatch !== "*" && (!revision || !ifMatch.split(/\s*,\s*/).includes(etag(revision)))) throw new DavError(412, "file changed");
  if (ifMatch === "*" && !revision) throw new DavError(412, "file does not exist");
  if (request.headers.get("if-none-match") === "*" && revision) throw new DavError(412, "file already exists");
}

async function boundedBody(request: Request, maximum: number): Promise<Buffer> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maximum) throw new DavError(413, "file exceeds 512 KiB limit");
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maximum) { await reader.cancel(); throw new DavError(413, "file exceeds 512 KiB limit"); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, bytes);
}

function davError(error: unknown): Response {
  if (error instanceof DavError) return davResponse(`${error.message}\n`, error.status);
  const message = error instanceof Error ? error.message : "WebDAV request failed";
  if (/not found|directory not found/i.test(message)) return davResponse("not found\n", 404);
  if (/read.only|not permitted|invalid repository path|escapes repository/i.test(message)) return davResponse("forbidden\n", 403);
  if (/changed since|changed$/i.test(message)) return davResponse("precondition failed\n", 412);
  if (/5 MiB|512 KiB|1,000 entry|too large/i.test(message)) return davResponse("storage limit reached\n", 507);
  if (/already exists|not empty|target directory/i.test(message)) return davResponse("conflict\n", 409);
  return davResponse("WebDAV request failed\n", 500);
}

function unauthorized(roomName: string): Response {
  return davResponse("mount credentials required\n", 401, { "www-authenticate": `Basic realm="serverside.chat ${roomName}", charset="UTF-8"` });
}

function davRateLimited(decision: { retryAfterMs: number }): Response {
  return davResponse("slow down\n", 429, { "retry-after": String(retrySeconds({ allowed: false, remaining: 0, ...decision })) });
}

function davResponse(body: BodyInit | null, status: number, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { dav: "1, 2", allow: DAV_METHODS, "ms-author-via": "DAV", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra } });
}

function etag(revision: string): string { return `"${revision}"`; }
function notFound(error: unknown): boolean { return error instanceof Error && /not found/i.test(error.message); }
function xml(value: string): string { return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "�").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" }[char]!)); }
function contentType(path: string): string {
  const extension = posix.extname(path).toLowerCase();
  return ({ ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".ts": "text/plain; charset=utf-8", ".json": "application/json; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" } as Record<string, string>)[extension] ?? "application/octet-stream";
}
