export type SshEntryCommand = { kind: "room"; roomName: string } | { kind: "invite"; token: string } | { kind: "approve"; code: string };

export function parseSshEntryCommand(value: string): SshEntryCommand {
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 2) throw new Error("usage: room <name> | invite <token> | approve <code>");
  if (parts[0] === "room" && /^[a-zA-Z0-9_.-]{1,64}$/.test(parts[1]!)) return { kind: "room", roomName: parts[1]! };
  if (parts[0] === "invite" && /^[a-zA-Z0-9_-]{20,64}$/.test(parts[1]!)) return { kind: "invite", token: parts[1]! };
  if (parts[0] === "approve" && /^[0-9A-Fa-f]{6}-?[0-9A-Fa-f]{6}$/.test(parts[1]!)) return { kind: "approve", code: parts[1]!.toUpperCase() };
  throw new Error("usage: room <name> | invite <token> | approve <code>");
}
