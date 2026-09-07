import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerChannel } from "ssh2";
import { AccountStore } from "../src/auth";
import { Room } from "../src/room";
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

test("anonymous SSH viewers can redeem an invite without reconnecting", () => {
  const data = mkdtempSync(join(tmpdir(), "wasm-chat-tui-auth-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const owner = accounts.ensureLocalOwner("alice");
  accounts.ensureRoom("lobby", owner, { visibility: "public", contributions: "members", agentMode: "explicit" });
  accounts.ensureRoom("secret", owner, { visibility: "private", contributions: "members", agentMode: "passive" });
  const lobby = new Room("lobby", 250, "http://example.test/lobby", owner.handle, undefined, accounts);
  const secret = new Room("secret", 250, "http://example.test/secret", owner.handle, undefined, accounts);
  const guest = accounts.principalForKey("ssh-ed25519", Buffer.from("guest-key"), "charlie");
  const invite = accounts.createInvite(owner, "secret", "contributor");
  const stream = new FakeStream();
  const session = new TuiSession(stream as unknown as ServerChannel, [lobby, secret], guest, accounts);

  stream.emit("data", Buffer.from("hello\r"));
  expect(lobby.messages).toEqual([]);
  stream.emit("data", Buffer.from(`/redeem ${invite}\r`));
  const state = session as unknown as { room: Room; principal: { handle: string; authenticated: boolean } };
  expect(state.room.name).toBe("secret");
  expect(state.principal).toMatchObject({ handle: "charlie", authenticated: true });
  stream.emit("data", Buffer.from("now I can contribute\r"));
  expect(secret.messages.at(-1)).toMatchObject({ author: "charlie", text: "now I can contribute", authorRole: "contributor", agentVisible: true });

  stream.end();
  accounts.close();
});
