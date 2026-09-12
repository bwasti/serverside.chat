import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore } from "../src/auth";
import { RoomDirectory } from "../src/room-directory";
import { handleWebDavRequest } from "../src/webdav";

function setup() {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-dav-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const owner = accounts.ensureLocalOwner("alice");
  accounts.ensureRoom("mine", owner, { visibility: "public", contributions: "members", clankerMode: "passive" });
  const directory = new RoomDirectory(accounts, data, "https://example.test");
  const credential = accounts.createMountCredential(owner, "mine", 60_000);
  const authorization = `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`;
  const request = (path: string, init: RequestInit = {}) => handleWebDavRequest(new Request(`https://example.test/_dav/mine/${path}`, {
    ...init,
    headers: { authorization, ...init.headers },
  }), accounts, directory);
  return { accounts, owner, directory, credential, request };
}

test("WebDAV exposes the bounded room filesystem with Finder-compatible discovery", async () => {
  const { accounts, directory, request } = setup();
  const unauthorized = await handleWebDavRequest(new Request("https://example.test/_dav/mine/README.md"), accounts, directory);
  expect(unauthorized.status).toBe(401);
  expect(unauthorized.headers.get("www-authenticate")).toContain("Basic realm=");

  const options = await request("", { method: "OPTIONS" });
  expect(options.status).toBe(204);
  expect(options.headers.get("dav")).toBe("1, 2");
  expect(options.headers.get("allow")).toContain("PROPFIND");

  const listing = await request("", { method: "PROPFIND", headers: { depth: "1" } });
  expect(listing.status).toBe(207);
  expect(await listing.text()).toContain("README.md");

  const createdDirectory = await request("notes/", { method: "MKCOL" });
  expect(createdDirectory.status).toBe(201);
  const created = await request("notes/hello.txt", { method: "PUT", body: "hello WebDAV" });
  expect(created.status).toBe(201);
  expect(directory.workspaces.get("mine")!.readFile("notes/hello.txt")).toBe("hello WebDAV");

  const read = await request("notes/hello.txt");
  expect(read.status).toBe(200);
  expect(read.headers.get("etag")).toBeTruthy();
  expect(await read.text()).toBe("hello WebDAV");
  accounts.close();
});

test("WebDAV enforces locks, room boundaries, quotas, and credential revocation", async () => {
  const { accounts, owner, directory, request } = setup();
  const locked = await request("README.md", { method: "LOCK", headers: { timeout: "Second-600" } });
  expect(locked.status).toBe(200);
  expect(locked.headers.get("timeout")).toBe("Second-300");
  const lockToken = locked.headers.get("lock-token")!;

  expect((await request("README.md", { method: "PUT", body: "blocked" })).status).toBe(423);
  expect((await request("README.md", { method: "PUT", body: "updated", headers: { if: `(${lockToken})` } })).status).toBe(204);
  expect((await request("README.md", { method: "UNLOCK", headers: { "lock-token": lockToken } })).status).toBe(204);

  const moved = await request("README.md", { method: "MOVE", headers: { destination: "https://example.test/_dav/mine/MOVED.md" } });
  expect(moved.status).toBe(201);
  expect(directory.workspaces.get("mine")!.readFile("MOVED.md")).toBe("updated");
  expect((await request(".%67it/config", { method: "GET" })).status).toBe(400);
  expect((await request("large.bin", { method: "PUT", headers: { "content-length": String(513 * 1024) } })).status).toBe(413);

  accounts.revokeMountCredentials(owner, "mine");
  expect((await request("MOVED.md")).status).toBe(401);
  accounts.close();
});

test("WebDAV checks current contribution policy on every write", async () => {
  const { accounts, owner, directory } = setup();
  const viewer = accounts.ensureLocalOwner("bob");
  const credential = accounts.createMountCredential(viewer, "mine", 60_000);
  const authorization = `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`;
  const response = await handleWebDavRequest(new Request("https://example.test/_dav/mine/nope.txt", { method: "PUT", body: "nope", headers: { authorization } }), accounts, directory);
  expect(response.status).toBe(403);

  accounts.updateRoomPolicy(owner, "mine", { contributions: "disabled" });
  const ownerCredential = accounts.createMountCredential(owner, "mine", 60_000);
  const ownerAuthorization = `Basic ${Buffer.from(`${ownerCredential.username}:${ownerCredential.password}`).toString("base64")}`;
  const ownerResponse = await handleWebDavRequest(new Request("https://example.test/_dav/mine/nope.txt", { method: "PUT", body: "nope", headers: { authorization: ownerAuthorization } }), accounts, directory);
  expect(ownerResponse.status).toBe(403);
  accounts.close();
});
