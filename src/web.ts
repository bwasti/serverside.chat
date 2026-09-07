import type { Room } from "./room";
import type { RoomWorkspace } from "./workspace";
import { ServiceRuntime } from "./runtime";

interface SocketData { room: string; windowStarted: number; messages: number }
const SOCKET_PATH = ".well-known/realtime";
const MAX_ROOM_SOCKETS = 100;

export function startWebServer(rooms: Room[], workspaces: Map<string, RoomWorkspace>, host: string, port: number, dataDir = ".data") {
  const byName = new Map(rooms.map((room) => [room.name, room]));
  const runtimes = new Map(rooms.map((room) => [room.name, new ServiceRuntime(workspaces.get(room.name)!, room, dataDir)]));
  const socketCounts = new Map<string, number>();
  return Bun.serve<SocketData>({
    hostname: host,
    port,
    async fetch(request, server) {
      const started = performance.now();
      const url = new URL(request.url);
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const name = parts[0] ?? "";
      const room = byName.get(name);
      if (!room) return new Response("room not found\n", { status: 404 });
      if (parts.slice(1).join("/") === SOCKET_PATH) {
        if ((socketCounts.get(name) ?? 0) >= MAX_ROOM_SOCKETS) return new Response("room socket limit reached\n", { status: 503 });
        if (server.upgrade(request, { data: { room: name, windowStarted: Date.now(), messages: 0 } })) return;
        return new Response("websocket upgrade required\n", { status: 426 });
      }
      const workspace = workspaces.get(name)!;
      // Query metadata belongs to the host. The remaining pathname belongs to
      // the service and will be passed through unchanged by the Wasm gateway.
      const deploymentRef = url.searchParams.get("__ref") ?? url.searchParams.get("__preview") ?? (parts[1] === "~preview" ? parts[2] : undefined);
      try {
        const servicePath = `/${parts.slice(1).map(encodeURIComponent).join("/")}${url.search ? `?${[...url.searchParams].filter(([key]) => key !== "__ref" && key !== "__preview").map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&")}` : ""}`.replace(/\?$/, "");
        const result = await runtimes.get(name)!.fetch(request, deploymentRef, servicePath, (payload) => server.publish(`room:${name}`, payload));
        if ((result.headers["content-type"] ?? "").startsWith("text/html")) result.body = injectRealtimeClient(result.body, name);
        room.recordRequest(request.method, url.pathname, result.status, performance.now() - started, Buffer.byteLength(result.body));
        return new Response(result.body, { status: result.status, headers: { ...result.headers, "cache-control": "no-store" } });
      } catch (error) {
        const message = error instanceof Error ? error.message : "service failed";
        room.recordServiceLog(`runtime error ${message}`);
        room.recordRequest(request.method, url.pathname, 500, performance.now() - started, 23);
        return new Response("service execution failed\n", { status: 500 });
      }
    },
    websocket: {
      maxPayloadLength: 16 * 1024,
      idleTimeout: 120,
      open(ws) {
        socketCounts.set(ws.data.room, (socketCounts.get(ws.data.room) ?? 0) + 1);
        ws.subscribe(`room:${ws.data.room}`);
        ws.send(JSON.stringify({ type: "connected", data: { room: ws.data.room } }));
      },
      message(ws, raw) {
        const now = Date.now();
        if (now - ws.data.windowStarted >= 1_000) { ws.data.windowStarted = now; ws.data.messages = 0; }
        if (++ws.data.messages > 20) { ws.close(1013, "rate limit"); return; }
        const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
        let data: unknown;
        try { data = JSON.parse(text); } catch { data = text; }
        const payload = JSON.stringify({ type: "client", data });
        ws.publish(`room:${ws.data.room}`, payload);
      },
      close(ws) { socketCounts.set(ws.data.room, Math.max(0, (socketCounts.get(ws.data.room) ?? 1) - 1)); },
    },
  });
}

function injectRealtimeClient(html: string, room: string): string {
  const script = `<script data-room-runtime>!function(){let s,t=100;function c(){s=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/${encodeURIComponent(room)}/${SOCKET_PATH}');window.roomSocket=s;s.onopen=function(){t=100;window.dispatchEvent(new CustomEvent('roomopen'))};s.onmessage=function(e){let d=e.data;try{d=JSON.parse(d)}catch(_){}window.dispatchEvent(new CustomEvent('roommessage',{detail:d}))};s.onclose=function(){window.dispatchEvent(new CustomEvent('roomclose'));setTimeout(c,t);t=Math.min(t*2,5000)}}c()}();</script>`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${script}</body>`) : `${html}${script}`;
}
