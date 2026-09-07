import { ROOM_LIMITS, type Room } from "./room";
import type { ServerWebSocket } from "bun";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AccountStore, Principal } from "./auth";
import type { RoomWorkspace } from "./workspace";
import { ServiceRuntime } from "./runtime";
import { TuiSession, type TuiStream } from "./tui";
import type { OAuthProvider, OAuthService } from "./oauth";

interface ServiceSocketData { kind: "service"; room: string; principal: Principal; windowStarted: number; messages: number }
interface TuiSocketData { kind: "tui"; principal: Principal; cols: number; rows: number; windowStarted: number; messages: number }
type SocketData = ServiceSocketData | TuiSocketData;
const SOCKET_PATH = ".well-known/realtime";
const MAX_ROOM_SOCKETS = 100;
const MAX_BROWSER_TUIS = 128;
const SESSION_COOKIE = "__Host-serverside_session";
const OAUTH_COOKIE = "__Host-serverside_oauth";
const terminalAssets = new Map([
  ["/_terminal/xterm.js", { file: Bun.file("node_modules/@xterm/xterm/lib/xterm.js"), type: "text/javascript; charset=utf-8" }],
  ["/_terminal/xterm.css", { file: Bun.file("node_modules/@xterm/xterm/css/xterm.css"), type: "text/css; charset=utf-8" }],
  ["/_terminal/addon-fit.js", { file: Bun.file("node_modules/@xterm/addon-fit/lib/addon-fit.js"), type: "text/javascript; charset=utf-8" }],
]);

export function startWebServer(rooms: Room[], workspaces: Map<string, RoomWorkspace>, host: string, port: number, dataDir = ".data", accounts?: AccountStore, oauth?: OAuthService, developmentAuth = true) {
  const byName = new Map(rooms.map((room) => [room.name, room]));
  const runtimes = new Map(rooms.map((room) => [room.name, new ServiceRuntime(workspaces.get(room.name)!, room, dataDir)]));
  const socketCounts = new Map<string, number>();
  const sockets = new Map<string, Set<ServerWebSocket<SocketData>>>();
  const browserTuis = new Map<ServerWebSocket<SocketData>, { stream: BrowserTuiStream; session: TuiSession }>();
  const authAttempts = new Map<string, { windowStarted: number; count: number }>();
  const signInUrl = `${rooms[0] ? new URL(rooms[0].pageUrl).origin : `http://${host}:${port}`}/?signin=1`;
  const webServer = Bun.serve<SocketData>({
    hostname: host,
    port,
    async fetch(request, server) {
      const started = performance.now();
      const url = new URL(request.url);
      const sessionToken = readSessionCookie(request);
      const requestPrincipal = accounts?.principalForWebSession(sessionToken ?? "") ?? anonymousWebPrincipal(request);
      const oauthRoute = url.pathname.match(/^\/_auth\/(google|github)\/(start|callback)$/);
      if (oauthRoute && oauth) {
        const provider = oauthRoute[1] as OAuthProvider;
        const action = oauthRoute[2]!;
        if (action === "start" && request.method === "GET") {
          if (!allowAttempt(authAttempts, `oauth:${webAddress(request)}`, 60 * 60 * 1_000, 30)) return new Response("too many sign-in attempts\n", { status: 429 });
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
        if (!allowAttempt(authAttempts, `development:${webAddress(request)}`, 60 * 60 * 1_000, 5)) return Response.json({ error: "too many temporary accounts from this address" }, { status: 429 });
        try {
          const body = await boundedJson(request);
          const handle = typeof body.handle === "string" ? body.handle : "";
          if (!/^[a-zA-Z0-9_.-]{1,32}$/.test(handle)) return Response.json({ error: "choose a handle using letters, numbers, dot, dash, or underscore" }, { status: 400 });
          const created = accounts.createDevelopmentAccount(handle, typeof body.displayName === "string" ? body.displayName : undefined);
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
      if (url.pathname === "/_auth/status" && request.method === "GET") {
        return Response.json(requestPrincipal.authenticated ? { authenticated: true, handle: requestPrincipal.handle } : { authenticated: false }, { headers: { "cache-control": "no-store" } });
      }
      if (url.pathname === "/_auth/logout" && request.method === "POST") {
        if (accounts && sessionToken) accounts.revokeWebSession(sessionToken);
        return Response.json({ authenticated: false }, { headers: { "set-cookie": clearSessionCookie() } });
      }
      if (request.method === "GET" && url.pathname === "/") {
        return new Response(browserTuiHtml(oauth?.available() ?? [], developmentAuth), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }
      const asset = terminalAssets.get(url.pathname);
      if (request.method === "GET" && asset) return new Response(asset.file, { headers: { "content-type": asset.type, "cache-control": "public, max-age=86400" } });
      if (url.pathname === "/_terminal/socket") {
        if (browserTuis.size >= MAX_BROWSER_TUIS) return new Response("browser terminal limit reached\n", { status: 503 });
        const principal = requestPrincipal;
        const cols = boundedDimension(url.searchParams.get("cols"), 80, 40, 300);
        const rows = boundedDimension(url.searchParams.get("rows"), 24, 10, 120);
        if (server.upgrade(request, { data: { kind: "tui", principal, cols, rows, windowStarted: Date.now(), messages: 0 } })) return;
        return new Response("websocket upgrade required\n", { status: 426 });
      }
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const name = parts[0] ?? "";
      const room = byName.get(name);
      if (!room) return new Response("room not found\n", { status: 404 });
      const principal = requestPrincipal;
      if (accounts && !accounts.canView(principal, name)) return new Response("room not found\n", { status: 404 });
      if (parts.slice(1).join("/") === SOCKET_PATH) {
        if ((socketCounts.get(name) ?? 0) >= MAX_ROOM_SOCKETS || room.connectionCount >= ROOM_LIMITS.connections) return new Response("room socket limit reached\n", { status: 503 });
        if (server.upgrade(request, { data: { kind: "service", room: name, principal, windowStarted: Date.now(), messages: 0 } })) return;
        return new Response("websocket upgrade required\n", { status: 426 });
      }
      if (!room.tryBeginRequest()) { room.recordRequest(request.method, url.pathname, 503, performance.now() - started, 19); return new Response("room request limit\n", { status: 503 }); }
      const workspace = workspaces.get(name)!;
      // Query metadata belongs to the host. The remaining pathname belongs to
      // the service and will be passed through unchanged by the Wasm gateway.
      const deploymentRef = url.searchParams.get("__ref") ?? url.searchParams.get("__preview") ?? (parts[1] === "~preview" ? parts[2] : undefined);
      try {
        const servicePath = `/${parts.slice(1).map(encodeURIComponent).join("/")}${url.search ? `?${[...url.searchParams].filter(([key]) => key !== "__ref" && key !== "__preview").map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&")}` : ""}`.replace(/\?$/, "");
        const result = await runtimes.get(name)!.fetch(request, deploymentRef, servicePath, (payload) => server.publish(`room:${name}`, payload));
        if ((result.headers["content-type"] ?? "").startsWith("text/html")) result.body = injectRealtimeClient(result.body, name);
        const bytes = Buffer.byteLength(result.body);
        if (!room.canSendResponse(bytes)) { room.recordRequest(request.method, url.pathname, 429, performance.now() - started, 25); return new Response("hourly byte limit reached\n", { status: 429 }); }
        room.recordRequest(request.method, url.pathname, result.status, performance.now() - started, bytes);
        return new Response(result.body, { status: result.status, headers: { ...result.headers, "cache-control": "no-store" } });
      } catch (error) {
        const message = error instanceof Error ? error.message : "service failed";
        room.recordServiceLog(`runtime error ${message}`);
        room.recordRequest(request.method, url.pathname, 500, performance.now() - started, 23);
        return new Response("service execution failed\n", { status: 500 });
      } finally { room.endRequest(); }
    },
    websocket: {
      maxPayloadLength: 16 * 1024,
      idleTimeout: 120,
      open(ws) {
        if (ws.data.kind === "tui") {
          const stream = new BrowserTuiStream(ws);
          const session = new TuiSession(stream, rooms, ws.data.principal, accounts, undefined, signInUrl);
          session.resize(ws.data.cols, ws.data.rows);
          browserTuis.set(ws, { stream, session });
          return;
        }
        let roomSockets = sockets.get(ws.data.room);
        if (!roomSockets) { roomSockets = new Set(); sockets.set(ws.data.room, roomSockets); }
        roomSockets.add(ws);
        socketCounts.set(ws.data.room, (socketCounts.get(ws.data.room) ?? 0) + 1);
        byName.get(ws.data.room)?.setWebConnections(socketCounts.get(ws.data.room) ?? 0);
        ws.subscribe(`room:${ws.data.room}`);
        ws.send(JSON.stringify({ type: "connected", data: { room: ws.data.room } }));
      },
      message(ws, raw) {
        const now = Date.now();
        if (now - ws.data.windowStarted >= 1_000) { ws.data.windowStarted = now; ws.data.messages = 0; }
        const rateLimit = ws.data.kind === "tui" ? 100 : 20;
        if (++ws.data.messages > rateLimit) { ws.close(1013, "rate limit"); return; }
        const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
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
        const payload = JSON.stringify({ type: "client", data });
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
        socketCounts.set(ws.data.room, Math.max(0, (socketCounts.get(ws.data.room) ?? 1) - 1));
        byName.get(ws.data.room)?.setWebConnections(socketCounts.get(ws.data.room) ?? 0);
      },
    },
  });
  if (accounts) for (const room of rooms) room.subscribeService(() => {
    if (room.policy.visibility !== "private") return;
    for (const socket of sockets.get(room.name) ?? []) if (socket.data.kind === "service" && !room.canView(socket.data.principal)) socket.close(1008, "room is private");
  });
  return webServer;
}

function anonymousWebPrincipal(request: Request): Principal {
  const address = webAddress(request);
  const suffix = createHash("sha256").update(address).digest("hex").slice(0, 6);
  return { id: `anonymous:web:${address}`, kind: "anonymous", handle: `web-${suffix}`, displayName: "Anonymous", authenticated: false };
}

function webAddress(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim() || "direct";
}

function sameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try { return new URL(origin).host === new URL(request.url).host; }
  catch { return false; }
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

async function boundedJson(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > 4_096) throw new Error("request body is too large");
  const text = await request.text();
  if (text.length > 4_096) throw new Error("request body is too large");
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

function injectRealtimeClient(html: string, room: string): string {
  const script = `<script data-room-runtime>!function(){let s,t=100;function c(){s=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/${encodeURIComponent(room)}/${SOCKET_PATH}');window.roomSocket=s;s.onopen=function(){t=100;window.dispatchEvent(new CustomEvent('roomopen'))};s.onmessage=function(e){let d=e.data;try{d=JSON.parse(d)}catch(_){}window.dispatchEvent(new CustomEvent('roommessage',{detail:d}))};s.onclose=function(){window.dispatchEvent(new CustomEvent('roomclose'));setTimeout(c,t);t=Math.min(t*2,5000)}}c()}();</script>`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${script}</body>`) : `${html}${script}`;
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

export function browserTuiHtml(providers: OAuthProvider[] = [], developmentAuth = true): string {
  const providerButtons = providers.map((provider) => `<button class="provider" type="button" data-provider="${provider}">continue with ${provider === "github" ? "GitHub" : "Google"}</button>`).join("");
  const developmentForm = developmentAuth ? `<p id="devwarning">Temporary development access — choose a handle below until Google and GitHub are configured.</p><form id="accountform"><label>handle<input id="handle" name="handle" maxlength="32" pattern="[A-Za-z0-9_.-]+" autocomplete="username" required autofocus></label><button class="primary" type="submit">create temporary account</button></form>` : `<form id="accountform" hidden></form>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>serverside.chat</title>
  <link rel="stylesheet" href="/_terminal/xterm.css">
  <style>
    html,body,#terminal{width:100%;height:100%;margin:0;background:#0d1117;overflow:hidden}
    body{box-sizing:border-box;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}
    #state{position:fixed;right:12px;top:8px;color:#7d8590;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;pointer-events:none;z-index:2}
    #signin{position:fixed;right:14px;bottom:11px;z-index:3;border:0;background:transparent;color:#58a6ff;padding:4px 6px;font:600 13px ui-monospace,SFMono-Regular,Menlo,monospace;cursor:pointer}
    #signin:hover{color:#79c0ff}
    #pairing{position:fixed;inset:0;z-index:4;display:grid;place-items:center;background:#0d1117cc;color:#d8dee9;font:14px ui-monospace,SFMono-Regular,Menlo,monospace}
    #pairing[hidden],#signin[hidden]{display:none}
    #paircard{width:min(560px,calc(100vw - 40px));box-sizing:border-box;border:1px solid #39414d;border-radius:8px;background:#161b22;padding:20px;box-shadow:0 20px 70px #0009}
    #paircard h1{margin:0 0 10px;font-size:16px;color:#58a6ff}#paircard p{color:#9da7b3;line-height:1.5}
    #providers{display:grid;gap:8px;margin:12px 0}#providers:empty{display:none}#providers button{border:1px solid #39414d;border-radius:5px;background:#222933;color:#d8dee9;padding:9px 11px;cursor:pointer;font:13px ui-monospace,SFMono-Regular,Menlo,monospace;text-align:left}#providers button:hover{border-color:#58a6ff}
    #devwarning{color:#d29922!important;font-size:12px}#autherror{min-height:18px;color:#ff7b72!important;font-size:12px}
    #accountform{display:grid;gap:10px}#accountform label{color:#9da7b3;font-size:12px}#accountform input{box-sizing:border-box;width:100%;margin-top:5px;border:1px solid #39414d;border-radius:5px;background:#0d1117;color:#d8dee9;padding:9px;font:14px ui-monospace,SFMono-Regular,Menlo,monospace;outline:none}#accountform input:focus{border-color:#58a6ff}
    #pairactions{display:flex;gap:8px;margin-top:14px}#pairactions button,#accountform button,#linkactions button{border:1px solid #39414d;border-radius:5px;background:#222933;color:#d8dee9;padding:7px 11px;cursor:pointer;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}#pairactions .primary,#accountform .primary,#linkactions .primary{border-color:#1f6feb;background:#1f6feb;color:white}
    .xterm{height:100%;padding:0}.xterm-viewport{overflow-y:hidden!important}
  </style>
</head>
<body>
  <div id="terminal" aria-label="serverside.chat terminal"></div><div id="state">connecting…</div><button id="signin" hidden>sign in</button>
  <div id="pairing" hidden><section id="paircard" role="dialog" aria-modal="true" aria-labelledby="pairtitle"><h1 id="pairtitle">create your account</h1><p id="pairdescription">Sign in to contribute to serverside.chat.</p><div id="providers">${providerButtons}</div>${developmentForm}<div id="linkactions" hidden><button class="primary" id="linkkey">link this SSH key</button></div><p id="autherror"></p><div id="pairactions"><button id="closepair">cancel</button></div></section></div>
  <script src="/_terminal/xterm.js"></script>
  <script src="/_terminal/addon-fit.js"></script>
  <script>
    const state = document.getElementById('state');
    const signin = document.getElementById('signin');
    const pairing = document.getElementById('pairing');
    const pairtitle = document.getElementById('pairtitle');
    const pairdescription = document.getElementById('pairdescription');
    const accountform = document.getElementById('accountform');
    const linkactions = document.getElementById('linkactions');
    const autherror = document.getElementById('autherror');
    const sshCode = new URL(location.href).searchParams.get('ssh');
    const accountCode = new URL(location.href).searchParams.get('account');
    const initialAuthError = new URL(location.href).searchParams.get('auth_error');
    let currentAccount;
    const showSignIn=()=>{pairtitle.textContent=accountCode?'secure your account':'create your account';pairdescription.textContent=accountCode?'Choose an OAuth provider to attach it to your existing serverside.chat account.':sshCode?'Create an account, then attach the SSH key that sent you here.':'Sign in to contribute to serverside.chat.';accountform.hidden=${developmentAuth ? "Boolean(accountCode)" : "true"};const warning=document.getElementById('devwarning');if(warning)warning.hidden=Boolean(accountCode);linkactions.hidden=true;autherror.textContent='';pairing.hidden=false;document.getElementById('handle')?.focus()};
    const showSshLink=()=>{pairtitle.textContent='link SSH key';pairdescription.textContent='Attach this verified SSH key to @'+currentAccount+'. You can link more keys later.';accountform.hidden=true;linkactions.hidden=false;autherror.textContent='';pairing.hidden=false};
    const activateLink=(_event,value)=>{try{const target=new URL(value,location.href);if(target.origin===location.origin&&target.searchParams.get('signin')==='1'){showSignIn();return}if(target.protocol==='http:'||target.protocol==='https:')window.open(target.href,'_blank','noopener')}catch{}};
    const terminal = new Terminal({cursorBlink:true,scrollback:0,fontSize:14,fontFamily:'SFMono-Regular,Menlo,Monaco,Consolas,monospace',theme:{background:'#0d1117',foreground:'#d8dee9',cursor:'#d8dee9'},linkHandler:{activate:activateLink}});
    const fit = new FitAddon.FitAddon();
    terminal.loadAddon(fit); terminal.open(document.getElementById('terminal')); fit.fit(); terminal.focus();
    let socket, retry=250, resizeFrame;
    const send = value => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify(value));
    const connect = () => {
      state.textContent='connecting…'; state.hidden=false;
      const scheme=location.protocol==='https:'?'wss:':'ws:';
      socket=new WebSocket(scheme+'//'+location.host+'/_terminal/socket?cols='+terminal.cols+'&rows='+terminal.rows);
      socket.onopen=()=>{retry=250;state.hidden=true;send({type:'resize',cols:terminal.cols,rows:terminal.rows})};
      socket.onmessage=event=>{try{const message=JSON.parse(event.data);if(message.type==='output')terminal.write(message.data)}catch{}};
      socket.onclose=()=>{state.textContent='reconnecting…';state.hidden=false;setTimeout(connect,retry);retry=Math.min(retry*2,5000)};
    };
    terminal.onData(data=>send({type:'input',data}));
    terminal.onResize(({cols,rows})=>send({type:'resize',cols,rows}));
    addEventListener('resize',()=>{cancelAnimationFrame(resizeFrame);resizeFrame=requestAnimationFrame(()=>fit.fit())});
    document.getElementById('terminal').addEventListener('pointerdown',()=>terminal.focus());
    const checkAuth=async()=>{try{const result=await fetch('/_auth/status',{cache:'no-store'}).then(response=>response.json());currentAccount=result.authenticated?result.handle:undefined;signin.hidden=Boolean(currentAccount);return Boolean(currentAccount)}catch{return false}};
    const linkSsh=async()=>{if(!sshCode)return;autherror.textContent='';const response=await fetch('/_auth/ssh/link',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:sshCode})});const result=await response.json();if(!response.ok)throw new Error(result.error||'could not link SSH key');history.replaceState({},'',location.pathname);pairtitle.textContent='SSH key linked';pairdescription.textContent='This terminal is now signed in as @'+result.handle+'.';linkactions.hidden=true;setTimeout(()=>location.reload(),700)};
    signin.addEventListener('click',showSignIn);
    document.querySelectorAll('[data-provider]').forEach(button=>button.addEventListener('click',()=>{const returnTo=location.pathname+(sshCode?'?ssh='+encodeURIComponent(sshCode):'');const bootstrap=accountCode?'&account='+encodeURIComponent(accountCode):'';location.href='/_auth/'+button.dataset.provider+'/start?return='+encodeURIComponent(returnTo)+bootstrap}));
    accountform.addEventListener('submit',async event=>{event.preventDefault();autherror.textContent='';const button=accountform.querySelector('button');if(!button)return;button.disabled=true;try{const response=await fetch('/_auth/development',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({handle:document.getElementById('handle').value})});const result=await response.json();if(!response.ok)throw new Error(result.error||'could not create account');currentAccount=result.handle;if(sshCode)await linkSsh();else location.reload()}catch(error){autherror.textContent=error.message}finally{button.disabled=false}});
    document.getElementById('linkkey').addEventListener('click',async()=>{try{await linkSsh()}catch(error){autherror.textContent=error.message}});
    document.getElementById('closepair').addEventListener('click',()=>{pairing.hidden=true});
    checkAuth().then(authenticated=>{if(accountCode)showSignIn();else if(sshCode){if(authenticated)showSshLink();else showSignIn()}else if((location.search.includes('signin=1')||initialAuthError)&&!authenticated)showSignIn();if(initialAuthError)autherror.textContent=initialAuthError});
    connect();
  </script>
</body>
</html>`;
}
