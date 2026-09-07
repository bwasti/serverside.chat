export type SshEntryCommand = { kind: "account" } | { kind: "room"; roomName: string } | { kind: "invite"; token: string };

export function parseSshEntryCommand(value: string): SshEntryCommand {
  const parts = value.trim().split(/\s+/);
  if (parts.length === 1 && parts[0] === "account") return { kind: "account" };
  if (parts.length !== 2) throw new Error("usage: account | room <name> | invite <token>");
  if (parts[0] === "room" && /^[a-zA-Z0-9_.-]{1,64}$/.test(parts[1]!)) return { kind: "room", roomName: parts[1]! };
  if (parts[0] === "invite" && /^[a-zA-Z0-9_-]{20,64}$/.test(parts[1]!)) return { kind: "invite", token: parts[1]! };
  throw new Error("usage: account | room <name> | invite <token>");
}
