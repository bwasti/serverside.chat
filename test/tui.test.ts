import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ServerChannel } from "ssh2";
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
