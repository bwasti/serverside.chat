import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore } from "../src/auth";
import { documentationIndex, hostedDocument, llmsText, roomAgentGuide, roomApiManifest } from "../src/agent-docs";
import { Room } from "../src/room";

test("hosted agent discovery points from a room URL to bounded machine workflows", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-agent-docs-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const owner = accounts.ensureLocalOwner("alice");
  accounts.ensureRoom("carsilike", owner, { visibility: "public", contributions: "members", clankerMode: "passive" });
  const room = new Room("carsilike", 250, "https://carsilike.serverside.chat", "alice", undefined, accounts);
  const guide = roomAgentGuide(room, "https://serverside.chat");
  expect(guide).toContain("ssh -p 2222 serverside.chat \"api carsilike status\"");
  expect(guide).toContain("sftp -P 2222 serverside.chat:/carsilike");
  expect(guide).toContain("never invokes a system shell");
  expect(roomApiManifest(room, "https://serverside.chat")).toMatchObject({ version: 1, room: "carsilike", site_url: "https://carsilike.serverside.chat" });
  expect(llmsText("https://serverside.chat")).toContain("/room/example/llms.txt");
  expect(documentationIndex("https://serverside.chat")).toContain("/docs/service-api.md");
  expect(hostedDocument("service-api.md")).toContain("# Room Service API");
  expect(hostedDocument("../README.md")).toBeUndefined();
  accounts.close();
});
