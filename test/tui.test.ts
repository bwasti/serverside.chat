import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerChannel } from "ssh2";
import { AccountStore, anonymousPrincipal } from "../src/auth";
import { Room } from "../src/room";
import { RoomDirectory } from "../src/room-directory";
import { layoutComposer, TuiSession } from "../src/tui";

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

test("composer layout word-wraps and tracks the editing cursor", () => {
  const layout = layoutComposer("one two three", 13, 7);
  expect(layout.rows.map((row) => row.text)).toEqual(["  one ", "two ", "three"]);
  expect(layout.cursorRow).toBe(2);
  expect(layout.cursorColumn).toBe(5);
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
  expect(frame).toContain("\x1b[2m\x1b[48;5;233m\x1b[38;5;244m  VERSION CONTROL");
  expect(frame).toContain("\x1b[2m\x1b[48;5;233m\x1b[38;5;250m");
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

test("wide version control HUD reserves its lower third for live service logs", () => {
  const room = new Room("mine");
  room.versionGraph.push({ text: "* abcdef0  head", url: "https://example.test/mine?__ref=abcdef0" });
  room.recordServiceLog("guest rendered 你好, 世界");
  const tui = open(room);
  tui.session.resize(120, 24);

  const frame = tui.stream.writes.at(-1)!;
  expect(frame).toContain("VERSION CONTROL");
  expect(frame).toContain("abcdef0");
  expect(frame).toContain("LIVE LOGS");
  expect(frame).toContain("guest rendered 你好, 世界");
  expect(frame.indexOf("LIVE LOGS")).toBeGreaterThan(frame.indexOf("abcdef0"));
  tui.stream.end();
});

test("lobby replaces the developer dashboard with a compact introduction", () => {
  const lobby = new Room("lobby");
  const tui = open(lobby);
  tui.session.resize(120, 24);

  const frame = tui.stream.writes.at(-1)!;
  expect(frame).toContain("shared rooms where people and AI build live websites");
  expect(frame).toContain("TAB other pages");
  expect(frame).toContain("Ask the guide");
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
  accounts.ensureRoom("lobby", owner, { visibility: "public", contributions: "members", agentMode: "explicit" });
  accounts.ensureRoom("secret", owner, { visibility: "private", contributions: "members", agentMode: "passive" });
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
  expect(secret.messages.at(-1)).toMatchObject({ author: "charlie", text: "now I can contribute", authorRole: "contributor", agentVisible: true });

  stream.end();
  accounts.close();
});

test("an authenticated non-member sees an invitation prompt instead of sign-in", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-tui-member-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const owner = accounts.ensureLocalOwner("alice");
  const viewer = accounts.createDevelopmentAccount("bob").principal;
  accounts.ensureRoom("mine", owner, { visibility: "public", contributions: "members", agentMode: "passive" });
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
  accounts.ensureRoom("mine", owner, { visibility: "public", contributions: "members", agentMode: "passive" });
  const directory = new RoomDirectory(accounts, data, "https://example.test");
  const stream = new FakeStream();
  const session = new TuiSession(stream as unknown as ServerChannel, directory.rooms, owner, accounts, "mine", undefined, undefined, undefined, directory);

  stream.emit("data", Buffer.from("/room create project\r"));
  expect((session as unknown as { room: Room }).room.name).toBe("project");
  stream.emit("data", Buffer.from("/room rename launch\r"));
  expect((session as unknown as { room: Room }).room.name).toBe("launch");
  stream.emit("data", Buffer.from("/room delete launch\r"));
  expect((session as unknown as { room: Room }).room.name).toBe("mine");
  stream.emit("data", Buffer.from("/account\r"));
  expect(stream.writes.at(-1)).toContain("site member · free · rooms 1/5");

  stream.end();
  accounts.close();
});

test("room contributors open the same Wasm editor inside the chat TUI", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-tui-editor-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const owner = accounts.ensureLocalOwner("alice");
  accounts.ensureRoom("mine", owner, { visibility: "public", contributions: "members", agentMode: "passive" });
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

test("room creation is a keyboard-only policy form", async () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-tui-new-room-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const owner = accounts.ensureLocalOwner("alice");
  accounts.ensureSystemRoom("lobby", owner, { visibility: "public", contributions: "members", agentMode: "passive" });
  const directory = new RoomDirectory(accounts, data, "https://example.test");
  directory.prepareAccount(owner);
  const stream = new FakeStream();
  const session = new TuiSession(stream as unknown as ServerChannel, directory.rooms, owner, accounts, "lobby", undefined, undefined, undefined, directory);

  stream.emit("data", Buffer.from("\t"));
  await Bun.sleep(350);
  expect(stream.writes.at(-1)).toContain("+ new room");
  stream.emit("data", Buffer.from("\x1b[A"));
  const selectedFrame = stream.writes.at(-1)!;
  const selected = session as unknown as { input: string; createRoomFocused: boolean; creatingRoom: boolean; createRoomField: number };
  expect(selected.createRoomFocused).toBe(true);
  expect(selectedFrame).toContain("Configure the room before entering it");
  expect(selectedFrame).toContain("\x1b[48;5;60m\x1b[38;5;255m  + new room");
  expect(selectedFrame).not.toContain("\x1b[48;5;60m\x1b[38;5;255m  # lobby");
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
  expect(accounts.roomPolicy("project")).toMatchObject({ visibility: "private", contributions: "admins", agentMode: "explicit" });

  stream.end();
  accounts.close();
});

test("anonymous lobby input is persisted only after the review callback allows it", async () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-tui-anonymous-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const owner = accounts.ensureLocalOwner("alice");
  accounts.ensureSystemRoom("lobby", owner, { visibility: "public", contributions: "members", agentMode: "passive" });
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
  stream.emit("data", Buffer.from("how do rooms work?\r"));
  await Bun.sleep(1);
  expect(reviewed).toEqual(["how do rooms work?"]);
  expect(lobby.messages.at(-1)).toMatchObject({ author: guest.handle, text: "how do rooms work?", agentVisible: true });
  const count = lobby.messages.length;
  stream.emit("data", Buffer.from("unsafe\r"));
  await Bun.sleep(1);
  expect(lobby.messages).toHaveLength(count);
  expect(stream.writes.at(-1)).toContain("message was not posted");

  stream.end();
  accounts.close();
});
