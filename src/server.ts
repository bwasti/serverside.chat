import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { Server, utils, type Connection, type ServerChannel, type Session } from "ssh2";
import { AccountStore, type Principal } from "./auth";
import { Room } from "./room";
import { TuiSession } from "./tui";
import { startWebServer } from "./web";
import { FireworksAgent } from "./agent";
import { RoomWorkspace } from "./workspace";
import { parseSshEntryCommand } from "./ssh-command";
import { OAuthService, type OAuthProviderConfig } from "./oauth";

const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 2222);
const dataDir = process.env.DATA_DIR ?? ".data";
const webBaseUrl = (process.env.WEB_BASE_URL ?? "http://Brams-MacBook-Air.local:3000").replace(/\/$/, "");
const webHost = process.env.WEB_HOST ?? host;
const webPort = Number(process.env.WEB_PORT ?? 3000);
const developmentAuth = process.env.DEVELOPMENT_AUTH !== "false";
const keyPath = `${dataDir}/ssh_host_ed25519_key`;

mkdirSync(dataDir, { recursive: true });
if (!existsSync(keyPath)) {
  const generated = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyPath], { stdio: "inherit" });
  if (generated.status !== 0) throw new Error("Unable to generate SSH host key; is ssh-keygen installed?");
}

const roomOwner = sanitizeUsername(process.env.ROOM_OWNER ?? process.env.USER ?? "owner");
const accounts = new AccountStore(`${dataDir}/accounts.sqlite`);
const oauth = new OAuthService(accounts, webBaseUrl, {
  google: oauthProviderConfig("GOOGLE"),
  github: oauthProviderConfig("GITHUB"),
});
const ownerPrincipal = accounts.ensureLocalOwner(roomOwner, roomOwner);
enrollBootstrapKeys(accounts, ownerPrincipal);
const roomDefaults = [
  { name: "mine", visibility: "public", contributions: "members", agentMode: "passive" },
  { name: "general", visibility: "public", contributions: "members", agentMode: "explicit" },
  { name: "build-log", visibility: "private", contributions: "admins", agentMode: "disabled" },
] as const;
const rooms = roomDefaults.map(({ name, ...defaults }) => {
  const policy = accounts.ensureRoom(name, ownerPrincipal, defaults);
  return new Room(name, 250, `${webBaseUrl}/${encodeURIComponent(name)}`, policy.ownerHandle, `${dataDir}/rooms/${name}/room-state.json`, accounts);
});
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
  for (const room of rooms) room.setAgentResponder(async (history, activity, request) => {
    const workspace = workspaces.get(room.name)!;
    try { return await agent.respond(room.name, room.pageUrl, history, workspace, activity, request.principal.handle, room.owner, request.explicit && accounts.canPromote(request.principal, room.name), (limit) => room.tailServiceLogs(limit)); }
    finally { room.setVersionGraph(workspace.versionGraph()); }
  });
}
const webServer = startWebServer(rooms, workspaces, webHost, webPort, dataDir, accounts, oauth, developmentAuth);
const server = new Server({ hostKeys: [readFileSync(keyPath)] }, (client: Connection) => {
  let principal: Principal | undefined;
  client.on("authentication", (context) => {
    if (context.method !== "publickey") return context.reject(["publickey"]);
    if (!context.key?.algo || !context.key.data) return context.reject(["publickey"]);
    const parsed = utils.parseKey(`${context.key.algo} ${context.key.data.toString("base64")}`);
    const key = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!key || key instanceof Error) return context.reject(["publickey"]);
    if (context.signature) {
      if (!context.blob || key.verify(context.blob, context.signature, context.hashAlgo) !== true) return context.reject(["publickey"]);
      principal = accounts.principalForKey(context.key.algo, context.key.data, sanitizeUsername(context.username));
    }
    context.accept();
  });
  client.on("ready", () => {
    if (!principal) return client.end();
    accounts.audit(principal, undefined, "ssh.login", principal.keyFingerprint ?? "");
    client.on("session", (accept) => {
      const session: Session = accept();
      let cols = 80;
      let rows = 24;
      let hasPty = false;
      let tui: TuiSession | undefined;
      session.on("pty", (acceptPty, _reject, info) => {
        hasPty = true;
        cols = info.cols;
        rows = info.rows;
        acceptPty?.();
      });
      session.on("window-change", (acceptChange, _reject, info) => {
        tui?.resize(info.cols, info.rows);
        acceptChange?.();
      });
      const launch = (stream: ServerChannel, selectedRoom?: string, requirePty = false, inviteToken?: string) => {
        if (requirePty && !hasPty) {
          stream.end("This command needs a terminal. Add -t to the ssh command.\r\n");
          return;
        }
        const visibleRooms = rooms.filter((room) => room.canView(principal!));
        if (!visibleRooms.length) {
          stream.end("No rooms are visible to this account. Ask a room owner for an invitation.\r\n");
          return;
        }
        if (selectedRoom && !visibleRooms.some((room) => room.name === selectedRoom)) {
          stream.end("That room does not exist or is not visible to this account.\r\n");
          return;
        }
        let signInUrl: string | undefined;
        let refreshPrincipal: (() => Principal | undefined) | undefined;
        let authenticatedRoom: string | undefined;
        if (!principal!.authenticated && principal!.sshAlgorithm && principal!.sshKeyBlob) {
          const pairing = accounts.createSshPairing(principal!, principal!.keyFingerprint ?? "", 10 * 60 * 1_000, inviteToken);
          authenticatedRoom = pairing.roomName;
          signInUrl = `${new URL(webBaseUrl).origin}/?ssh=${encodeURIComponent(pairing.code)}`;
          const algorithm = principal!.sshAlgorithm;
          const keyBlob = Buffer.from(principal!.sshKeyBlob);
          const requestedHandle = principal!.requestedHandle;
          refreshPrincipal = () => accounts.principalForKey(algorithm, keyBlob, requestedHandle);
        }
        tui = new TuiSession(stream, rooms, principal!, accounts, selectedRoom, signInUrl, refreshPrincipal, authenticatedRoom);
        tui.resize(cols, rows);
      };
      session.on("shell", (acceptShell) => launch(acceptShell()));
      session.on("exec", (acceptExec, _rejectExec, info) => {
        const stream = acceptExec();
        try {
          const command = parseSshEntryCommand(info.command);
          if (command.kind === "room") launch(stream, command.roomName, true);
          else if (!principal!.authenticated) launch(stream, undefined, true, command.token);
          else {
            const redeemed = accounts.redeem(principal!, command.token);
            principal = redeemed.principal;
            launch(stream, redeemed.roomName, true);
          }
        } catch (error) {
          stream.end(`${error instanceof Error ? error.message : "SSH entry command failed"}\r\n`);
        }
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
  console.log(`serverside.chat listening on ssh://${host}:${port}`);
  console.log(`Connect with: ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null localhost -p ${port}`);
  console.log(`Room pages listening on http://${webHost}:${webServer.port}`);
  console.log(fireworksKey ? `Room agent enabled: ${fireworksModel}` : "Room agent disabled: FIREWORKS_API_KEY is not set");
});

function sanitizeUsername(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 32) || "guest";
}

function enrollBootstrapKeys(accounts: AccountStore, owner: Principal): void {
  const configured = process.env.SSH_BOOTSTRAP_KEYS?.split(":").filter(Boolean);
  const directory = join(homedir(), ".ssh");
  const paths = configured ?? (existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith(".pub")).map((name) => join(directory, name)) : []);
  for (const path of paths) {
    try { accounts.enrollOpenSshKey(owner.id, readFileSync(path, "utf8"), `bootstrap ${path}`); }
    catch (error) { console.warn(`Skipping bootstrap SSH key ${path}:`, error instanceof Error ? error.message : error); }
  }
}

function oauthProviderConfig(name: "GOOGLE" | "GITHUB"): OAuthProviderConfig | undefined {
  const clientId = process.env[`${name}_CLIENT_ID`];
  const clientSecret = process.env[`${name}_CLIENT_SECRET`];
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}
