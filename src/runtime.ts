import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { Database } from "bun:sqlite";
import { getQuickJS } from "quickjs-emscripten";
import type { Room } from "./room";
import type { RoomWorkspace } from "./workspace";
import { readBoundedText } from "./bounded-body";

const MAX_BODY = 64 * 1024;
const MAX_RESPONSE = 512 * 1024;
const MAX_ROWS = 200;
const MAX_PARAMS = 100;
const MAX_LOGS = 20;
const MAX_LOG_BYTES = 4 * 1024;
const MAX_REALTIME_EVENTS = 8;
const MAX_REALTIME_EVENT_BYTES = 16 * 1024;
const MAX_REALTIME_BYTES = 32 * 1024;
const MAX_FS_FILE = 512 * 1024;
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".svg": "image/svg+xml" };

export interface GuestResponse { status: number; headers: Record<string, string>; body: string }

export class ServiceRuntime {
  private readonly databasePath: string;
  private readonly scratchRoot: string;
  private filesystemBytes: number;
  constructor(private readonly workspace: RoomWorkspace, private readonly room: Room, dataDir: string) {
    this.databasePath = `${dataDir}/rooms/${workspace.roomName}/service.sqlite`;
    this.scratchRoot = resolve(dataDir, "rooms", workspace.roomName, "scratch");
    mkdirSync(dirname(this.databasePath), { recursive: true });
    mkdirSync(this.scratchRoot, { recursive: true });
    this.filesystemBytes = this.scratchFiles().reduce((sum, file) => sum + file.bytes, 0);
    this.room.recordResources(databaseBytes(this.databasePath), this.filesystemBytes);
  }

  async fetch(request: Request, deploymentRef: string | undefined, servicePath: string, publish?: (payload: string) => void, requestHeaders?: Record<string, string>): Promise<GuestResponse> {
    if (!this.workspace.resolveDeploymentRef(deploymentRef)) return { status: 404, headers: { "content-type": "text/plain; charset=utf-8" }, body: "Deployment not found\n" };
    const body = await boundedBody(request);
    const logs: string[] = [];
    let realtimeEvents = 0;
    let realtimeBytes = 0;
    const db = new Database(this.databasePath, { create: true, strict: true });
    db.exec(`PRAGMA page_size=4096; PRAGMA max_page_count=${Math.max(1, Math.floor(this.room.limits.databaseBytes / 4096))}; PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON`);
    const hostCall = (raw: string): string => {
      const call = JSON.parse(raw) as { op?: string; action?: string; sql?: string; params?: unknown[]; level?: string; event?: unknown; path?: string; method?: string; type?: string; data?: unknown; content?: string };
      if (call.op === "db") return JSON.stringify(this.databaseCall(db, String(call.sql ?? ""), call.params ?? []));
      if (call.op === "asset") return JSON.stringify(this.assetCall(String(call.path ?? "/"), deploymentRef, String(call.method ?? "GET")));
      if (call.op === "fs") return JSON.stringify(this.filesystemCall(String(call.action ?? ""), String(call.path ?? ""), call.content));
      if (call.op === "log") {
        if (logs.length < MAX_LOGS) logs.push(`${String(call.level ?? "info").slice(0, 8)} ${boundedJson(call.event, MAX_LOG_BYTES)}`);
        return "null";
      }
      if (call.op === "realtime") {
        if (realtimeEvents >= MAX_REALTIME_EVENTS) throw new Error("realtime publish limit exceeded");
        const type = String(call.type ?? "message").replace(/[^a-zA-Z0-9_.:-]/g, "").slice(0, 64) || "message";
        const payload = JSON.stringify({ type, data: call.data }) ?? "null";
        const bytes = Buffer.byteLength(payload);
        if (bytes > MAX_REALTIME_EVENT_BYTES || realtimeBytes + bytes > MAX_REALTIME_BYTES) throw new Error("realtime publish byte limit exceeded");
        realtimeEvents++;
        realtimeBytes += bytes;
        publish?.(payload);
        return JSON.stringify({ delivered: Boolean(publish) });
      }
      throw new Error("unknown host capability");
    };
    try {
      const QuickJS = await getQuickJS();
      const runtime = QuickJS.newRuntime();
      runtime.setMemoryLimit(16 * 1024 * 1024);
      runtime.setMaxStackSize(512 * 1024);
      const deadline = performance.now() + 150;
      runtime.setInterruptHandler(() => performance.now() > deadline);
      const vm = runtime.newContext();
      try {
        const bridge = vm.newFunction("__hostCall", (arg) => vm.newString(hostCall(vm.getString(arg))));
        vm.setProp(vm.global, "__hostCall", bridge);
        bridge.dispose();
        const source = this.workspace.readPublished("worker.js", deploymentRef).replace(/\bexport\s+default\s+/, "globalThis.__service = ");
        if (!source.includes("globalThis.__service")) throw new Error("worker.js must use export default { fetch(request, env) { ... } }");
        const loaded = vm.evalCode(`${guestPrelude()}\n${source}`, "worker.js");
        if (loaded.error) { const error = vm.dump(loaded.error); loaded.error.dispose(); throw new Error(String(error?.message ?? error)); }
        loaded.value.dispose();
        const invocation = JSON.stringify({ method: request.method, url: `http://service.local${servicePath}`, headers: requestHeaders ?? Object.fromEntries(request.headers), body });
        const invocationResult = vm.evalCode(`__invoke(${JSON.stringify(invocation)})`, "invoke.js");
        if (invocationResult.error) { const error = vm.dump(invocationResult.error); invocationResult.error.dispose(); throw new Error(String(error?.message ?? error)); }
        const evaluated = invocationResult.value;
        runtime.executePendingJobs();
        const settled = vm.getPromiseState(evaluated);
        if (settled.type === "pending") { evaluated.dispose(); throw new Error("service promise did not settle"); }
        if (settled.type === "rejected") { const error = vm.dump(settled.error); settled.error.dispose(); evaluated.dispose(); throw new Error(String(error?.message ?? error)); }
        const handle = settled.value;
        evaluated.dispose();
        const json = vm.getString(handle);
        handle.dispose();
        const response = JSON.parse(json) as GuestResponse;
        response.status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : 200;
        response.headers = sanitizeHeaders(response.headers);
        response.body = typeof response.body === "string" ? response.body : String(response.body ?? "");
        if (Buffer.byteLength(response.body) > MAX_RESPONSE) throw new Error("response exceeds 512 KiB limit");
        return response;
      } finally { vm.dispose(); runtime.dispose(); }
    } finally {
      db.close();
      this.room.recordResources(databaseBytes(this.databasePath), this.filesystemBytes);
      this.room.recordServiceLogs(logs.map((log) => `guest ${log}`));
    }
  }

  private databaseCall(db: Database, sql: string, params: unknown[]): unknown {
    validateSql(sql, params);
    const kind = sql.trim().split(/\s+/, 1)[0]!.toUpperCase();
    const statement = db.query(sql);
    if (kind === "SELECT" || kind === "WITH") {
      const rows: unknown[] = [];
      for (const row of statement.iterate(...params as never[])) {
        rows.push(row);
        if (rows.length >= MAX_ROWS) break;
      }
      if (Buffer.byteLength(JSON.stringify(rows)) > 256 * 1024) throw new Error("database result exceeds 256 KiB limit");
      return { rows };
    }
    const result = statement.run(...params as never[]);
    if (databaseBytes(this.databasePath) > this.room.limits.databaseBytes) throw new Error("database exceeds the room limit");
    return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
  }

  private assetCall(pathname: string, ref?: string, method = "GET"): GuestResponse {
    if (method !== "GET" && method !== "HEAD") return { status: 405, headers: { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" }, body: "Method not allowed\n" };
    let path: string;
    try { path = pathname === "/" ? "index.html" : decodeURIComponent(pathname.replace(/^\/+/, "")); }
    catch { return { status: 404, headers: { "content-type": "text/plain; charset=utf-8" }, body: "Not found\n" }; }
    const segments = path.split(/[\\/]/);
    if (segments.some((segment) => segment.startsWith(".")) || /^(worker\.js|readme(?:\.[a-z0-9_-]+)?)$/i.test(path)) return { status: 404, headers: { "content-type": "text/plain; charset=utf-8" }, body: "Not found\n" };
    const body = this.workspace.readPublishedAsset(path, ref);
    if (body === undefined) return { status: 404, headers: { "content-type": "text/plain; charset=utf-8" }, body: "Not found\n" };
    return { status: 200, headers: { "content-type": MIME[extname(path).toLowerCase()] ?? "application/octet-stream" }, body };
  }

  private filesystemCall(action: string, path: string, content?: string): unknown {
    if (action === "list") {
      const files = this.scratchFiles();
      this.filesystemBytes = files.reduce((sum, file) => sum + file.bytes, 0);
      return { files };
    }
    const target = this.safeScratchPath(path);
    if (action === "readText") {
      if (!existsSync(target) || !statSync(target).isFile()) throw new Error("scratch file not found");
      if (statSync(target).size > MAX_FS_FILE) throw new Error("scratch file exceeds 512 KiB limit");
      return { content: readFileSync(target, "utf8") };
    }
    if (action === "writeText") {
      if (typeof content !== "string") throw new Error("scratch content must be text");
      const bytes = Buffer.byteLength(content);
      if (bytes > MAX_FS_FILE) throw new Error("scratch file exceeds 512 KiB limit");
      const old = existsSync(target) ? statSync(target).size : 0;
      const total = this.filesystemBytes - old + bytes;
      if (total > this.room.limits.scratchBytes) throw new Error("scratch filesystem exceeds the room limit");
      mkdirSync(dirname(target), { recursive: true });
      const temporary = `${target}.tmp-${crypto.randomUUID()}`;
      writeFileSync(temporary, content, { mode: 0o600 });
      renameSync(temporary, target);
      this.filesystemBytes = total;
      return { path, bytes };
    }
    if (action === "delete") {
      if (!existsSync(target) || !statSync(target).isFile()) throw new Error("scratch file not found");
      const bytes = statSync(target).size;
      unlinkSync(target);
      this.filesystemBytes = Math.max(0, this.filesystemBytes - bytes);
      return { deleted: path };
    }
    throw new Error("unknown scratch filesystem operation");
  }

  private safeScratchPath(path: string): string {
    if (!path || path.includes("\0")) throw new Error("invalid scratch path");
    const target = resolve(this.scratchRoot, path);
    if (!target.startsWith(this.scratchRoot + sep)) throw new Error("scratch path escapes room");
    let cursor = dirname(target);
    while (cursor.startsWith(this.scratchRoot) && cursor !== this.scratchRoot) { if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error("scratch symlinks are forbidden"); cursor = dirname(cursor); }
    return target;
  }

  private scratchFiles(): Array<{ path: string; bytes: number }> {
    const files: Array<{ path: string; bytes: number }> = [];
    const walk = (directory: string) => { for (const entry of readdirSync(directory, { withFileTypes: true })) { const absolute = resolve(directory, entry.name); if (entry.isSymbolicLink()) throw new Error("scratch symlinks are forbidden"); if (entry.isDirectory()) walk(absolute); else if (entry.isFile()) files.push({ path: relative(this.scratchRoot, absolute), bytes: statSync(absolute).size }); if (files.length > 1_000) throw new Error("scratch filesystem exceeds 1,000 files"); } };
    walk(this.scratchRoot);
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }
}

function guestPrelude(): string { return String.raw`
class URL { constructor(value) { this.href=String(value); const match=this.href.match(/^[a-z]+:\/\/[^/]+([^?#]*)?(\?[^#]*)?/i); this.pathname=(match && match[1]) || "/"; this.search=(match && match[2]) || ""; } }
class Request { constructor(data) { Object.assign(this, data); this.path = new URL(data.url).pathname; } text(){ return Promise.resolve(this.body || ""); } json(){ return Promise.resolve(JSON.parse(this.body || "null")); } }
class Response { constructor(body="", init={}) { this.body=String(body ?? ""); this.status=init.status || 200; this.headers=init.headers || {}; } static json(value, init={}) { return new Response(JSON.stringify(value), {...init, headers:{"content-type":"application/json", ...(init.headers||{})}}); } }
const __call = value => JSON.parse(__hostCall(JSON.stringify(value)));
const __log = (event, fields={}) => __call({op:"log",level:"info",event:{event,fields}});
__log.info = (event, fields={}) => __call({op:"log",level:"info",event:{event,fields}});
__log.warn = (event, fields={}) => __call({op:"log",level:"warn",event:{event,fields}});
__log.error = (event, fields={}) => __call({op:"log",level:"error",event:{event,fields}});
const env = Object.freeze({
  db: Object.freeze({ exec(sql, params=[]) { return __call({op:"db",sql,params}); }, query(sql, params=[]) { return __call({op:"db",sql,params}).rows; }, prepare(sql) { return Object.freeze({ all(...params){ return __call({op:"db",sql,params}).rows; }, get(...params){ return __call({op:"db",sql,params}).rows[0] ?? null; }, run(...params){ return __call({op:"db",sql,params}); } }); } }),
  fs: Object.freeze({ list(){return __call({op:"fs",action:"list"}).files}, readText(path){return __call({op:"fs",action:"readText",path}).content}, writeText(path,content){return __call({op:"fs",action:"writeText",path,content})}, delete(path){return __call({op:"fs",action:"delete",path})} }),
  assets: Object.freeze({ fetch(request) { return Promise.resolve(new Response(...(() => { const r=__call({op:"asset",path:new URL(request.url).pathname,method:request.method}); return [r.body,{status:r.status,headers:r.headers}]; })())); } }),
  log: Object.freeze(__log),
  realtime: Object.freeze({ publish(type, data) { return __call({op:"realtime",type,data}); } })
});
async function __invoke(raw) { const request=new Request(JSON.parse(raw)); const handler=globalThis.__service && globalThis.__service.fetch; if(typeof handler!=="function") throw new Error("worker.js must export default.fetch"); const value=await handler(request,env); const response=value instanceof Response ? value : new Response(value && value.body || "", value || {}); return JSON.stringify({status:response.status,headers:response.headers,body:response.body}); }
`; }

async function boundedBody(request: Request): Promise<string> {
  return readBoundedText(request, MAX_BODY);
}

function validateSql(sql: string, params: unknown[]): void {
  if (!sql || sql.length > 16_384 || params.length > MAX_PARAMS || sql.includes("\0")) throw new Error("invalid database operation");
  if (sql.replace(/;\s*$/, "").includes(";")) throw new Error("multiple SQL statements are forbidden");
  if (!/^(SELECT|WITH|INSERT|UPDATE|DELETE|CREATE\s+(TABLE|INDEX))\b/i.test(sql.trim())) throw new Error("SQL operation is not allowed");
  if (/\b(ATTACH|DETACH|PRAGMA|VACUUM|LOAD_EXTENSION|ALTER|DROP|REINDEX)\b/i.test(sql)) throw new Error("SQL operation is not allowed");
  if (/\bRECURSIVE\b/i.test(sql)) throw new Error("recursive SQL is not allowed");
  for (const value of params) if (value !== null && !["string", "number", "boolean"].includes(typeof value)) throw new Error("database parameters must be scalar");
}

function databaseBytes(path: string): number { return [path, `${path}-wal`, `${path}-shm`].reduce((sum, file) => sum + (existsSync(file) ? statSync(file).size : 0), 0); }
function boundedJson(value: unknown, limit: number): string { const json = JSON.stringify(value) ?? "null"; return Buffer.byteLength(json) <= limit ? json : JSON.stringify({ truncated: true }); }
function sanitizeHeaders(value: unknown): Record<string, string> { const output: Record<string, string> = {}; if (!value || typeof value !== "object") return output; for (const [key, raw] of Object.entries(value)) if (/^[a-z0-9-]{1,64}$/i.test(key) && !/[\r\n]/.test(String(raw))) output[key.toLowerCase()] = String(raw).slice(0, 4096); return output; }
