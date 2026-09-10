import { expect, test } from "bun:test";
import { RoomEditor, WasmTextBuffer } from "../src/editor";

test("Wasm editor core mutates UTF-8 text without splitting code points", () => {
  const buffer = new WasmTextBuffer(Buffer.from("a你b"));
  buffer.right();
  buffer.right();
  expect(buffer.cursor).toBe(Buffer.byteLength("a你"));
  expect(buffer.backspace()).toBe(true);
  expect(buffer.text).toBe("ab");
  expect(buffer.insert("好")).toBe(true);
  expect(buffer.text).toBe("a好b");
  buffer.lineEnd();
  expect(buffer.cursor).toBe(Buffer.byteLength("a好b"));
});

test("reusable editor renders syntax and saves through its host capability", () => {
  let saved = Buffer.alloc(0);
  const editor = new RoomEditor("worker.js", Buffer.from("const answer = 42;\n"), "old", {
    readOnly: false,
    save(content) { saved = content; return { revision: "new", message: "saved" }; },
    preview() { throw new Error("not used"); },
  });
  editor.handleData(Buffer.from("// "));
  editor.handleData(Buffer.from("\x13"));
  expect(saved.toString()).toBe("// const answer = 42;\n");
  const frame = editor.render(80, 15);
  expect(frame).toContain("worker.js");
  expect(frame).toContain("saved");
  expect(frame).toContain("^P commit + preview");
});

test("editor sanitizes host text before rendering it in a terminal", () => {
  const editor = new RoomEditor("bad\x1b[2J.js", Buffer.from("const ok = true;\n"), null, {
    readOnly: false,
    save() { return { revision: "next", message: "saved\x1b[2J" }; },
    preview() { throw new Error("not used"); },
  });
  editor.handleData(Buffer.from("\x13"));
  expect(editor.render(40, 10)).not.toContain("\x1b[2J");
});
