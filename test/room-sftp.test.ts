import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attributes, FileEntry, SFTPWrapper } from "ssh2";
import { AccountStore } from "../src/auth";
import { RoomDirectory } from "../src/room-directory";
import { attachRoomSftp } from "../src/room-sftp";

class FakeSftp extends EventEmitter {
  replies: Array<{ kind: string; requestId: number; value: unknown }> = [];
  status(requestId: number, code: number, message?: string) { this.replies.push({ kind: "status", requestId, value: { code, message } }); }
  handle(requestId: number, handle: Buffer) { this.replies.push({ kind: "handle", requestId, value: handle }); }
  data(requestId: number, data: Buffer | string) { this.replies.push({ kind: "data", requestId, value: Buffer.from(data) }); }
  name(requestId: number, names: FileEntry[]) { this.replies.push({ kind: "name", requestId, value: names }); }
  attrs(requestId: number, attrs: Attributes) { this.replies.push({ kind: "attrs", requestId, value: attrs }); }
  reply(requestId: number, kind: string) {
    for (let index = this.replies.length - 1; index >= 0; index--) {
      const reply = this.replies[index]!;
      if (reply.requestId === requestId && reply.kind === kind) return reply;
    }
    return undefined;
  }
}

function setup() {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-sftp-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const owner = accounts.ensureLocalOwner("alice");
  const viewer = accounts.ensureLocalOwner("bob");
  accounts.ensureRoom("mine", owner, { visibility: "public", contributions: "members", clankerMode: "passive" });
  const directory = new RoomDirectory(accounts, data, "https://serverside.chat");
  return { accounts, owner, viewer, directory, workspace: directory.workspaces.get("mine")! };
}

test("virtual SFTP lists rooms and reads files without exposing host paths or Git metadata", () => {
  const { accounts, owner, directory } = setup();
  const sftp = new FakeSftp();
  attachRoomSftp(sftp as unknown as SFTPWrapper, owner, accounts, directory);

  sftp.emit("REALPATH", 1, ".");
  expect((sftp.reply(1, "name")!.value as FileEntry[])[0]!.filename).toBe("/");
  sftp.emit("OPENDIR", 2, "/");
  const directoryHandle = sftp.reply(2, "handle")!.value as Buffer;
  sftp.emit("READDIR", 3, directoryHandle);
  expect((sftp.reply(3, "name")!.value as FileEntry[]).map((entry) => entry.filename)).toEqual(["mine"]);

  sftp.emit("OPEN", 4, "/mine/README.md", 0x01, {});
  const fileHandle = sftp.reply(4, "handle")!.value as Buffer;
  sftp.emit("READ", 5, fileHandle, 0, 1024);
  expect((sftp.reply(5, "data")!.value as Buffer).toString()).toContain("# mine");
  sftp.emit("OPEN", 6, "/mine/.git/config", 0x01, {});
  expect((sftp.reply(6, "status")!.value as { code: number }).code).not.toBe(0);
  accounts.close();
});

test("virtual SFTP enforces contribution policy and commits writes atomically on close", () => {
  const { accounts, owner, viewer, directory, workspace } = setup();
  const readOnly = new FakeSftp();
  attachRoomSftp(readOnly as unknown as SFTPWrapper, viewer, accounts, directory);
  readOnly.emit("OPEN", 1, "/mine/README.md", 0x02 | 0x10, {});
  expect(readOnly.reply(1, "status")!.value).toMatchObject({ code: 3 });

  const writable = new FakeSftp();
  attachRoomSftp(writable as unknown as SFTPWrapper, owner, accounts, directory);
  writable.emit("OPEN", 2, "/mine/README.md", 0x02 | 0x10, {});
  const handle = writable.reply(2, "handle")!.value as Buffer;
  writable.emit("WRITE", 3, handle, 0, Buffer.from("# mounted edit\n"));
  writable.emit("CLOSE", 4, handle);
  expect(writable.reply(4, "status")!.value).toMatchObject({ code: 0 });
  expect(workspace.readFile("README.md")).toBe("# mounted edit\n");
  accounts.close();
});
