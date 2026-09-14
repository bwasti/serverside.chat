import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Room } from "../src/room";
import { ServiceRuntime } from "../src/runtime";
import { RoomWorkspace } from "../src/workspace";

test("QuickJS service shares durable room-scoped SQLite across fresh requests", async () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-runtime-"));
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

test("default static services return 404 for unknown and protected asset paths", async () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-runtime-assets-"));
  const workspace = new RoomWorkspace(data, "static-room");
  const runtime = new ServiceRuntime(workspace, new Room("static-room"), data);
  const root = await runtime.fetch(new Request("http://service/"), "stable", "/");
  const stylesheet = await runtime.fetch(new Request("http://service/serverside.css"), "stable", "/serverside.css");
  const missing = await runtime.fetch(new Request("http://service/actuator/configprops"), "stable", "/actuator/configprops");
  const protectedPath = await runtime.fetch(new Request("http://service/.git/config"), "stable", "/.git/config");
  const malformedPath = await runtime.fetch(new Request("http://service/"), "stable", "/%E0%A4%A");
  const source = await runtime.fetch(new Request("http://service/worker.js"), "stable", "/worker.js");
  const readme = await runtime.fetch(new Request("http://service/README.md"), "stable", "/README.md");
  const postAsset = await runtime.fetch(new Request("http://service/", { method: "POST" }), "stable", "/");
  const invalidDeployment = await runtime.fetch(new Request("http://service/"), "deadbee", "/");
  expect(root.status).toBe(200);
  expect(stylesheet).toMatchObject({ status: 200, headers: expect.objectContaining({ "content-type": "text/css; charset=utf-8" }) });
  expect(stylesheet.body).toContain("--accent: #7f9f7f");
  expect(missing).toMatchObject({ status: 404, body: "Not found\n" });
  expect(protectedPath).toMatchObject({ status: 404, body: "Not found\n" });
  expect(malformedPath).toMatchObject({ status: 404, body: "Not found\n" });
  expect(source.status).toBe(404);
  expect(readme.status).toBe(404);
  expect(postAsset).toMatchObject({ status: 405, headers: expect.objectContaining({ allow: "GET, HEAD" }) });
  expect(invalidDeployment).toMatchObject({ status: 404, body: "Deployment not found\n" });
});

test("database capability rejects cross-tenant and administrative SQL", async () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-runtime-"));
  const workspace = new RoomWorkspace(data, "mine");
  workspace.writeFile("worker.js", `export default { fetch(_request, env) { env.db.exec("ATTACH DATABASE '/tmp/other' AS other"); return new Response("bad"); } };`);
  workspace.commit("test forbidden sql");
  const runtime = new ServiceRuntime(workspace, new Room("mine"), data);
  await expect(runtime.fetch(new Request("http://service/mine"), "head", "/")).rejects.toThrow("SQL operation is not allowed");
}, 20_000);

test("database capability rejects recursive query amplification", async () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-runtime-sql-dos-"));
  const workspace = new RoomWorkspace(data, "mine");
  workspace.writeFile("worker.js", `export default { fetch(_request, env) { env.db.query("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT x FROM n"); return new Response("bad"); } };`);
  workspace.commit("test recursive sql");
  const runtime = new ServiceRuntime(workspace, new Room("mine"), data);
  await expect(runtime.fetch(new Request("http://service/mine"), "head", "/")).rejects.toThrow("recursive SQL is not allowed");
}, 20_000);

test("guest realtime capability publishes a bounded room event", async () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-runtime-"));
  const workspace = new RoomWorkspace(data, "mine");
  workspace.writeFile("worker.js", `export default { fetch(_request, env) { env.realtime.publish("changed", { id: 7 }); return new Response("ok"); } };`);
  workspace.commit("test realtime event");
  const runtime = new ServiceRuntime(workspace, new Room("mine"), data);
  const published: string[] = [];
  await runtime.fetch(new Request("http://service/mine"), "head", "/", (payload) => published.push(payload));
  expect(published.map((value) => JSON.parse(value))).toEqual([{ type: "changed", data: { id: 7 } }]);
});

test("guest realtime fanout is bounded per request", async () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-runtime-realtime-limit-"));
  const workspace = new RoomWorkspace(data, "mine");
  workspace.writeFile("worker.js", `export default { fetch(_request, env) { for(let i=0;i<9;i++) env.realtime.publish("changed", { i }); return new Response("bad"); } };`);
  workspace.commit("test realtime limit");
  const runtime = new ServiceRuntime(workspace, new Room("mine"), data);
  const published: string[] = [];
  await expect(runtime.fetch(new Request("http://service/mine"), "head", "/", (payload) => published.push(payload))).rejects.toThrow("realtime publish limit exceeded");
  expect(published).toHaveLength(8);
});

test("guest scratch filesystem persists across isolates and rejects traversal", async () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-runtime-"));
  const room = new Room("mine");
  const workspace = new RoomWorkspace(data, "mine", undefined, (bytes) => room.recordSourceBytes(bytes));
  workspace.writeFile("worker.js", `export default { fetch(request, env) { if(request.method==="POST") env.fs.writeText("state/note.txt", "durable"); return Response.json({value:env.fs.readText("state/note.txt"),files:env.fs.list()}); } };`);
  workspace.commit("test scratch filesystem");
  const runtime = new ServiceRuntime(workspace, room, data);
  await runtime.fetch(new Request("http://service/mine", { method: "POST" }), "head", "/");
  const result = await runtime.fetch(new Request("http://service/mine"), "head", "/");
  expect(JSON.parse(result.body)).toEqual({ value: "durable", files: [{ path: "state/note.txt", bytes: 7 }] });
  expect(room.sourceBytes).toBe(workspace.listTree().reduce((sum, file) => sum + file.bytes, 0));
  expect(room.scratchFilesystemBytes).toBe(7);
  expect(room.filesystemBytes).toBe(room.sourceBytes + 7);

  workspace.writeFile("worker.js", `export default { fetch(_request, env) { env.fs.readText("../other/secret"); return new Response("bad"); } };`);
  workspace.commit("test scratch traversal");
  await expect(runtime.fetch(new Request("http://service/mine"), "head", "/")).rejects.toThrow("scratch path escapes room");
});

test("guest CPU limit interrupts runaway service code", async () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-runtime-"));
  const workspace = new RoomWorkspace(data, "mine");
  workspace.writeFile("worker.js", `export default { fetch() { while (true) {} } };`);
  workspace.commit("test runaway worker");
  const runtime = new ServiceRuntime(workspace, new Room("mine"), data);
  const started = performance.now();

  await expect(runtime.fetch(new Request("http://service/mine"), "head", "/")).rejects.toThrow();
  expect(performance.now() - started).toBeLessThan(2_000);
}, 5_000);
