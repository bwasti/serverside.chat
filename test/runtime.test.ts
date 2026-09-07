import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Room } from "../src/room";
import { ServiceRuntime } from "../src/runtime";
import { RoomWorkspace } from "../src/workspace";

test("QuickJS service shares durable room-scoped SQLite across fresh requests", async () => {
  const data = mkdtempSync(join(tmpdir(), "wasm-chat-runtime-"));
  const workspace = new RoomWorkspace(data, "mine");
  workspace.writeFile("worker.js", `export default { async fetch(request, env) {
    env.db.exec("CREATE TABLE IF NOT EXISTS notes (text TEXT NOT NULL)");
    if (request.method === "POST") { const body = await request.json(); env.db.prepare("INSERT INTO notes(text) VALUES (?)").run(body.text); }
    return Response.json({ notes: env.db.prepare("SELECT text FROM notes ORDER BY rowid").all() });
  } };`);
  workspace.commit("test database worker");
  const runtime = new ServiceRuntime(workspace, new Room("mine"), data);

  const posted = await runtime.fetch(new Request("http://service/mine/api/notes", { method: "POST", body: JSON.stringify({ text: "shared" }) }), "head", "/api/notes");
  const fetched = await runtime.fetch(new Request("http://service/mine/api/notes"), "head", "/api/notes");
  expect(posted.status).toBe(200);
  expect(JSON.parse(fetched.body)).toEqual({ notes: [{ text: "shared" }] });
}, 20_000);

test("database capability rejects cross-tenant and administrative SQL", async () => {
  const data = mkdtempSync(join(tmpdir(), "wasm-chat-runtime-"));
  const workspace = new RoomWorkspace(data, "mine");
  workspace.writeFile("worker.js", `export default { fetch(_request, env) { env.db.exec("ATTACH DATABASE '/tmp/other' AS other"); return new Response("bad"); } };`);
  workspace.commit("test forbidden sql");
  const runtime = new ServiceRuntime(workspace, new Room("mine"), data);
  await expect(runtime.fetch(new Request("http://service/mine"), "head", "/")).rejects.toThrow("SQL operation is not allowed");
}, 20_000);

test("guest realtime capability publishes a bounded room event", async () => {
  const data = mkdtempSync(join(tmpdir(), "wasm-chat-runtime-"));
  const workspace = new RoomWorkspace(data, "mine");
  workspace.writeFile("worker.js", `export default { fetch(_request, env) { env.realtime.publish("changed", { id: 7 }); return new Response("ok"); } };`);
  workspace.commit("test realtime event");
  const runtime = new ServiceRuntime(workspace, new Room("mine"), data);
  const published: string[] = [];
  await runtime.fetch(new Request("http://service/mine"), "head", "/", (payload) => published.push(payload));
  expect(published.map((value) => JSON.parse(value))).toEqual([{ type: "changed", data: { id: 7 } }]);
});

test("guest scratch filesystem persists across isolates and rejects traversal", async () => {
  const data = mkdtempSync(join(tmpdir(), "wasm-chat-runtime-"));
  const workspace = new RoomWorkspace(data, "mine");
  workspace.writeFile("worker.js", `export default { fetch(request, env) { if(request.method==="POST") env.fs.writeText("state/note.txt", "durable"); return Response.json({value:env.fs.readText("state/note.txt"),files:env.fs.list()}); } };`);
  workspace.commit("test scratch filesystem");
  const runtime = new ServiceRuntime(workspace, new Room("mine"), data);
  await runtime.fetch(new Request("http://service/mine", { method: "POST" }), "head", "/");
  const result = await runtime.fetch(new Request("http://service/mine"), "head", "/");
  expect(JSON.parse(result.body)).toEqual({ value: "durable", files: [{ path: "state/note.txt", bytes: 7 }] });

  workspace.writeFile("worker.js", `export default { fetch(_request, env) { env.fs.readText("../other/secret"); return new Response("bad"); } };`);
  workspace.commit("test scratch traversal");
  await expect(runtime.fetch(new Request("http://service/mine"), "head", "/")).rejects.toThrow("scratch path escapes room");
});
