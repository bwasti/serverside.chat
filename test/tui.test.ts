import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerChannel } from "ssh2";
import { AccountStore, anonymousPrincipal } from "../src/auth";
import { Room } from "../src/room";
import { RoomDirectory } from "../src/room-directory";
import { layoutComposer, renderServiceLog, slashCommandMatches, TuiSession } from "../src/tui";
import { AdaptiveRateLimiter } from "../src/rate-limit";

class FakeStream extends EventEmitter {
  destroyed = false;
  readonly writes: string[] = [];
  write(value: string): boolean { this.writes.push(value); return true; }
  end(): void {
    if (this.destroyed) return;
    this.emit("close");
    this.destroyed = true;
  }
}

function open(room = new Room("mine", 250, "http://localhost:3000/mine", "alice"), username = "alice") {
  const stream = new FakeStream();
  const session = new TuiSession(stream as unknown as ServerChannel, [room], username);
  return { room, stream, session, state: () => session as unknown as { input: string; cursorOffset: number } };
}

test("composer editing preserves key order and supports shell shortcuts", () => {
  const tui = open();
  tui.stream.emit("data", Buffer.from("ac\x1b[Db"));
  expect(tui.state().input).toBe("abc");
  expect(tui.state().cursorOffset).toBe(2);

  tui.stream.emit("data", Buffer.from("\x01>\x05<"));
  expect(tui.state().input).toBe(">abc<");
  expect(tui.state().cursorOffset).toBe(5);

  tui.stream.emit("data", Buffer.from("\x02\x7f"));
  expect(tui.state().input).toBe(">ab<");
  expect(tui.state().cursorOffset).toBe(3);
  tui.stream.end();
});

test("authenticated chat spam backs off across TUI reconnects without losing the draft", () => {
  const room = new Room("mine");
  const limiter = new AdaptiveRateLimiter(() => 1_000);
  const first = new FakeStream();
  new TuiSession(first as unknown as ServerChannel, [room], "alice", undefined, undefined, undefined, undefined, undefined, undefined, undefined, limiter);
  for (let index = 0; index < 9; index += 1) first.emit("data", Buffer.from(`message ${index}\r`));
  expect(room.messages).toHaveLength(8);
  expect(first.writes.at(-1)).toContain("slow down · retry in 3s");

  const second = new FakeStream();
  const session = new TuiSession(second as unknown as ServerChannel, [room], "alice", undefined, undefined, undefined, undefined, undefined, undefined, undefined, limiter);
  second.emit("data", Buffer.from("reconnected spam\r"));
  expect(room.messages).toHaveLength(8);
  expect((session as unknown as { input: string }).input).toBe("reconnected spam");
  expect(second.writes.at(-1)).toContain("slow down · retry in 3s");
  first.end();
  second.end();
});

test("composer layout word-wraps and tracks the editing cursor", () => {
  const layout = layoutComposer("one two three", 13, 7);
  expect(layout.rows.map((row) => row.text)).toEqual(["  one ", "two ", "three"]);
  expect(layout.cursorRow).toBe(2);
  expect(layout.cursorColumn).toBe(5);
});

test("empty composer shows a Zenburn command hint beside its arrow", () => {
  const tui = open();
  const frame = tui.stream.writes.at(-1)!;
  expect(frame).toContain("›");
  expect(frame).toContain("type / to see commands");
  expect(frame).toContain("\x1b[38;5;102mtype / to see commands");
  tui.stream.end();
});

test("telemetry and composer have dark breathing room without growing the frame", () => {
  const tui = open();
  tui.session.resize(80, 15);
  const lines = tui.stream.writes.at(-1)!.split("\r\n");
  const visible = (line: string) => line
    .replace(/\x1b\][^\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

  expect(lines).toHaveLength(15);
  expect(visible(lines[5]!).slice(3).trim()).toBe("");
  expect(lines[5]).toContain("\x1b[48;5;235m");
  expect(visible(lines[12]!).slice(3).trim()).toBe("");
  expect(lines[12]).toContain("\x1b[48;5;239m");
  expect(lines[13]).toContain("type / to see commands");
  expect(visible(lines[14]!).slice(3).trim()).toBe("");
  expect(lines[14]).toContain("\x1b[48;5;239m");
  tui.stream.end();
});

test("main chat stays darkest while the version HUD matches the status background", () => {
  const room = new Room("mine");
  room.chat("alice", "dark canvas");
  const tui = open(room);
  tui.session.resize(120, 24);
  const frame = tui.stream.writes.at(-1)!;
  expect(frame).toContain("\x1b[48;5;237m\x1b[38;5;102m  VERSION CONTROL");
  expect(frame).toContain("# mine  public");
  expect(frame).toContain("\x1b]8;;http://localhost:3000/mine\x1b\\localhost:3000/mine\x1b]8;;\x1b\\");
  expect(frame).not.toContain("SITE");
  expect(frame).not.toContain("CLANKER");
  expect(frame).toContain("DB ");
  expect(frame).toContain("CONN ");
  expect(frame).toContain("FILES ");
  expect(frame).toContain("BYTES/H ");
  expect(frame).toContain("TOKENS/H ");
  expect(frame).toContain("\x1b[48;5;237m\x1b[38;5;188m");
  expect(frame).toContain("\x1b[48;5;235m\x1b[38;5;188m");
  expect(frame).toContain("dark canvas");
  const strip = (line: string) => line.replace(/\x1b\][^\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const mainWidth = 120 - 3 - Math.min(50, Math.max(36, Math.floor(120 * 0.32)));
  for (const line of frame.split("\r\n").slice(0, 2)) {
    const main = strip(line).slice(3, 3 + mainWidth);
    const left = main.length - main.trimStart().length;
    const right = main.length - main.trimEnd().length;
    expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
  }
  tui.stream.end();
});

test("mouse wheel scrolls through chat history and restores the live edge", () => {
  const room = new Room("mine");
  for (let index = 0; index < 20; index += 1) room.chat("alice", `message ${index}`);
  const tui = open(room);
  tui.session.resize(80, 12);
  expect(tui.stream.writes.at(-1)).toContain("message 19");

  tui.stream.emit("data", Buffer.from("\x1b[<64;20;8M"));
  expect(tui.stream.writes.at(-1)).toContain("↑3");
  expect(tui.stream.writes.at(-1)).not.toContain("message 19");

  tui.stream.emit("data", Buffer.from("\x1b[<65;20;8M"));
  expect(tui.stream.writes.at(-1)).not.toContain("↑3");
  expect(tui.stream.writes.at(-1)).toContain("message 19");
  tui.stream.end();
  expect(tui.stream.writes.at(-1)).toContain("\x1b[?1006l\x1b[?1000l");
});

test("browser sessions can leave terminal mouse tracking disabled for native selection", () => {
  const room = new Room("mine");
  const stream = new FakeStream();
  new TuiSession(stream as unknown as ServerChannel, [room], "alice", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, false);
  expect(stream.writes[0]).toContain("\x1b[?1049h");
  expect(stream.writes[0]).not.toContain("\x1b[?1000h");
  expect(stream.writes[0]).not.toContain("\x1b[?1006h");
  stream.end();
});

test("empty-composer arrows select messages for replies and confirmed admin deletion", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-tui-message-actions-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const owner = accounts.ensureLocalOwner("alice");
  accounts.ensureRoom("mine", owner, { visibility: "public", contributions: "members", clankerMode: "passive" });
  const directory = new RoomDirectory(accounts, data, "https://serverside.chat");
  const room = directory.room("mine")!;
  room.chat(owner, "message to reply to");
  const targetId = room.messages.at(-1)!.id;
  const stream = new FakeStream();
  const session = new TuiSession(stream as unknown as ServerChannel, directory.rooms, owner, accounts, "mine", undefined, undefined, undefined, directory);

  stream.emit("data", Buffer.from("\x1b[A"));
  expect((session as unknown as { selectedMessageId?: number }).selectedMessageId).toBe(targetId);
  expect(stream.writes.at(-1)).toContain("selected @alice · ENTER reply · P pin · DELETE remove");
  stream.emit("data", Buffer.from("p"));
  expect(room.messages.at(-1)!.pinnedAt).toBeInstanceOf(Date);
  expect(stream.writes.at(-1)).toContain("◆");
  stream.emit("data", Buffer.from("p"));
  expect(room.messages.at(-1)!.pinnedAt).toBeUndefined();
  expect(stream.writes.at(-1)).toContain("\x1b[48;5;59m");
  stream.emit("data", Buffer.from("\r"));
  expect(stream.writes.at(-1)).toContain("replying to @alice  message to reply to");
  stream.emit("data", Buffer.from("reply body\r"));
  expect(room.messages.at(-1)).toMatchObject({ text: "reply body", replyTo: { id: targetId, author: "alice", excerpt: "message to reply to" } });

  const replyId = room.messages.at(-1)!.id;
  stream.emit("data", Buffer.from("\x1b[A\x7f"));
  expect((session as unknown as { deleteConfirmationId?: number }).deleteConfirmationId).toBe(replyId);
  expect(stream.writes.at(-1)).toContain("Y confirm · N cancel");
  stream.emit("data", Buffer.from("y"));
  expect(room.messages.some((message) => message.id === replyId)).toBe(false);
  expect(stream.writes.at(-1)).toContain("message deleted");

  stream.end();
  accounts.close();
});

test("Ctrl-N opens the permission-checked new-room form", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-tui-ctrl-new-room-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const owner = accounts.ensureLocalOwner("alice");
  accounts.ensureSystemRoom("lobby", owner, { visibility: "public", contributions: "members", clankerMode: "passive" });
  const directory = new RoomDirectory(accounts, data, "https://example.test");
  directory.prepareAccount(owner);
  const stream = new FakeStream();
  const session = new TuiSession(stream as unknown as ServerChannel, directory.rooms, owner, accounts, "lobby", undefined, undefined, undefined, directory);

  stream.emit("data", Buffer.from("draft\x0e"));
  expect((session as unknown as { creatingRoom: boolean; input: string }).creatingRoom).toBe(false);
  expect((session as unknown as { input: string }).input).toBe("draft");
  expect(stream.writes.at(-1)).toContain("send or clear the current draft");
  stream.emit("data", Buffer.from("\x15\x0e"));
  expect((session as unknown as { creatingRoom: boolean }).creatingRoom).toBe(true);
  expect(stream.writes.at(-1)).toContain("Configure the room before entering it");
  expect(stream.writes.at(-1)).toContain("Visibility");

  stream.end();
  accounts.close();
});

test("Escape returns message navigation to the composer, then opens and closes the room drawer", () => {
  const room = new Room("mine");
  room.chat("alice", "message to navigate");
  const tui = open(room);
  const state = tui.session as unknown as { selectedMessageId?: number; sidebarFocused: boolean };

  tui.stream.emit("data", Buffer.from("\x1b[A"));
  expect(state.selectedMessageId).toBe(room.messages.at(-1)!.id);
  tui.stream.emit("data", Buffer.from("\x1b"));
  expect(state.selectedMessageId).toBeUndefined();
  expect(state.sidebarFocused).toBe(false);
  expect(tui.stream.writes.at(-1)).toContain("\x1b[?25h");

  tui.stream.emit("data", Buffer.from("\x1b"));
  expect(state.sidebarFocused).toBe(true);
  tui.stream.emit("data", Buffer.from("\x1b"));
  expect(state.sidebarFocused).toBe(false);
  tui.stream.end();
});

test("owner and clanker names use distinct Zenburn blue and purple accents", () => {
  const room = new Room("mine", 250, "https://example.test/mine", "alice");
  room.messages.push(
    { id: 1, kind: "chat", author: "alice", text: "owner note", at: new Date(), clankerVisible: true },
    { id: 2, kind: "clanker", author: "clanker", text: "clanker note", at: new Date(), clankerVisible: true },
  );
  const tui = open(room);
  const frame = tui.stream.writes.at(-1)!;
  expect(frame).toContain("\x1b[38;5;110malice");
  expect(frame).toContain("\x1b[38;5;176mclanker");
  tui.stream.end();
});

test("consecutive messages share an author header and align under a fixed time gutter", () => {
  const room = new Room("mine", 250, "https://example.test/mine", "alice");
  const firstAt = new Date(2026, 0, 2, 9, 5);
  const secondAt = new Date(2026, 0, 2, 9, 6);
  const thirdAt = new Date(2026, 0, 2, 9, 7);
  room.messages.push(
    { id: 1, kind: "chat", author: "alice", text: "first message wraps across this narrow chat width with aligned continuation text", at: firstAt, clankerVisible: true },
    { id: 2, kind: "chat", author: "alice", text: "second message", at: secondAt, clankerVisible: true },
    { id: 3, kind: "chat", author: "bob", text: "third message", at: thirdAt, clankerVisible: true },
  );
  const tui = open(room);
  tui.session.resize(40, 30);
  const frame = tui.stream.writes.at(-1)!;
  const lines = frame.split("\r\n").map((line) => line
    .replace(/\x1b\][^\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .slice(3));
  const time = (at: Date) => at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const aliceHeaders = lines.filter((line) => line.trim() === "alice");
  const aliceHeader = lines.findIndex((line) => line.trim() === "alice");
  const firstMessage = lines.findIndex((line) => line.startsWith(`  ${time(firstAt)}  first message`));
  const secondMessage = lines.findIndex((line) => line.startsWith(`  ${time(secondAt)}  second message`));
  const bobHeader = lines.findIndex((line) => line.trim() === "bob");
  const thirdMessage = lines.findIndex((line) => line.startsWith(`  ${time(thirdAt)}  third message`));

  expect(aliceHeaders).toHaveLength(1);
  expect(firstMessage).toBe(aliceHeader + 1);
  expect(lines.slice(firstMessage + 1, secondMessage).every((line) => line.startsWith(" ".repeat(9)))).toBe(true);
  expect(secondMessage).toBeGreaterThan(firstMessage);
  expect(lines[secondMessage + 1]!.trim()).toBe("");
  expect(bobHeader).toBe(secondMessage + 2);
  expect(thirdMessage).toBe(bobHeader + 1);
  for (const line of frame.split("\r\n").filter((row) => /first message|second message|third message/.test(row))) {
    expect(line).not.toContain("\x1b[48;5;237m");
  }
  tui.stream.end();
});

test("trunk updates render as quiet status rows without an author heading", () => {
  const room = new Room("mine", 250, "https://example.test/mine", "alice");
  room.messages.push(
    { id: 1, kind: "chat", author: "alice", text: "ship it", at: new Date(2026, 0, 2, 9, 5), clankerVisible: true },
    { id: 2, kind: "system", author: "trunk", text: "updated to abc1234 by @alice", at: new Date(2026, 0, 2, 9, 6), clankerVisible: true },
    { id: 3, kind: "chat", author: "bob", text: "looks good", at: new Date(2026, 0, 2, 9, 7), clankerVisible: true },
  );
  const tui = open(room);
  tui.session.resize(60, 20);
  const frame = tui.stream.writes.at(-1)!;
  const lines = frame.split("\r\n").map((line) => line
    .replace(/\x1b\][^\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .slice(3));
  const updateRow = lines.findIndex((line) => line.includes("updated to abc1234"));
  const bobHeader = lines.findIndex((line) => line.trim() === "bob");
  expect(frame).not.toContain("trunk");
  expect(frame).toContain("updated to abc1234 by @alice");
  expect(frame).toContain("\x1b[3m\x1b[38;5;102mupdated to abc1234 by @alice\x1b[23m");
  expect(lines[updateRow - 1]!.trim()).toBe("");
  expect(lines[bobHeader - 1]!.trim()).toBe("");
  tui.stream.end();
});

test("slash commands prefix-match and render above the composer", () => {
  expect(slashCommandMatches("/in").map((command) => command.name)).toEqual(["/invite"]);
  expect(slashCommandMatches("/sh").map((command) => command.name)).toEqual(["/shell"]);
  expect(slashCommandMatches("/mount revoke")).toEqual([]);
  const tui = open();
  tui.stream.emit("data", Buffer.from("/"));
  expect(tui.stream.writes.at(-1)).toContain("/invite [role]");
  expect(tui.stream.writes.at(-1)).toContain("/mount [revoke]");
  tui.stream.emit("data", Buffer.from("mo"));
  expect(tui.stream.writes.at(-1)).toContain("/mount [revoke]");
  expect(tui.stream.writes.at(-1)).not.toContain("/invite [role]");
  tui.stream.end();
});

test("command palette arrows cycle and Enter expands commands with arguments", () => {
  const tui = open();
  tui.stream.emit("data", Buffer.from("/\r"));
  expect(tui.state().input).toBe("/clanker ");
  expect(tui.state().cursorOffset).toBe(9);
  tui.stream.end();
});

test("clanker command forwards its complete prompt", () => {
  const tui = open();
  tui.stream.emit("data", Buffer.from("/clanker build it\r"));
  expect(tui.room.messages.find((message) => message.kind === "chat")?.text).toBe("@clanker build it");
  tui.stream.end();
});

test("invite defaults to a complete contributor share URL", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-tui-invite-url-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const owner = accounts.ensureLocalOwner("alice");
  accounts.ensureRoom("mine", owner, { visibility: "private", contributions: "members", clankerMode: "passive" });
  const directory = new RoomDirectory(accounts, data, "https://serverside.chat");
  const stream = new FakeStream();
  new TuiSession(stream as unknown as ServerChannel, directory.rooms, owner, accounts, "mine", undefined, undefined, undefined, directory);

  stream.emit("data", Buffer.from("/invite\r"));
  const frame = stream.writes.at(-1)!;
  const match = frame.match(/https:\/\/serverside\.chat\/invite\/([a-zA-Z0-9_-]{24})/);
  expect(match).toBeTruthy();
  expect(frame).toContain(`\x1b]8;;${match![0]}\x1b\\${match![0]}\x1b]8;;\x1b\\`);
  const guest = accounts.createDevelopmentAccount("bob").principal;
  expect(accounts.redeemInvite(guest, match![1]!)).toMatchObject({ roomName: "mine", role: "contributor" });
  stream.end();
  accounts.close();
});

test("typing presence renders for other room members", () => {
  const room = new Room("mine", 250, "http://localhost:3000/mine", "alice");
  const alice = open(room, "alice");
  const bob = open(room, "bob");
  alice.stream.emit("data", Buffer.from("draft"));
  bob.session.resize(80, 24);

  expect(room.typingMembers).toEqual(["alice"]);
  expect(bob.stream.writes.at(-1)).toContain("alice is typing…");
  expect(bob.stream.writes.at(-1)).toContain("\x1b[3m");
  alice.stream.end();
  bob.stream.end();
});

test("chat reserves a distinct status row for concise passive and active clanker state", () => {
  const room = new Room("mine");
  room.chat("alice", "latest message");
  room.setClankerResponder(async () => "[silent]");
  const tui = open(room);
  tui.session.resize(80, 12);
  let frame = tui.stream.writes.at(-1)!;
  let lines = frame.split("\r\n");
  const visible = (line: string) => line.replace(/\x1b\][^\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const messageRow = lines.findIndex((line) => visible(line).includes("latest message"));
  const readyRow = messageRow + 1;
  const composerRow = lines.findIndex((line) => visible(line).includes("type / to see commands"));
  expect(messageRow).toBeGreaterThan(-1);
  expect(frame).not.toContain("clanker listening passively");
  expect(visible(lines[readyRow]!)).not.toContain("clanker");
  expect(composerRow).toBeGreaterThan(readyRow);
  expect(lines[readyRow]).toContain("\x1b[48;5;236m");

  room.clankerState.status = "thinking";
  room.clankerState.detail = "reading the room";
  tui.session.resize(80, 12);
  frame = tui.stream.writes.at(-1)!;
  expect(frame).toContain("clanker thinking");
  expect(frame).not.toContain("reading the room");
  expect(frame).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] clanker thinking/);
  tui.stream.end();
});

test("room focus dims chat text after bold author names", () => {
  const room = new Room("mine", 250, "http://localhost:3000/mine", "alice");
  room.chat("alice", "focus me");
  const tui = open(room, "alice");
  tui.stream.emit("data", Buffer.from("\t"));

  expect(tui.stream.writes.at(-1)).toContain("\x1b[22m\x1b[2m");
  tui.stream.end();
});

test("room focus dims the version control and live-log HUD", () => {
  const room = new Room("mine");
  room.versionGraph.push({ text: "* abcdef0  head", url: "https://example.test/mine?__ref=abcdef0" });
  const tui = open(room);
  tui.session.resize(120, 24);
  tui.stream.emit("data", Buffer.from("\t"));

  const frame = tui.stream.writes.at(-1)!;
  expect(frame).toContain("\x1b[2m\x1b[48;5;237m\x1b[38;5;102m  VERSION CONTROL");
  expect(frame).toContain("\x1b[2m\x1b[48;5;237m\x1b[38;5;188m");
  tui.stream.end();
});

test("TUI can open directly into a selected visible room", () => {
  const mine = new Room("mine");
  const general = new Room("general");
  const stream = new FakeStream();
  const session = new TuiSession(stream as unknown as ServerChannel, [mine, general], "alice", undefined, "general");
  expect((session as unknown as { room: Room }).room.name).toBe("general");
  expect(stream.writes.at(-1)).toContain("# general");
  stream.end();
});

test("Enter selects the highlighted room and returns focus to chat", () => {
  const mine = new Room("mine");
  const general = new Room("general");
  const stream = new FakeStream();
  const session = new TuiSession(stream as unknown as ServerChannel, [mine, general], "alice");

  stream.emit("data", Buffer.from("\t\x1b[B\r"));
  const state = session as unknown as { room: Room; sidebarFocused: boolean };
  expect(state.room.name).toBe("general");
  expect(state.sidebarFocused).toBe(false);

  stream.emit("data", Buffer.from("selected\r"));
  expect(general.messages.at(-1)).toMatchObject({ author: "alice", text: "selected" });
  stream.end();
});

test("expanded room drawer overlays a stable chat width and shows room occupancy", () => {
  const mine = new Room("mine");
  const general = new Room("general");
  general.join("bob");
  const stream = new FakeStream();
  const session = new TuiSession(stream as unknown as ServerChannel, [mine, general], "alice");
  session.resize(100, 20);
  const state = session as unknown as { sidebarFocused: boolean; sidebarWidth: number; mainWidth(): number; render(): void };
  const closedWidth = state.mainWidth();

  state.sidebarFocused = true;
  state.sidebarWidth = 28;
  state.render();
  expect(state.mainWidth()).toBe(closedWidth);
  expect(stream.writes.at(-1)).toContain("1 · public");
  expect(stream.writes.at(-1)).toContain("\x1b[1;1H");
  expect(stream.writes.at(-1)!.split("\r\n")).toHaveLength(20);
  stream.end();
});

test("Shift-arrows persist a different room-bar order for each account", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-tui-room-order-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const alice = accounts.ensureLocalOwner("alice");
  const bob = accounts.createDevelopmentAccount("bob").principal;
  accounts.ensureSystemRoom("lobby", alice, { visibility: "public", contributions: "members", clankerMode: "passive" });
  accounts.ensureRoom("alpha", alice, { visibility: "public", contributions: "members", clankerMode: "passive" });
  accounts.ensureRoom("beta", alice, { visibility: "public", contributions: "members", clankerMode: "passive" });
  const directory = new RoomDirectory(accounts, data, "https://serverside.chat");
  const first = new FakeStream();
  new TuiSession(first as unknown as ServerChannel, directory.rooms, alice, accounts, "alpha", undefined, undefined, undefined, directory);

  first.emit("data", Buffer.from("\t\x1b[1;2B"));
  expect(accounts.roomOrder(alice)).toEqual(["lobby", "beta", "alpha"]);
  first.end();

  const aliceAgain = new TuiSession(new FakeStream() as unknown as ServerChannel, directory.rooms, alice, accounts, undefined, undefined, undefined, undefined, directory);
  const bobSession = new TuiSession(new FakeStream() as unknown as ServerChannel, directory.rooms, bob, accounts, undefined, undefined, undefined, undefined, directory);
  expect((aliceAgain as unknown as { rooms: Room[] }).rooms.map((room) => room.name)).toEqual(["lobby", "beta", "alpha"]);
  expect((bobSession as unknown as { rooms: Room[] }).rooms.map((room) => room.name)).toEqual(["lobby", "alpha", "beta"]);
  (aliceAgain as unknown as { stream: FakeStream }).stream.end();
  (bobSession as unknown as { stream: FakeStream }).stream.end();
  accounts.close();
});

test("Shift-Enter opens keyboard-only room permission settings for admins", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-tui-room-settings-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const owner = accounts.ensureLocalOwner("alice");
  accounts.ensureRoom("mine", owner, { visibility: "public", contributions: "members", clankerMode: "passive" });
  const directory = new RoomDirectory(accounts, data, "https://serverside.chat");
  const stream = new FakeStream();
  new TuiSession(stream as unknown as ServerChannel, directory.rooms, owner, accounts, "mine", undefined, undefined, undefined, directory);

  stream.emit("data", Buffer.from("\t\x1b[13;2u"));
  expect(stream.writes.at(-1)).toContain("ROOM SETTINGS  #mine");
  stream.emit("data", Buffer.from("\x1b[C\x1b[B\x1b[C\x1b[B\x1b[C\x1b[B\r"));
  expect(directory.room("mine")!.policy).toMatchObject({ visibility: "private", contributions: "admins", clankerMode: "explicit" });
  expect(stream.writes.at(-1)).toContain("room settings saved");
  stream.end();
  accounts.close();
});

test("wide version control HUD reserves its lower third for live service logs", () => {
  const room = new Room("mine");
  room.versionGraph.push({ text: "* abcdef0  head", url: "https://example.test/mine?__ref=abcdef0" });
  room.recordServiceLog("guest rendered 你好, 世界");
  const tui = open(room);
  tui.session.resize(120, 24);

  const frame = tui.stream.writes.at(-1)!;
  expect(frame).toContain("VERSION CONTROL");
  expect(frame).toContain("abcdef0");
  expect(frame).toContain("DB ");
  expect(frame).toContain("CONN ");
  expect(frame).toContain("FILES ");
  expect(frame).toContain("BYTES/H ");
  expect(frame).toContain("LIVE LOGS");
  expect(frame).toContain("guest rendered 你好, 世界");
  expect(frame.indexOf("LIVE LOGS")).toBeGreaterThan(frame.indexOf("abcdef0"));
  expect(frame.indexOf("DB ")).toBeGreaterThan(frame.indexOf("abcdef0"));
  expect(frame.indexOf("DB ")).toBeLessThan(frame.indexOf("LIVE LOGS"));
  const rows = frame.split("\r\n");
  const resourceRows = ["DB", "FILES", "CONN", "BYTES/H", "TOKENS/H"].map((label) => rows.findIndex((row) => row.includes(label)));
  expect(new Set(resourceRows).size).toBe(5);
  for (const index of resourceRows) {
    expect(index).toBeGreaterThan(-1);
    expect(rows[index]).toContain("\x1b[48;5;237m");
    expect(rows[index]!.match(/░/g)?.length).toBeGreaterThan(10);
  }
  tui.stream.end();
});

test("clanker failures render as distinct live-log entries", () => {
  const rendered = renderServiceLog("12:34:56 CLANKER error provider returned no usable completion");
  expect(rendered).toContain("12:34:56");
  expect(rendered).toContain("CLANKER");
  expect(rendered).toContain("error");
  expect(rendered).toContain("provider returned no usable completion");
});

test("lobby has a centered padded banner and leaves detailed guidance to pins", () => {
  const lobby = new Room("lobby");
  const tui = open(lobby);
  tui.session.resize(120, 24);

  const frame = tui.stream.writes.at(-1)!;
  const lines = frame.split("\r\n");
  const visibleMain = (line: string) => line
    .replace(/\x1b\][^\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .slice(3)
    .trim();
  expect(frame).toContain("\x1b]8;;http://localhost:3000\x1b\\localhost:3000\x1b]8;;\x1b\\");
  expect(visibleMain(lines[1]!)).toBe("");
  expect(frame).toContain("Every room gets a server and a clanker. Have fun!");
  const bannerLine = lines.find((line) => line.includes("Every room gets a server"))!;
  const plainBanner = bannerLine.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").slice(3);
  expect(plainBanner.indexOf("Every room")).toBeGreaterThan(20);
  expect(frame).not.toContain("ssh -p 2222 serverside.chat");
  expect(frame).not.toContain("Each chat room comes paired");
  expect(frame).not.toContain("live preview");
  expect(frame).not.toContain("VERSION CONTROL");
  expect(frame).not.toContain("LIVE LOGS");
  expect(frame).not.toContain("SITE   ");
  tui.stream.end();
});

test("CJK text uses terminal cell width for wrapping and cursor placement", () => {
  const layout = layoutComposer("你好, 世界", 6, 9);
  expect(layout.rows.map((row) => row.text)).toEqual(["  你好, ", "世界"]);
  expect(layout.cursorRow).toBe(1);
  expect(layout.cursorColumn).toBe(4);

  const room = new Room("mine");
  const tui = open(room);
  tui.session.resize(40, 12);
  room.chat("alice", "A compact Chinese greeting: 你好, 世界");
  tui.session.resize(40, 12);
  expect(tui.stream.writes.at(-1)).toContain("你好, 世界");
  tui.stream.end();
});

test("an SSH viewer becomes its canonical account after browser key linking", async () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-tui-auth-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const owner = accounts.ensureLocalOwner("alice");
  accounts.ensureRoom("lobby", owner, { visibility: "public", contributions: "members", clankerMode: "explicit" });
  accounts.ensureRoom("secret", owner, { visibility: "private", contributions: "members", clankerMode: "passive" });
  const lobby = new Room("lobby", 250, "http://example.test/lobby", owner.handle, undefined, accounts);
  const secret = new Room("secret", 250, "http://example.test/secret", owner.handle, undefined, accounts);
  const guest = accounts.principalForKey("ssh-ed25519", Buffer.from("guest-key"), "charlie");
  const invite = accounts.createInvite(owner, "secret", "contributor");
  const pairing = accounts.createSshPairing(guest, "test", 60_000, invite);
  const account = accounts.createDevelopmentAccount("charlie");
  const stream = new FakeStream();
  const session = new TuiSession(
    stream as unknown as ServerChannel,
    [lobby, secret],
    guest,
    accounts,
    undefined,
    `https://example.test/?ssh=${pairing.code}`,
    () => accounts.principalForKey("ssh-ed25519", Buffer.from("guest-key"), "charlie"),
    pairing.roomName,
  );

  stream.emit("data", Buffer.from("hello\r"));
  expect(lobby.messages).toEqual([]);
  expect(stream.writes.at(-1)).toContain("\x1b]8;;https://example.test/?ssh=");
  accounts.linkSshPairing(account.principal, pairing.code);
  await Bun.sleep(1_050);
  const state = session as unknown as { room: Room; principal: { handle: string; authenticated: boolean } };
  expect(state.room.name).toBe("secret");
  expect(state.principal).toMatchObject({ handle: "charlie", authenticated: true });
  stream.emit("data", Buffer.from("now I can contribute\r"));
  expect(secret.messages.at(-1)).toMatchObject({ author: "charlie", text: "now I can contribute", authorRole: "contributor", clankerVisible: true });

  stream.end();
  accounts.close();
});

test("an authenticated non-member sees an invitation prompt instead of sign-in", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-tui-member-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const owner = accounts.ensureLocalOwner("alice");
  const viewer = accounts.createDevelopmentAccount("bob").principal;
  accounts.ensureRoom("mine", owner, { visibility: "public", contributions: "members", clankerMode: "passive" });
  const room = new Room("mine", 250, "https://example.test/mine", owner.handle, undefined, accounts);
  const stream = new FakeStream();
  new TuiSession(stream as unknown as ServerChannel, [room], viewer, accounts, undefined, "https://example.test/?signin=1");

  expect(stream.writes.at(-1)).toContain("read only · ask @alice for an invite");
  expect(stream.writes.at(-1)).not.toContain("\x1b]8;;https://example.test/?signin=1");
  stream.end();
  accounts.close();
});

test("room owners manage their rooms from the TUI", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-tui-rooms-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const owner = accounts.ensureLocalOwner("alice");
  accounts.ensureRoom("mine", owner, { visibility: "public", contributions: "members", clankerMode: "passive" });
  const directory = new RoomDirectory(accounts, data, "https://example.test");
  const stream = new FakeStream();
  const session = new TuiSession(stream as unknown as ServerChannel, directory.rooms, owner, accounts, "mine", undefined, undefined, undefined, directory);

  stream.emit("data", Buffer.from("/room create project\r"));
  expect((session as unknown as { room: Room }).room.name).toBe("project");
  stream.emit("data", Buffer.from("/room rename launch\r"));
  expect((session as unknown as { room: Room }).room.name).toBe("launch");
  stream.emit("data", Buffer.from("/room delete launch\r"));
  expect((session as unknown as { room: Room }).room.name).toBe("mine");
  stream.emit("data", Buffer.from("/room restore launch\r"));
  expect((session as unknown as { room: Room }).room.name).toBe("launch");
  expect(stream.writes.at(-1)).toContain("restored #launch");
  stream.emit("data", Buffer.from("/account\r"));
  expect(stream.writes.at(-1)).toContain("site member · free · rooms 2/5");

  stream.end();
  accounts.close();
});

test("Delete on a sidebar room requires its full name and preserves a restorable archive", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-tui-room-archive-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const owner = accounts.ensureLocalOwner("alice");
  accounts.ensureSystemRoom("lobby", owner, { visibility: "public", contributions: "members", clankerMode: "passive" });
  accounts.ensureRoom("project", owner, { visibility: "private", contributions: "members", clankerMode: "explicit" });
  const directory = new RoomDirectory(accounts, data, "https://serverside.chat");
  directory.room("project")!.chat(owner, "keep this transcript");
  const stream = new FakeStream();
  const session = new TuiSession(stream as unknown as ServerChannel, directory.rooms, owner, accounts, "project", undefined, undefined, undefined, directory);

  stream.emit("data", Buffer.from("\t\x7f"));
  expect(stream.writes.at(-1)).toContain("Archive #project?");
  expect(stream.writes.at(-1)).toContain("type project to confirm");
  stream.emit("data", Buffer.from("wrong\r"));
  expect(directory.room("project")).toBeDefined();
  expect(stream.writes.at(-1)).toContain("type project exactly");
  stream.emit("data", Buffer.from("\x15project\r"));
  expect(directory.room("project")).toBeUndefined();
  expect((session as unknown as { room: Room }).room.name).toBe("lobby");
  expect(accounts.archivedRooms(owner)[0]).toMatchObject({ name: "project", visibility: "private", clankerMode: "explicit" });

  stream.emit("data", Buffer.from("/room archives\r"));
  expect(stream.writes.at(-1)).toContain("archived: #project");
  stream.emit("data", Buffer.from("/room restore project\r"));
  expect((session as unknown as { room: Room }).room.name).toBe("project");
  expect(directory.room("project")!.messages.at(-1)?.text).toBe("keep this transcript");
  stream.end();
  accounts.close();
});

test("the sidebar identity opens keyboard-driven account settings", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-tui-account-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const owner = accounts.ensureLocalOwner("alice", "Alice");
  accounts.ensureSiteAdmin(owner);
  accounts.ensureRoom("mine", owner, { visibility: "public", contributions: "members", clankerMode: "passive" });
  const directory = new RoomDirectory(accounts, data, "https://example.test");
  const stream = new FakeStream();
  new TuiSession(stream as unknown as ServerChannel, directory.rooms, owner, accounts, "mine", "https://example.test/?signin=1", undefined, undefined, directory);

  stream.emit("data", Buffer.from("\t\x1b[B\x1b[B\r"));
  expect(stream.writes.at(-1)).toContain("ACCOUNT  @alice");
  expect(stream.writes.at(-1)).toContain("Change display name");
  expect(stream.writes.at(-1)).toContain("\x1b[38;5;110madmin");
  expect(stream.writes.at(-1)).toContain("\x1b[38;5;108mChange display name");
  stream.emit("data", Buffer.from("\r\x15Alice Example\r"));
  expect(accounts.accountSettings(owner).displayName).toBe("Alice Example");
  expect(stream.writes.at(-1)).toContain("display name updated");
  stream.emit("data", Buffer.from("\x1b[B\r"));
  expect(stream.writes.some((write) => write.includes("\x1b]777;open:"))).toBe(true);
  expect(stream.writes.at(-1)).toContain("secure link ready");

  stream.end();
  accounts.close();
});

test("an anonymous sidebar identity opens the canonical sign-in action", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-tui-account-anon-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const owner = accounts.ensureLocalOwner("alice");
  accounts.ensureSystemRoom("lobby", owner, { visibility: "public", contributions: "members", clankerMode: "passive" });
  const directory = new RoomDirectory(accounts, data, "https://example.test");
  const guest = anonymousPrincipal("SHA256:account-guest");
  const stream = new FakeStream();
  new TuiSession(stream as unknown as ServerChannel, directory.rooms, guest, accounts, "lobby", "https://example.test/?signin=1", undefined, undefined, directory, async () => ({ allowed: true }));

  stream.emit("data", Buffer.from("\t\x1b[B\r"));
  expect(stream.writes.at(-1)).toContain("ACCOUNT  @guest-");
  expect(stream.writes.at(-1)).toContain("\x1b]8;;https://example.test/?signin=1");
  stream.emit("data", Buffer.from("\r"));
  expect(stream.writes.some((write) => write.includes("\x1b]777;open:"))).toBe(true);

  stream.end();
  accounts.close();
});

test("room contributors open the same Wasm editor inside the chat TUI", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-tui-editor-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const owner = accounts.ensureLocalOwner("alice");
  accounts.ensureRoom("mine", owner, { visibility: "public", contributions: "members", clankerMode: "passive" });
  const directory = new RoomDirectory(accounts, data, "https://example.test");
  const stream = new FakeStream();
  const session = new TuiSession(stream as unknown as ServerChannel, directory.rooms, owner, accounts, "mine", undefined, undefined, undefined, directory);

  stream.emit("data", Buffer.from("/edit README.md\r"));
  expect(stream.writes.at(-1)).toContain("Wasm buffer");
  expect(stream.writes.at(-1)).toContain("README.md");
  stream.emit("data", Buffer.from("X\x13\x11"));
  expect(directory.workspaces.get("mine")!.readFile("README.md").startsWith("X")).toBe(true);
  expect((session as unknown as { editor?: unknown }).editor).toBeUndefined();

  stream.end();
  accounts.close();
});

test("mount command shows keyboard-first SFTP, SSHFS, and Finder WebDAV instructions", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-tui-mount-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const owner = accounts.ensureLocalOwner("alice");
  accounts.ensureRoom("mine", owner, { visibility: "public", contributions: "members", clankerMode: "passive" });
  const directory = new RoomDirectory(accounts, data, "https://serverside.chat");
  const stream = new FakeStream();
  const session = new TuiSession(stream as unknown as ServerChannel, directory.rooms, owner, accounts, "mine", undefined, undefined, undefined, directory);

  stream.emit("data", Buffer.from("/mount\r"));
  const frame = stream.writes.at(-1)!;
  expect(frame).toContain("SFTP");
  expect(frame).toContain("sftp -P 2222 serverside.chat:mine");
  expect(frame).toContain("sshfs -p 2222 serverside.chat:/mine ./mine");
  expect(frame).toContain("Press ⌘K in Finder");
  expect(frame).toContain("https://serverside.chat/_dav/mine/");
  expect(frame).toMatch(/username: mount-[a-zA-Z0-9_-]{16}/);
  expect(frame).toMatch(/password: ssc_[a-zA-Z0-9_-]{43}/);

  stream.emit("data", Buffer.from("\r"));
  expect((session as unknown as { mountPanel?: unknown }).mountPanel).toBeUndefined();
  stream.emit("data", Buffer.from("/mount revoke\r"));
  expect(stream.writes.at(-1)).toContain("Finder mount credential revoked");
  stream.end();
  accounts.close();
});

test("shell command shows exact SSH access instructions for the current room", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-tui-shell-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const owner = accounts.ensureLocalOwner("alice");
  accounts.ensureRoom("mine", owner, { visibility: "public", contributions: "members", clankerMode: "passive" });
  const directory = new RoomDirectory(accounts, data, "https://serverside.chat");
  const stream = new FakeStream();
  const session = new TuiSession(stream as unknown as ServerChannel, directory.rooms, owner, accounts, "mine", undefined, undefined, undefined, directory);

  stream.emit("data", Buffer.from("/shell\r"));
  expect(stream.writes.at(-1)).toContain("SHELL  #mine");
  expect(stream.writes.at(-1)).toContain("ssh -t -p 2222 serverside.chat shell mine");
  expect(stream.writes.at(-1)).toContain("SSH key linked to your account");
  expect((session as unknown as { shellPanel: boolean }).shellPanel).toBe(true);
  stream.emit("data", Buffer.from("\r"));
  expect((session as unknown as { shellPanel: boolean }).shellPanel).toBe(false);

  stream.end();
  accounts.close();
});

test("room creation is a keyboard-only policy form", async () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-tui-new-room-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const owner = accounts.ensureLocalOwner("alice");
  accounts.ensureSystemRoom("lobby", owner, { visibility: "public", contributions: "members", clankerMode: "passive" });
  const directory = new RoomDirectory(accounts, data, "https://example.test");
  directory.prepareAccount(owner);
  const stream = new FakeStream();
  const session = new TuiSession(stream as unknown as ServerChannel, directory.rooms, owner, accounts, "lobby", undefined, undefined, undefined, directory);

  stream.emit("data", Buffer.from("\t"));
  await Bun.sleep(350);
  const drawerFrame = stream.writes.at(-1)!;
  expect(drawerFrame).toContain("+ new room");
  expect(drawerFrame.indexOf("# lobby")).toBeLessThan(drawerFrame.indexOf("+ new room"));
  stream.emit("data", Buffer.from("\x1b[B"));
  const selectedFrame = stream.writes.at(-1)!;
  const selected = session as unknown as { input: string; createRoomFocused: boolean; creatingRoom: boolean; createRoomField: number };
  expect(selected.createRoomFocused).toBe(true);
  expect(selectedFrame).toContain("Configure the room before entering it");
  expect(selectedFrame).toContain("\x1b[48;5;59m\x1b[38;5;188m  + new room");
  expect(selectedFrame).not.toContain("\x1b[48;5;59m\x1b[38;5;188m  # lobby");
  expect(selectedFrame).not.toContain("# lobby  public");
  stream.emit("data", Buffer.from("\r"));
  expect(selected.creatingRoom).toBe(true);
  expect(selected.input).toBe("");
  expect(stream.writes.at(-1)).toContain("Visibility");
  expect(stream.writes.at(-1)).toContain("public");
  expect(stream.writes.at(-1)).toContain("members");
  expect(stream.writes.at(-1)).toContain("passive");
  stream.emit("data", Buffer.from("proj\t"));
  await Bun.sleep(350);
  stream.emit("data", Buffer.from("\t"));
  expect(selected.input).toBe("proj");
  stream.emit("data", Buffer.from("ect\r"));
  expect(selected.createRoomField).toBe(1);
  stream.emit("data", Buffer.from("\x1b[C\r"));
  stream.emit("data", Buffer.from("\x1b[C\r"));
  stream.emit("data", Buffer.from("\x1b[C\r"));
  expect(selected.createRoomField).toBe(4);
  expect(stream.writes.at(-1)).toContain("[ Create room ]");
  stream.emit("data", Buffer.from("\r"));
  expect((session as unknown as { room: Room }).room.name).toBe("project");
  expect(accounts.roomPolicy("project")).toMatchObject({ visibility: "private", contributions: "admins", clankerMode: "explicit" });

  stream.end();
  accounts.close();
});

test("anonymous lobby input is persisted only after the review callback allows it", async () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-tui-anonymous-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const owner = accounts.ensureLocalOwner("alice");
  accounts.ensureSystemRoom("lobby", owner, { visibility: "public", contributions: "members", clankerMode: "passive" });
  const directory = new RoomDirectory(accounts, data, "https://example.test");
  const lobby = directory.room("lobby")!;
  const guest = anonymousPrincipal("SHA256:tui-guest");
  const stream = new FakeStream();
  const reviewed: string[] = [];
  new TuiSession(stream as unknown as ServerChannel, directory.rooms, guest, accounts, "lobby", "https://example.test/?signin=1", undefined, undefined, directory, async (_principal, text) => {
    reviewed.push(text);
    return text === "how do rooms work?" ? { allowed: true } : { allowed: false, reason: "message was not posted" };
  });

  expect(stream.writes.at(-1)).toContain("lobby messages are moderated");
  expect(stream.writes.at(-1)).toContain("\x1b]8;;https://example.test/?signin=1");
  stream.emit("data", Buffer.from("how"));
  expect(stream.writes.at(-1)).toContain("lobby messages are moderated");
  expect(stream.writes.at(-1)).toContain("\x1b]8;;https://example.test/?signin=1");
  stream.emit("data", Buffer.from(" do rooms work?\r"));
  await Bun.sleep(1);
  expect(reviewed).toEqual(["how do rooms work?"]);
  expect(lobby.messages.at(-1)).toMatchObject({ author: guest.handle, text: "how do rooms work?", clankerVisible: true });
  const count = lobby.messages.length;
  stream.emit("data", Buffer.from("unsafe\r"));
  await Bun.sleep(1);
  expect(lobby.messages).toHaveLength(count);
  expect(stream.writes.at(-1)).toContain("message was not posted");

  stream.end();
  accounts.close();
});
