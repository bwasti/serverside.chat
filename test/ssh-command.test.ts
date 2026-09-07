import { expect, test } from "bun:test";
import { parseSshEntryCommand } from "../src/ssh-command";

test("SSH entry commands parse only bounded room and invite targets", () => {
  expect(parseSshEntryCommand("room mine")).toEqual({ kind: "room", roomName: "mine" });
  expect(parseSshEntryCommand("invite abcdefghijklmnopqrstuvwx")).toEqual({ kind: "invite", token: "abcdefghijklmnopqrstuvwx" });
  expect(() => parseSshEntryCommand("room ../../etc")).toThrow("usage");
  expect(() => parseSshEntryCommand("invite short")).toThrow("usage");
  expect(() => parseSshEntryCommand("sh -c whoami")).toThrow("usage");
});
