import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { Server, type Connection, type Session } from "ssh2";
import { Room } from "./room";
import { TuiSession } from "./tui";
import { startWebServer } from "./web";
import { FireworksAgent } from "./agent";
import { RoomWorkspace } from "./workspace";

const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 2222);
const dataDir = process.env.DATA_DIR ?? ".data";
const webBaseUrl = (process.env.WEB_BASE_URL ?? "http://Brams-MacBook-Air.local:3000").replace(/\/$/, "");
const webHost = process.env.WEB_HOST ?? host;
const webPort = Number(process.env.WEB_PORT ?? 3000);
const keyPath = `${dataDir}/ssh_host_ed25519_key`;

mkdirSync(dataDir, { recursive: true });
if (!existsSync(keyPath)) {
  const generated = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyPath], { stdio: "inherit" });
  if (generated.status !== 0) throw new Error("Unable to generate SSH host key; is ssh-keygen installed?");
}

const roomOwner = sanitizeUsername(process.env.ROOM_OWNER ?? process.env.USER ?? "owner");
const rooms = ["mine", "general", "build-log"].map(
  (name) => new Room(name, 250, `${webBaseUrl}/${encodeURIComponent(name)}`, roomOwner, `${dataDir}/rooms/${name}/room-state.json`),
);
const workspaces = new Map(rooms.map((room) => [room.name, new RoomWorkspace(dataDir, room.name)]));
for (const room of rooms) {
  const workspace = workspaces.get(room.name)!;
  room.setVersionGraph(workspace.versionGraph());
  room.addAgentLink("head", `${room.pageUrl}?__ref=head`);
  for (const preview of workspace.visiblePreviews()) room.addAgentLink(preview.description, `${room.pageUrl}?__ref=${preview.id}`);
}
const fireworksKey = process.env.FIREWORKS_API_KEY;
const fireworksModel = process.env.FIREWORKS_MODEL ?? "accounts/fireworks/models/glm-5p3-flash";
if (fireworksKey) {
  const prompt = ["prompts/room-agent/system.md", "prompts/room-agent/context.md", "prompts/room-agent/project.md"]
    .map((path) => readFileSync(path, "utf8").trim()).join("\n\n");
  const agent = new FireworksAgent(fireworksKey, fireworksModel, prompt);
  for (const room of rooms) room.setAgentResponder(async (history, activity, requester) => {
    const workspace = workspaces.get(room.name)!;
    try { return await agent.respond(room.name, room.pageUrl, history, workspace, activity, requester, room.owner, (limit) => room.tailServiceLogs(limit)); }
    finally { room.setVersionGraph(workspace.versionGraph()); }
  });
}
const webServer = startWebServer(rooms, workspaces, webHost, webPort, dataDir);
const server = new Server({ hostKeys: [readFileSync(keyPath)] }, (client: Connection) => {
  let username = "guest";
  client.on("authentication", (context) => {
    username = sanitizeUsername(context.username);
    context.accept(); // Development mode: explicitly passwordless.
  });
  client.on("ready", () => {
    client.on("session", (accept) => {
      const session: Session = accept();
      let cols = 80;
      let rows = 24;
      let tui: TuiSession | undefined;
      session.on("pty", (acceptPty, _reject, info) => {
        cols = info.cols;
        rows = info.rows;
        acceptPty?.();
      });
      session.on("window-change", (acceptChange, _reject, info) => {
        tui?.resize(info.cols, info.rows);
        acceptChange?.();
      });
      session.on("shell", (acceptShell) => {
        const stream = acceptShell();
        tui = new TuiSession(stream, rooms, username);
        tui.resize(cols, rows);
      });
    });
  });
  client.on("error", (error) => console.error("SSH client error:", error.message));
});

server.on("error", (error: Error) => {
  console.error("SSH server error:", error.message);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log(`wasm-chat listening on ssh://${host}:${port}`);
  console.log(`Connect with: ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null localhost -p ${port}`);
  console.log(`Room pages listening on http://${webHost}:${webServer.port}`);
  console.log(fireworksKey ? `Room agent enabled: ${fireworksModel}` : "Room agent disabled: FIREWORKS_API_KEY is not set");
});

function sanitizeUsername(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 32) || "guest";
}
