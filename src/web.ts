import { ROOM_LIMITS, type Room } from "./room";
import type { ServerWebSocket } from "bun";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AccountStore, Principal } from "./auth";
import { ServiceRuntime } from "./runtime";
import { TuiSession, type AnonymousLobbyReview, type TuiStream } from "./tui";
import type { OAuthProvider, OAuthService } from "./oauth";
import type { RoomDirectory } from "./room-directory";
import { handleWebDavRequest } from "./webdav";
import { AdaptiveRateLimiter, RATE_LIMITS, retrySeconds } from "./rate-limit";
import { readBoundedText, RequestBodyLimitError } from "./bounded-body";
import { documentationIndex, hostedDocument, llmsFullText, llmsText, roomAgentGuide, roomApiManifest } from "./agent-docs";

interface ServiceSocketData { kind: "service"; room: string; principal: Principal; connectionId: string; windowStarted: number; messages: number }
interface TuiSocketData { kind: "tui"; principal: Principal; initialRoom?: string; cols: number; rows: number; windowStarted: number; messages: number }
type SocketData = ServiceSocketData | TuiSocketData;
const SOCKET_PATH = ".well-known/realtime";
const MAX_ROOM_SOCKETS = 100;
const MAX_SERVICE_SOCKETS = 4_096;
const MAX_SERVICE_REQUESTS = 256;
const MAX_BROWSER_TUIS = 128;
const SESSION_COOKIE = "__Host-serverside_session";
const OAUTH_COOKIE = "__Host-serverside_oauth";
const terminalAssets = new Map([
  ["/_terminal/xterm.js", { file: Bun.file("node_modules/@xterm/xterm/lib/xterm.js"), type: "text/javascript; charset=utf-8" }],
  ["/_terminal/xterm.js.map", { file: Bun.file("node_modules/@xterm/xterm/lib/xterm.js.map"), type: "application/json; charset=utf-8" }],
  ["/_terminal/xterm.css", { file: Bun.file("node_modules/@xterm/xterm/css/xterm.css"), type: "text/css; charset=utf-8" }],
  ["/_terminal/addon-fit.js", { file: Bun.file("node_modules/@xterm/addon-fit/lib/addon-fit.js"), type: "text/javascript; charset=utf-8" }],
  ["/_terminal/addon-fit.js.map", { file: Bun.file("node_modules/@xterm/addon-fit/lib/addon-fit.js.map"), type: "application/json; charset=utf-8" }],
]);

export function startWebServer(directory: RoomDirectory, host: string, port: number, dataDir = ".data", accounts?: AccountStore, oauth?: OAuthService, developmentAuth = true, reviewAnonymousLobby?: AnonymousLobbyReview, rateLimiter = new AdaptiveRateLimiter()) {
  const rooms = directory.rooms;
  const workspaces = directory.workspaces;
  const runtimes = new Map<string, { room: Room; runtime: ServiceRuntime }>();
  const socketCounts = new Map<string, number>();
  const sockets = new Map<string, Set<ServerWebSocket<SocketData>>>();
  const browserTuis = new Map<ServerWebSocket<SocketData>, { stream: BrowserTuiStream; session: TuiSession }>();
  let serviceSockets = 0;
  let serviceRequests = 0;
  const authAttempts = new Map<string, { windowStarted: number; count: number }>();
  const signInUrl = `${directory.controlOrigin}/?signin=1`;
  const webServer = Bun.serve<SocketData>({
    hostname: host,
    port,
    async fetch(request, server) {
      const started = performance.now();
      const url = new URL(request.url);
      if (url.pathname === "/_internal/tls-allow" && request.method === "GET") {
        if (request.headers.has("x-forwarded-for")) return new Response(null, { status: 404 });
        const domain = url.searchParams.get("domain") ?? "";
        return new Response(null, { status: directory.roomNameForSiteHostname(domain) ? 204 : 404 });
      }
      const siteRoomName = directory.roomNameForSiteHostname(url.hostname);
      const controlRequest = directory.isControlHostname(url.hostname) || !directory.roomSiteDomain;
      if (!controlRequest && !siteRoomName) return new Response("site not found\n", { status: 404 });
      const clientAddress = trustedClientAddress(request, server.requestIP(request)?.address);
      const sessionToken = controlRequest ? readSessionCookie(request) : undefined;
      const requestPrincipal = accounts?.principalForWebSession(sessionToken ?? "") ?? anonymousWebPrincipal(clientAddress);
      const httpPolicy = url.pathname.startsWith("/_dav/")
        ? RATE_LIMITS.authenticatedHttp
        : requestPrincipal.authenticated ? RATE_LIMITS.authenticatedHttp : RATE_LIMITS.anonymousHttp;
      const httpLimit = rateLimiter.consume(`http:${requestPrincipal.authenticated ? requestPrincipal.id : clientAddress}`, httpPolicy);
      if (!httpLimit.allowed) return rateLimitedResponse(httpLimit.retryAfterMs);
      if (controlRequest) {
      if (request.method === "GET") {
        if (url.pathname === "/llms.txt") return markdownResponse(llmsText(directory.controlOrigin));
        if (url.pathname === "/llms-full.txt") return markdownResponse(llmsFullText(directory.controlOrigin));
        if (url.pathname === "/docs" || url.pathname === "/docs/") return markdownResponse(documentationIndex(directory.controlOrigin));
        const documentRoute = url.pathname.match(/^\/docs\/([a-z0-9-]+\.md)$/);
        if (documentRoute) {
          const document = hostedDocument(documentRoute[1]!);
          return document === undefined ? new Response("document not found\n", { status: 404 }) : markdownResponse(document);
        }
        const roomGuideRoute = url.pathname.match(/^\/room\/([a-z0-9][a-z0-9-]{0,31})(?:\/llms\.txt|\.md)$/);
        const roomApiRoute = url.pathname.match(/^\/room\/([a-z0-9][a-z0-9-]{0,31})\/api\.json$/);
        const documentedRoomName = roomGuideRoute?.[1] ?? roomApiRoute?.[1];
        if (documentedRoomName) {
          const documentedRoom = directory.room(documentedRoomName);
          if (!documentedRoom || (accounts && !accounts.canView(requestPrincipal, documentedRoomName))) return new Response("room not found\n", { status: 404 });
          return roomApiRoute
            ? Response.json(roomApiManifest(documentedRoom, directory.controlOrigin), { headers: { "cache-control": "no-store" } })
            : markdownResponse(roomAgentGuide(documentedRoom, directory.controlOrigin), "no-store");
        }
      }
      const oauthRoute = url.pathname.match(/^\/_auth\/(google|github)\/(start|callback)$/);
      if (oauthRoute && oauth) {
        const provider = oauthRoute[1] as OAuthProvider;
        const action = oauthRoute[2]!;
        if (action === "start" && request.method === "GET") {
          if (!allowAttempt(authAttempts, `oauth:${clientAddress}`, 60 * 60 * 1_000, 30)) return new Response("too many sign-in attempts\n", { status: 429 });
          try {
            const accountLink = url.searchParams.get("account");
            const linkPrincipal = accountLink && accounts ? accounts.consumeAccountLink(accountLink) : requestPrincipal;
            const started = oauth.begin(provider, url.searchParams.get("return") ?? "/", linkPrincipal);
            return new Response(null, { status: 302, headers: { location: started.url, "set-cookie": oauthCookie(started.browserToken) } });
          } catch (error) {
            return authErrorRedirect(request, error);
          }
        }
        if (action === "callback" && request.method === "GET") {
          try {
            const providerError = url.searchParams.get("error");
            if (providerError) throw new Error(providerError === "access_denied" ? "sign-in was cancelled" : "identity provider rejected sign-in");
            const code = url.searchParams.get("code") ?? "";
            const state = url.searchParams.get("state") ?? "";
            const browserToken = readCookie(request, OAUTH_COOKIE) ?? "";
            const result = await oauth.finish(provider, code, state, browserToken);
            directory.prepareAccount(result.principal);
            const headers = new Headers({ location: result.returnTo });
            headers.append("set-cookie", sessionCookie(result.session.sessionToken));
            headers.append("set-cookie", clearOAuthCookie());
            return new Response(null, { status: 302, headers });
          } catch (error) {
            return authErrorRedirect(request, error);
          }
        }
      }
      if (url.pathname === "/_auth/development" && request.method === "POST") {
        if (!developmentAuth) return new Response("not found\n", { status: 404 });
        if (!accounts) return Response.json({ error: "account storage is unavailable" }, { status: 503 });
        if (requestPrincipal.authenticated) return Response.json({ authenticated: true, handle: requestPrincipal.handle });
        if (!sameOriginRequest(request)) return Response.json({ error: "cross-origin sign-in rejected" }, { status: 403 });
        if (!allowAttempt(authAttempts, `development:${clientAddress}`, 60 * 60 * 1_000, 5)) return Response.json({ error: "too many temporary accounts from this address" }, { status: 429 });
        try {
          const body = await boundedJson(request);
          const handle = typeof body.handle === "string" ? body.handle : "";
          if (!/^[a-zA-Z0-9_.-]{1,32}$/.test(handle)) return Response.json({ error: "choose a handle using letters, numbers, dot, dash, or underscore" }, { status: 400 });
          const created = accounts.createDevelopmentAccount(handle, typeof body.displayName === "string" ? body.displayName : undefined);
          directory.prepareAccount(created.principal);
          return Response.json({ authenticated: true, handle: created.principal.handle, temporaryProvider: true }, { headers: { "set-cookie": sessionCookie(created.session.sessionToken) } });
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : "could not create account" }, { status: 400 });
        }
      }
      if (url.pathname === "/_auth/ssh/link" && request.method === "POST") {
        if (!accounts) return Response.json({ error: "account storage is unavailable" }, { status: 503 });
        if (!requestPrincipal.authenticated) return Response.json({ error: "sign in before linking an SSH key" }, { status: 401 });
        if (!sameOriginRequest(request)) return Response.json({ error: "cross-origin key link rejected" }, { status: 403 });
        try {
          const body = await boundedJson(request);
          if (typeof body.code !== "string") throw new Error("SSH link is invalid or expired");
          const linked = accounts.linkSshPairing(requestPrincipal, body.code);
          return Response.json({ linked: true, ...linked, handle: requestPrincipal.handle });
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : "could not link SSH key" }, { status: 400 });
        }
      }
      if (url.pathname === "/_auth/invite/redeem" && request.method === "POST") {
        if (!accounts) return Response.json({ error: "account storage is unavailable" }, { status: 503 });
        if (!requestPrincipal.authenticated) return Response.json({ error: "sign in before accepting an invite" }, { status: 401 });
        if (!sameOriginRequest(request)) return Response.json({ error: "cross-origin invite rejected" }, { status: 403 });
        try {
          const body = await boundedJson(request);
          if (typeof body.token !== "string") throw new Error("invite is invalid or expired");
          const redeemed = accounts.redeemInvite(requestPrincipal, body.token);
          return Response.json({ accepted: true, ...redeemed });
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : "could not accept invite" }, { status: 400 });
        }
      }
      if (url.pathname === "/_auth/status" && request.method === "GET") {
        return Response.json(requestPrincipal.authenticated ? { authenticated: true, handle: requestPrincipal.handle } : { authenticated: false }, { headers: { "cache-control": "no-store" } });
      }
      if (url.pathname === "/_auth/logout" && request.method === "POST") {
        if (!sameOriginRequest(request)) return Response.json({ error: "cross-origin logout rejected" }, { status: 403 });
        if (accounts && sessionToken) accounts.revokeWebSession(sessionToken);
        return Response.json({ authenticated: false }, { headers: { "set-cookie": clearSessionCookie() } });
      }
      if (url.pathname.startsWith("/_dav/")) {
        if (!accounts) return new Response("account storage is unavailable\n", { status: 503 });
        return handleWebDavRequest(request, accounts, directory, rateLimiter, clientAddress);
      }
      const roomRoute = url.pathname.match(/^\/room\/([a-z0-9][a-z0-9-]{0,31})\/?$/);
      const inviteRoute = url.pathname.match(/^\/invite\/([a-zA-Z0-9_-]{20,64})\/?$/);
      if (request.method === "GET" && (url.pathname === "/" || roomRoute || inviteRoute)) {
        if (roomRoute && (!directory.room(roomRoute[1]!) || (accounts && !accounts.canView(requestPrincipal, roomRoute[1]!)))) return new Response("room not found\n", { status: 404 });
        if (roomRoute && request.headers.get("accept")?.includes("text/markdown")) return markdownResponse(roomAgentGuide(directory.room(roomRoute[1]!)!, directory.controlOrigin), "no-store");
        const roomDocs = roomRoute ? `/room/${roomRoute[1]}/llms.txt` : "/llms.txt";
        const headers = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        headers.set("link", `<${roomDocs}>; rel="describedby"; type="text/markdown"${roomRoute ? `, </room/${roomRoute[1]}.md>; rel="alternate"; type="text/markdown"` : ""}`);
        return new Response(browserTuiHtml(oauth?.available() ?? [], developmentAuth, roomDocs), { headers });
      }
      const asset = terminalAssets.get(url.pathname);
      if (request.method === "GET" && asset) return new Response(asset.file, { headers: { "content-type": asset.type, "cache-control": "public, max-age=86400" } });
      if (url.pathname === "/_terminal/socket") {
        if (!permittedSocketOrigin(request)) return new Response("cross-origin websocket rejected\n", { status: 403 });
        if (browserTuis.size >= MAX_BROWSER_TUIS) return new Response("browser terminal limit reached\n", { status: 503 });
        const principal = requestPrincipal;
        directory.prepareAccount(principal);
        const requestedRoom = url.searchParams.get("room") ?? undefined;
        const initialRoom = requestedRoom && directory.room(requestedRoom)?.canView(principal)
          ? requestedRoom
          : directory.room("lobby")?.canView(principal) ? "lobby" : accounts?.ownedRoomNames(principal)[0];
        const cols = boundedDimension(url.searchParams.get("cols"), 80, 40, 300);
        const rows = boundedDimension(url.searchParams.get("rows"), 24, 10, 120);
        if (server.upgrade(request, { data: { kind: "tui", principal, initialRoom, cols, rows, windowStarted: Date.now(), messages: 0 } })) return;
        return new Response("websocket upgrade required\n", { status: 426 });
      }
      }
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const name = siteRoomName ?? parts[0] ?? "";
      const room = directory.room(name);
      if (!room) return new Response("room not found\n", { status: 404 });
      const principal = requestPrincipal;
      if (accounts && !accounts.canView(principal, name)) return new Response("room not found\n", { status: 404 });
      const serviceParts = siteRoomName ? parts : parts.slice(1);
      if (!siteRoomName && directory.roomSiteDomain) {
        const target = new URL(room.pageUrl);
        target.pathname = `/${serviceParts.map(encodeURIComponent).join("/")}`;
        target.search = url.search;
        return Response.redirect(target, 308);
      }
      if (serviceParts.join("/") === SOCKET_PATH) {
        if (!permittedSocketOrigin(request)) return new Response("cross-origin websocket rejected\n", { status: 403 });
        if (serviceSockets >= MAX_SERVICE_SOCKETS) return new Response("service socket capacity reached\n", { status: 503 });
        if ((socketCounts.get(name) ?? 0) >= MAX_ROOM_SOCKETS || room.connectionCount >= ROOM_LIMITS.connections) return new Response("room socket limit reached\n", { status: 503 });
        if (server.upgrade(request, { data: { kind: "service", room: name, principal, connectionId: crypto.randomUUID(), windowStarted: Date.now(), messages: 0 } })) return;
        return new Response("websocket upgrade required\n", { status: 426 });
      }
      if (serviceRequests >= MAX_SERVICE_REQUESTS) return new Response("service request capacity reached\n", { status: 503 });
      if (!room.tryBeginRequest()) { room.recordRequest(request.method, url.pathname, 503, performance.now() - started, 19); return new Response("room request limit\n", { status: 503 }); }
      serviceRequests++;
      const workspace = workspaces.get(name)!;
      // Query metadata belongs to the host. The remaining pathname belongs to
      // the service and will be passed through unchanged by the Wasm gateway.
      const deploymentRef = url.searchParams.get("__ref") ?? url.searchParams.get("__preview") ?? (serviceParts[0] === "~preview" ? serviceParts[1] : undefined);
      try {
        const servicePath = `/${serviceParts.map(encodeURIComponent).join("/")}${url.search ? `?${[...url.searchParams].filter(([key]) => key !== "__ref" && key !== "__preview").map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&")}` : ""}`.replace(/\?$/, "");
        const existingRuntime = runtimes.get(name);
        const runtime = existingRuntime?.room === room
          ? existingRuntime.runtime
          : new ServiceRuntime(workspaces.get(name)!, room, dataDir);
        if (existingRuntime?.room !== room) runtimes.set(name, { room, runtime });
        const result = await runtime.fetch(request, deploymentRef, servicePath, (payload) => server.publish(`room:${name}`, payload), guestRequestHeaders(request.headers, Boolean(siteRoomName)));
        secureGuestResponseHeaders(result.headers, Boolean(siteRoomName));
        if ((result.headers["content-type"] ?? "").startsWith("text/html")) result.body = injectRealtimeClient(result.body, name, Boolean(siteRoomName));
        const bytes = Buffer.byteLength(result.body);
        if (!room.canSendResponse(bytes)) { room.recordRequest(request.method, url.pathname, 429, performance.now() - started, 25); return new Response("hourly byte limit reached\n", { status: 429 }); }
        room.recordRequest(request.method, url.pathname, result.status, performance.now() - started, bytes);
        return new Response(result.body, { status: result.status, headers: { ...result.headers, "cache-control": "no-store" } });
      } catch (error) {
        if (error instanceof RequestBodyLimitError) {
          room.recordRequest(request.method, url.pathname, 413, performance.now() - started, 23);
          return new Response("request body too large\n", { status: 413 });
        }
        const message = error instanceof Error ? error.message : "service failed";
        room.recordServiceLog(`runtime error ${message}`);
        room.recordRequest(request.method, url.pathname, 500, performance.now() - started, 23);
        return new Response("service execution failed\n", { status: 500 });
      } finally { serviceRequests = Math.max(0, serviceRequests - 1); room.endRequest(); }
    },
    websocket: {
      maxPayloadLength: 16 * 1024,
      idleTimeout: 120,
      open(ws) {
        if (ws.data.kind === "tui") {
          const stream = new BrowserTuiStream(ws);
          const session = new TuiSession(stream, rooms, ws.data.principal, accounts, ws.data.initialRoom, signInUrl, undefined, undefined, directory, reviewAnonymousLobby, rateLimiter, false);
          session.resize(ws.data.cols, ws.data.rows);
          browserTuis.set(ws, { stream, session });
          return;
        }
        let roomSockets = sockets.get(ws.data.room);
        if (!roomSockets) { roomSockets = new Set(); sockets.set(ws.data.room, roomSockets); }
        roomSockets.add(ws);
        serviceSockets++;
        socketCounts.set(ws.data.room, (socketCounts.get(ws.data.room) ?? 0) + 1);
        directory.room(ws.data.room)?.setWebConnections(socketCounts.get(ws.data.room) ?? 0);
        ws.subscribe(`room:${ws.data.room}`);
        ws.send(JSON.stringify({ type: "connected", client: realtimeClient(ws.data.principal), connection: ws.data.connectionId, data: { room: ws.data.room } }));
      },
      message(ws, raw) {
        const now = Date.now();
        if (now - ws.data.windowStarted >= 1_000) { ws.data.windowStarted = now; ws.data.messages = 0; }
        const rateLimit = ws.data.kind === "tui" ? 100 : 20;
        if (++ws.data.messages > rateLimit) { ws.close(1013, "rate limit"); return; }
        const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
        const adaptive = rateLimiter.consume(
          `ws:${ws.data.kind}:${ws.data.principal.id}`,
          ws.data.principal.authenticated ? RATE_LIMITS.authenticatedSocket : RATE_LIMITS.anonymousSocket,
          Math.max(1, Math.ceil(Buffer.byteLength(text) / 4_096)),
        );
        if (!adaptive.allowed) { ws.close(1013, `slow down · retry in ${retrySeconds(adaptive)}s`); return; }
        if (ws.data.kind === "tui") {
          const tui = browserTuis.get(ws);
          if (!tui) return;
          try {
            const message = JSON.parse(text) as { type?: unknown; data?: unknown; cols?: unknown; rows?: unknown };
            if (message.type === "input" && typeof message.data === "string") tui.stream.input(message.data.slice(0, 4_096));
            else if (message.type === "resize") tui.session.resize(boundedNumber(message.cols, 80, 40, 300), boundedNumber(message.rows, 24, 10, 120));
          } catch { ws.close(1003, "invalid terminal message"); }
          return;
        }
        let data: unknown;
        try { data = JSON.parse(text); } catch { data = text; }
        const payload = JSON.stringify({ type: "client", client: realtimeClient(ws.data.principal), connection: ws.data.connectionId, data });
        ws.publish(`room:${ws.data.room}`, payload);
      },
      close(ws) {
        if (ws.data.kind === "tui") {
          const tui = browserTuis.get(ws);
          browserTuis.delete(ws);
          tui?.stream.closed();
          return;
        }
        sockets.get(ws.data.room)?.delete(ws);
        serviceSockets = Math.max(0, serviceSockets - 1);
        socketCounts.set(ws.data.room, Math.max(0, (socketCounts.get(ws.data.room) ?? 1) - 1));
        directory.room(ws.data.room)?.setWebConnections(socketCounts.get(ws.data.room) ?? 0);
      },
    },
  });
  const watchedRooms = new WeakSet<Room>();
  const watchRoom = (room: Room) => {
    if (!accounts || watchedRooms.has(room)) return;
    watchedRooms.add(room);
    room.subscribeService(() => {
      if (room.policy.visibility !== "private") return;
      for (const socket of sockets.get(room.name) ?? []) if (socket.data.kind === "service" && !room.canView(socket.data.principal)) socket.close(1008, "room is private");
    });
  };
  for (const room of rooms) watchRoom(room);
  directory.subscribe((event) => {
    const retired = event.previousName ?? (event.kind === "delete" ? event.name : undefined);
    if (retired) {
      for (const socket of sockets.get(retired) ?? []) socket.close(1008, "room moved or deleted");
      sockets.delete(retired);
      socketCounts.delete(retired);
      runtimes.delete(retired);
    }
    const room = directory.room(event.name);
    if (room) watchRoom(room);
  });
  return webServer;
}

function anonymousWebPrincipal(address: string): Principal {
  const suffix = createHash("sha256").update(address).digest("hex").slice(0, 6);
  return { id: `anonymous:web:${address}`, kind: "anonymous", handle: `web-${suffix}`, displayName: "Anonymous", authenticated: false };
}

export function trustedClientAddress(request: Request, peerAddress?: string): string {
  const peer = peerAddress || "direct";
  const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
  return loopback ? request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim() || peer : peer;
}

function sameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try { return new URL(origin).host === new URL(request.url).host; }
  catch { return false; }
}

export function permittedSocketOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.host === new URL(request.url).host;
  }
  catch { return false; }
}

export function realtimeClient(principal: Principal): { id: string; authenticated: boolean; handle?: string } {
  const id = createHash("sha256").update(principal.id).digest("base64url").slice(0, 16);
  return principal.authenticated ? { id, authenticated: true, handle: principal.handle } : { id, authenticated: false };
}

function allowAttempt(entries: Map<string, { windowStarted: number; count: number }>, key: string, windowMs: number, limit: number): boolean {
  const now = Date.now();
  const current = entries.get(key);
  if (!current || now - current.windowStarted >= windowMs) {
    entries.set(key, { windowStarted: now, count: 1 });
    if (entries.size > 10_000) for (const [entryKey, entry] of entries) if (now - entry.windowStarted >= windowMs) entries.delete(entryKey);
    return true;
  }
  current.count++;
  return current.count <= limit;
}

function rateLimitedResponse(retryAfterMs: number): Response {
  return new Response("slow down\n", {
    status: 429,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "retry-after": String(Math.max(1, Math.ceil(retryAfterMs / 1_000))),
      "cache-control": "no-store",
    },
  });
}

async function boundedJson(request: Request): Promise<Record<string, unknown>> {
  let text: string;
  try { text = await readBoundedText(request, 4_096); }
  catch (error) { if (error instanceof RequestBodyLimitError) throw new Error("request body is too large"); throw error; }
  const value: unknown = JSON.parse(text || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request body must be an object");
  return value as Record<string, unknown>;
}

function readSessionCookie(request: Request): string | undefined {
  return readCookie(request, SESSION_COOKIE);
}

function readCookie(request: Request, name: string): string | undefined {
  const prefix = `${name}=`;
  return request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length);
}

function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`;
}

function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

function oauthCookie(token: string): string {
  return `${OAUTH_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;
}

function clearOAuthCookie(): string {
  return `${OAUTH_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function authErrorRedirect(_request: Request, error: unknown): Response {
  const message = error instanceof Error ? error.message : "sign-in failed";
  const headers = new Headers({ location: `/?auth_error=${encodeURIComponent(message.slice(0, 160))}` });
  headers.append("set-cookie", clearOAuthCookie());
  return new Response(null, { status: 302, headers });
}

function injectRealtimeClient(html: string, room: string, roomOrigin: boolean): string {
  const socketPath = roomOrigin ? `/${SOCKET_PATH}` : `/${encodeURIComponent(room)}/${SOCKET_PATH}`;
  const script = `<script data-room-runtime>!function(){let s,t=100;function c(){s=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'${socketPath}');window.roomSocket=s;s.onopen=function(){t=100;window.dispatchEvent(new CustomEvent('roomopen'))};s.onmessage=function(e){let d=e.data;try{d=JSON.parse(d)}catch(_){}window.dispatchEvent(new CustomEvent('roommessage',{detail:d}))};s.onclose=function(){window.dispatchEvent(new CustomEvent('roomclose'));setTimeout(c,t);t=Math.min(t*2,5000)}}c()}();</script>`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${script}</body>`) : `${html}${script}`;
}

export function guestRequestHeaders(headers: Headers, roomOrigin: boolean): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of headers) {
    const normalized = key.toLowerCase();
    if (normalized === "host" || normalized === "forwarded" || normalized === "proxy-authorization" || normalized === "proxy-authenticate" || normalized.startsWith("x-forwarded-") || normalized === "x-real-ip") continue;
    if (!roomOrigin && (normalized === "cookie" || normalized === "authorization")) continue;
    output[normalized] = value;
  }
  return output;
}

export function secureGuestResponseHeaders(headers: Record<string, string>, roomOrigin: boolean): void {
  const cookie = headers["set-cookie"];
  if (cookie && (!roomOrigin || /(?:^|;)\s*domain\s*=/i.test(cookie))) delete headers["set-cookie"];
  delete headers["proxy-authenticate"];
  headers["x-content-type-options"] = "nosniff";
  headers["x-frame-options"] = "DENY";
  headers["referrer-policy"] = "same-origin";
  headers["permissions-policy"] = "camera=(), microphone=(), geolocation=(), payment=(), usb=()";
}

class BrowserTuiStream extends EventEmitter implements TuiStream {
  destroyed = false;

  constructor(private readonly socket: ServerWebSocket<SocketData>) { super(); }

  write(value: string): boolean {
    if (this.destroyed) return false;
    this.socket.send(JSON.stringify({ type: "output", data: value }));
    return true;
  }

  input(value: string): void {
    if (!this.destroyed) this.emit("data", Buffer.from(value));
  }

  end(value?: string): void {
    if (value) this.write(value);
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("end");
    this.socket.close(1000, "terminal ended");
  }

  closed(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }
}

function boundedDimension(value: string | null, fallback: number, minimum: number, maximum: number): number {
  return boundedNumber(value === null ? undefined : Number(value), fallback, minimum, maximum);
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.floor(value))) : fallback;
}

function markdownResponse(body: string, cacheControl = "public, max-age=300"): Response {
  return new Response(body, { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": cacheControl, "x-content-type-options": "nosniff" } });
}

export function browserTuiHtml(providers: OAuthProvider[] = [], developmentAuth = true, agentGuide = "/llms.txt"): string {
  const providerButtons = providers.map((provider) => `<button class="provider" type="button" data-provider="${provider}">continue with ${provider === "github" ? "GitHub" : "Google"}</button>`).join("");
  const developmentForm = developmentAuth ? `<p id="devwarning">Temporary development access — choose a handle below until Google and GitHub are configured.</p><form id="accountform"><label>handle<input id="handle" name="handle" maxlength="32" pattern="[A-Za-z0-9_.-]+" autocomplete="username" required autofocus></label><button class="primary" type="submit">create temporary account</button></form>` : `<form id="accountform" hidden></form>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>serverside.chat</title>
  <link rel="describedby" type="text/markdown" href="${agentGuide}">
  <link rel="alternate" type="text/markdown" href="${agentGuide}">
  <link rel="stylesheet" href="/_terminal/xterm.css">
  <style>
    html{width:100%;height:100%;margin:0;background:#3f3f3f;overflow:hidden}
    body{position:fixed;left:0;right:0;top:0;bottom:auto;height:100dvh;box-sizing:border-box;margin:0;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);background:#3f3f3f;overflow:hidden}
    #terminal-shell{box-sizing:border-box;width:100%;height:100%;display:flex;flex-direction:column;min-height:0;background:#3f3f3f}
    #terminal{box-sizing:border-box;width:100%;height:auto;flex:1 1 auto;min-height:0;padding:1px;overflow:hidden;background:#3f3f3f}
    #mobilekeys{position:relative;display:none;box-sizing:border-box;flex:0 0 44px;gap:4px;padding:4px;background:#333333;border-top:1px solid #5f5f5f}
    #mobileinput{position:absolute;left:50%;top:50%;width:2px;height:2px;margin:0;padding:0;border:0;opacity:.01;font-size:16px;line-height:1;resize:none;caret-color:transparent}
    #mobilekeys button{min-width:0;flex:1;border:1px solid #5f5f5f;border-radius:5px;background:#4f4f4f;color:#dcdccc;font:600 14px ui-monospace,SFMono-Regular,Menlo,monospace;touch-action:manipulation;-webkit-user-select:none;user-select:none}
    #mobilekeys button:active{border-color:#8cd0d3;background:#5f5f5f;color:#f0dfaf}
    #state{position:fixed;right:12px;top:8px;color:#9fafaf;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;pointer-events:none;z-index:2}
    #pairing{position:fixed;inset:0;z-index:4;display:grid;place-items:center;background:#3f3f3fcc;color:#dcdccc;font:14px ui-monospace,SFMono-Regular,Menlo,monospace}
    #pairing[hidden]{display:none}
    #paircard{width:min(560px,calc(100vw - 40px));box-sizing:border-box;border:1px solid #5f5f5f;border-radius:8px;background:#2b2b2b;padding:20px;box-shadow:0 20px 70px #1f1f1fcc}
    #paircard h1{margin:0 0 10px;font-size:16px;color:#8cd0d3}#paircard p{color:#9fafaf;line-height:1.5}
    #providers{display:grid;gap:8px;margin:12px 0}#providers:empty{display:none}#providers button{border:1px solid #5f5f5f;border-radius:5px;background:#4f4f4f;color:#dcdccc;padding:9px 11px;cursor:pointer;font:13px ui-monospace,SFMono-Regular,Menlo,monospace;text-align:left}#providers button:hover{border-color:#8cd0d3}
    #devwarning{color:#f0dfaf!important;font-size:12px}#autherror{min-height:18px;color:#cc9393!important;font-size:12px}
    #accountform{display:grid;gap:10px}#accountform label{color:#9fafaf;font-size:12px}#accountform input{box-sizing:border-box;width:100%;margin-top:5px;border:1px solid #5f5f5f;border-radius:5px;background:#3f3f3f;color:#dcdccc;padding:9px;font:14px ui-monospace,SFMono-Regular,Menlo,monospace;outline:none}#accountform input:focus{border-color:#8cd0d3}
    #pairactions{display:flex;gap:8px;margin-top:14px}#pairactions button,#accountform button,#linkactions button{border:1px solid #5f5f5f;border-radius:5px;background:#4f4f4f;color:#dcdccc;padding:7px 11px;cursor:pointer;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}#pairactions .primary,#accountform .primary,#linkactions .primary{border-color:#8cd0d3;background:#5f7f7f;color:#dcdccc}
    .xterm{width:100%;height:100%;padding:0}.xterm-viewport{overflow-y:hidden!important}
    html.mobile-device #mobilekeys{display:flex}
  </style>
</head>
<body>
  <main id="terminal-shell"><div id="terminal" aria-label="serverside.chat terminal"></div><nav id="mobilekeys" aria-label="terminal keys"><textarea id="mobileinput" rows="1" inputmode="text" enterkeyhint="send" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" aria-label="chat keyboard input"></textarea><button type="button" data-terminal-key="tab">TAB</button><button type="button" data-terminal-key="escape">ESC</button><button type="button" data-terminal-key="left" aria-label="left arrow">←</button><button type="button" data-terminal-key="up" aria-label="up arrow">↑</button><button type="button" data-terminal-key="down" aria-label="down arrow">↓</button><button type="button" data-terminal-key="right" aria-label="right arrow">→</button></nav></main><div id="state">connecting…</div>
  <div id="pairing" hidden><section id="paircard" role="dialog" aria-modal="true" aria-labelledby="pairtitle"><h1 id="pairtitle">create your account</h1><p id="pairdescription">Sign in to contribute to serverside.chat.</p><div id="providers">${providerButtons}</div>${developmentForm}<div id="linkactions" hidden><button class="primary" id="linkkey">link this SSH key</button></div><p id="autherror"></p><div id="pairactions"><button id="closepair">cancel</button></div></section></div>
  <script src="/_terminal/xterm.js"></script>
  <script src="/_terminal/addon-fit.js"></script>
  <script>
    const state = document.getElementById('state');
    const pairing = document.getElementById('pairing');
    const pairtitle = document.getElementById('pairtitle');
    const pairdescription = document.getElementById('pairdescription');
    const accountform = document.getElementById('accountform');
    const linkactions = document.getElementById('linkactions');
    const autherror = document.getElementById('autherror');
    const terminalShell = document.getElementById('terminal-shell');
    const mobileKeys = document.getElementById('mobilekeys');
    const mobileInput = document.getElementById('mobileinput');
    const pageUrl = new URL(location.href);
    const sshCode = pageUrl.searchParams.get('ssh');
    const accountCode = pageUrl.searchParams.get('account');
    const initialAuthError = pageUrl.searchParams.get('auth_error');
    const inviteMatch = location.pathname.match(new RegExp('^/invite/([a-zA-Z0-9_-]{20,64})/?$'));
    const inviteToken = inviteMatch?.[1];
    let currentAccount;
    const showSignIn=()=>{const linking=Boolean(accountCode||currentAccount);pairtitle.textContent=inviteToken?'accept room invite':linking?'add a sign-in method':'create your account';pairdescription.textContent=inviteToken?'Sign in to accept this invitation with your serverside.chat account.':accountCode?'Choose an OAuth provider to attach it to your existing serverside.chat account.':sshCode?'Create an account, then attach the SSH key that sent you here.':linking?'Attach another OAuth provider to @'+currentAccount+'.':'Sign in to contribute to serverside.chat.';accountform.hidden=${developmentAuth ? "Boolean(accountCode||currentAccount)" : "true"};const warning=document.getElementById('devwarning');if(warning)warning.hidden=linking;linkactions.hidden=true;autherror.textContent='';pairing.hidden=false;document.getElementById('handle')?.focus()};
    const showSshLink=()=>{pairtitle.textContent='link SSH key';pairdescription.textContent='Attach this verified SSH key to @'+currentAccount+'. You can link more keys later.';accountform.hidden=true;linkactions.hidden=false;autherror.textContent='';pairing.hidden=false};
    const activateLink=(_event,value)=>{try{const target=new URL(value,location.href);if(target.origin===location.origin&&target.searchParams.get('signin')==='1'){showSignIn();return}if(target.protocol==='http:'||target.protocol==='https:')window.open(target.href,'_blank','noopener')}catch{}};
    const mobileDevice=/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1)||navigator.userAgentData?.mobile===true;
    document.documentElement.classList.toggle('mobile-device',mobileDevice);
    const terminalHost = document.getElementById('terminal');
    const compactScreen = matchMedia('(max-width:600px)');
    const terminal = new Terminal({cursorBlink:true,scrollback:0,fontSize:compactScreen.matches?13:14,fontFamily:'SFMono-Regular,Menlo,Monaco,Consolas,monospace',theme:{background:'#3f3f3f',foreground:'#dcdccc',cursor:'#f0dfaf',cursorAccent:'#3f3f3f',selectionBackground:'#5f5f5f',black:'#3f3f3f',red:'#cc9393',green:'#7f9f7f',yellow:'#f0dfaf',blue:'#8cd0d3',magenta:'#dc8cc3',cyan:'#93e0e3',white:'#dcdccc',brightBlack:'#7f7f7f',brightRed:'#dca3a3',brightGreen:'#9fc59f',brightYellow:'#f8f1c7',brightBlue:'#94bff3',brightMagenta:'#ec93d3',brightCyan:'#93e0e3',brightWhite:'#ffffff'},linkHandler:{activate:activateLink}});
    const fit = new FitAddon.FitAddon();
    terminal.loadAddon(fit); terminal.open(terminalHost); fit.fit();
    if(terminal.textarea){terminal.textarea.inputMode='text';terminal.textarea.enterKeyHint='send';terminal.textarea.autocomplete='off';terminal.textarea.autocapitalize='off';terminal.textarea.spellcheck=false;terminal.textarea.setAttribute('virtualkeyboardpolicy','auto')}
    terminal.parser.registerOscHandler(777,value=>{if(value==='signin'){showSignIn();return true}if(value.startsWith('room:')){try{const room=decodeURIComponent(value.slice(5));if(/^[a-z0-9][a-z0-9-]{0,31}$/.test(room))history.replaceState({},'',room==='lobby'?'/':'/room/'+encodeURIComponent(room))}catch{}return true}if(value.startsWith('open:')){try{const target=new URL(decodeURIComponent(value.slice(5)),location.href);if(target.origin===location.origin){location.href=target.href;return true}}catch{}return true}return false});
    terminal.attachCustomKeyEventHandler(event=>{if(event.type==='keydown'&&event.shiftKey){const sequence=event.key==='ArrowUp'?'\\x1b[1;2A':event.key==='ArrowDown'?'\\x1b[1;2B':event.key==='Enter'?'\\x1b[13;2u':'';if(sequence){event.preventDefault();send({type:'input',data:sequence});return false}}if(event.type==='keydown'&&event.ctrlKey&&['s','p','q'].includes(event.key.toLowerCase()))event.preventDefault();return true});
    let socket, retry=250, resizeFrame, settleFrame;
    const refit=()=>{cancelAnimationFrame(resizeFrame);cancelAnimationFrame(settleFrame);resizeFrame=requestAnimationFrame(()=>{fit.fit();settleFrame=requestAnimationFrame(()=>fit.fit())})};
    const syncViewport=()=>{const viewport=window.visualViewport;document.body.style.height=(viewport?.height||innerHeight)+'px';refit()};
    const focusInput=()=>{if(mobileDevice)mobileInput.focus({preventScroll:true});else terminal.focus()};
    const send = value => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify(value));
    const connect = () => {
      state.textContent='connecting…'; state.hidden=false;
      const scheme=location.protocol==='https:'?'wss:':'ws:';
      const pathParts=location.pathname.split('/').filter(Boolean);const pathRoom=pathParts.length===2&&pathParts[0]==='room'&&/^[a-z0-9][a-z0-9-]{0,31}$/.test(pathParts[1])?pathParts[1]:null;const requestedRoom=new URL(location.href).searchParams.get('room')||pathRoom;
      socket=new WebSocket(scheme+'//'+location.host+'/_terminal/socket?cols='+terminal.cols+'&rows='+terminal.rows+(requestedRoom?'&room='+encodeURIComponent(requestedRoom):''));
      socket.onopen=()=>{retry=250;state.hidden=true;send({type:'resize',cols:terminal.cols,rows:terminal.rows})};
      socket.onmessage=event=>{try{const message=JSON.parse(event.data);if(message.type==='output')terminal.write(message.data)}catch{}};
      socket.onclose=()=>{state.textContent='reconnecting…';state.hidden=false;setTimeout(connect,retry);retry=Math.min(retry*2,5000)};
    };
    terminal.onData(data=>send({type:'input',data}));
    terminal.onResize(({cols,rows})=>send({type:'resize',cols,rows}));
    const escapeKey=String.fromCharCode(27);const terminalKeys={tab:String.fromCharCode(9),escape:escapeKey,left:escapeKey+'[D',up:escapeKey+'[A',down:escapeKey+'[B',right:escapeKey+'[C'};
    mobileKeys.addEventListener('pointerdown',event=>{const button=event.target.closest?.('[data-terminal-key]');const sequence=button&&terminalKeys[button.dataset.terminalKey];if(!sequence)return;event.preventDefault();focusInput();send({type:'input',data:sequence})});
    let composing=false;
    mobileInput.addEventListener('compositionstart',()=>{composing=true});
    mobileInput.addEventListener('compositionend',event=>{composing=false;if(event.data)send({type:'input',data:event.data});mobileInput.value=''});
    mobileInput.addEventListener('keydown',event=>{const data=event.key==='Enter'?String.fromCharCode(13):event.key==='Backspace'?String.fromCharCode(127):event.key==='Tab'?terminalKeys.tab:event.key==='Escape'?terminalKeys.escape:event.key==='ArrowLeft'?terminalKeys.left:event.key==='ArrowUp'?terminalKeys.up:event.key==='ArrowDown'?terminalKeys.down:event.key==='ArrowRight'?terminalKeys.right:'';if(data){event.preventDefault();send({type:'input',data})}});
    mobileInput.addEventListener('input',()=>{if(composing)return;const data=mobileInput.value;mobileInput.value='';if(data)send({type:'input',data})});
    addEventListener('resize',syncViewport);
    window.visualViewport?.addEventListener('resize',syncViewport);
    compactScreen.addEventListener('change',event=>{terminal.options.fontSize=event.matches?13:14;refit()});
    new ResizeObserver(refit).observe(terminalHost);
    document.fonts?.ready.then(refit);
    terminalHost.addEventListener('pointerdown',focusInput);
    terminalHost.addEventListener('wheel',event=>{if(!event.deltaY)return;event.preventDefault();const button=event.deltaY<0?64:65;send({type:'input',data:escapeKey+'[<'+button+';1;1M'})},{passive:false});
    syncViewport();
    focusInput();
    const checkAuth=async()=>{try{const result=await fetch('/_auth/status',{cache:'no-store'}).then(response=>response.json());currentAccount=result.authenticated?result.handle:undefined;return Boolean(currentAccount)}catch{return false}};
    const linkSsh=async()=>{if(!sshCode)return;autherror.textContent='';const response=await fetch('/_auth/ssh/link',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:sshCode})});const result=await response.json();if(!response.ok)throw new Error(result.error||'could not link SSH key');history.replaceState({},'',location.pathname);pairtitle.textContent='SSH key linked';pairdescription.textContent='This terminal is now signed in as @'+result.handle+'.';linkactions.hidden=true;setTimeout(()=>location.reload(),700)};
    const redeemInvite=async()=>{if(!inviteToken)return false;autherror.textContent='';const response=await fetch('/_auth/invite/redeem',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:inviteToken})});const result=await response.json();if(!response.ok)throw new Error(result.error||'could not accept invite');location.href='/room/'+encodeURIComponent(result.roomName);return true};
    document.querySelectorAll('[data-provider]').forEach(button=>button.addEventListener('click',()=>{const returnTo=location.pathname+(sshCode?'?ssh='+encodeURIComponent(sshCode):'');const bootstrap=accountCode?'&account='+encodeURIComponent(accountCode):'';location.href='/_auth/'+button.dataset.provider+'/start?return='+encodeURIComponent(returnTo)+bootstrap}));
    accountform.addEventListener('submit',async event=>{event.preventDefault();autherror.textContent='';const button=accountform.querySelector('button');if(!button)return;button.disabled=true;try{const response=await fetch('/_auth/development',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({handle:document.getElementById('handle').value})});const result=await response.json();if(!response.ok)throw new Error(result.error||'could not create account');currentAccount=result.handle;if(sshCode)await linkSsh();else if(inviteToken)await redeemInvite();else location.reload()}catch(error){autherror.textContent=error.message}finally{button.disabled=false}});
    document.getElementById('linkkey').addEventListener('click',async()=>{try{await linkSsh()}catch(error){autherror.textContent=error.message}});
    document.getElementById('closepair').addEventListener('click',()=>{pairing.hidden=true});
    checkAuth().then(async authenticated=>{if(accountCode)showSignIn();else if(sshCode){if(authenticated)showSshLink();else showSignIn()}else if(inviteToken){if(authenticated){try{await redeemInvite()}catch(error){showSignIn();autherror.textContent=error.message}}else showSignIn()}else if((location.search.includes('signin=1')||initialAuthError)&&!authenticated)showSignIn();if(initialAuthError)autherror.textContent=initialAuthError});
    connect();
  </script>
</body>
</html>`;
}
