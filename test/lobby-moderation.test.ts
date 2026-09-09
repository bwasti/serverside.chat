import { expect, test } from "bun:test";
import { anonymousPrincipal } from "../src/auth";
import { ANONYMOUS_LOBBY_LIMITS, AnonymousLobbyGate, type LobbyContentModerator } from "../src/lobby-moderation";

test("anonymous lobby moderation is fail-closed and bounded per identity", async () => {
  let reviews = 0;
  const moderator: LobbyContentModerator = { allows: async () => { reviews++; return true; } };
  const gate = new AnonymousLobbyGate(moderator, () => 1_000);
  const guest = anonymousPrincipal("SHA256:guest-one");

  for (let index = 0; index < ANONYMOUS_LOBBY_LIMITS.perIdentityPerMinute; index++) {
    expect(await gate.review(guest, `question ${index}?`)).toEqual({ allowed: true });
  }
  expect(await gate.review(guest, "one too many?")).toMatchObject({ allowed: false, reason: expect.stringContaining("limit") });
  expect(reviews).toBe(ANONYMOUS_LOBBY_LIMITS.perIdentityPerMinute);
  expect(await gate.review(guest, "x".repeat(ANONYMOUS_LOBBY_LIMITS.messageBytes + 1))).toMatchObject({ allowed: false, reason: expect.stringContaining("600 bytes") });
});

test("moderation errors and rejected content never fail open", async () => {
  const guest = anonymousPrincipal("SHA256:guest-two");
  const rejected = new AnonymousLobbyGate({ allows: async () => false });
  const broken = new AnonymousLobbyGate({ allows: async () => { throw new Error("provider down"); } });

  expect(await rejected.review(guest, "unsafe")).toEqual({ allowed: false, reason: "message was not posted" });
  expect(await broken.review(guest, "unchecked")).toMatchObject({ allowed: false, reason: expect.stringContaining("unavailable") });
});
