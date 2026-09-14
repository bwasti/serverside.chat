export type SshEntryCommand = { kind: "account" } | { kind: "room"; roomName: string } | { kind: "shell"; roomName: string } | { kind: "api"; roomName: string; capability: string } | { kind: "invite"; token: string };

export function parseSshEntryCommand(value: string): SshEntryCommand {
  if (Buffer.byteLength(value) > 2_048 || /[\r\n\0]/.test(value)) throw new Error(USAGE);
  const api = value.trim().match(/^api\s+([a-zA-Z0-9_.-]{1,64})\s+(.+)$/);
  if (api) return { kind: "api", roomName: api[1]!, capability: api[2]!.trim() };
  const parts = value.trim().split(/\s+/);
  if (parts.length === 1 && parts[0] === "account") return { kind: "account" };
  if (parts.length !== 2) throw new Error(USAGE);
  if (parts[0] === "room" && /^[a-zA-Z0-9_.-]{1,64}$/.test(parts[1]!)) return { kind: "room", roomName: parts[1]! };
  if (parts[0] === "shell" && /^[a-zA-Z0-9_.-]{1,64}$/.test(parts[1]!)) return { kind: "shell", roomName: parts[1]! };
  if (parts[0] === "invite" && /^[a-zA-Z0-9_-]{20,64}$/.test(parts[1]!)) return { kind: "invite", token: parts[1]! };
  throw new Error(USAGE);
}

const USAGE = "usage: account | room <name> | shell <name> | api <name> <command> | invite <token>";
