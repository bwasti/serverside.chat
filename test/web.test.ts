import { expect, test } from "bun:test";
import { browserTuiHtml, guestRequestHeaders, secureGuestResponseHeaders, trustedClientAddress } from "../src/web";

test("browser terminal is self-hosted and connects to the constrained TUI socket", async () => {
  const page = browserTuiHtml(["google", "github"]);
  expect(page).toContain('<link rel="stylesheet" href="/_terminal/xterm.css">');
  expect(page).toContain('<script src="/_terminal/xterm.js"></script>');
  expect(page).toContain('<script src="/_terminal/addon-fit.js"></script>');
  expect(page).toContain("attachCustomKeyEventHandler");
  expect(page).toContain("new WebSocket(scheme+'//'+location.host+'/_terminal/socket");
  expect(page).not.toContain('id="signin"');
  expect(page).toContain("fetch('/_auth/development',{method:'POST'");
  expect(page).toContain("fetch('/_auth/ssh/link',{method:'POST'");
  expect(page).toContain("linkHandler:{activate:activateLink}");
  expect(page).toContain("registerOscHandler(777");
  expect(page).toContain("background:'#3f3f3f'");
  expect(page).toContain("foreground:'#dcdccc'");
  expect(page).toContain("cursor:'#f0dfaf'");
  expect(page).toContain("location.pathname.split('/').filter(Boolean)");
  expect(page).not.toContain("location.pathname.match(/^/room/");
  expect(page).toContain('data-provider="google"');
  expect(page).toContain('data-provider="github"');
  expect(browserTuiHtml([], false)).not.toContain('id="devwarning"');
  expect(await Bun.file("node_modules/@xterm/xterm/lib/xterm.js").exists()).toBe(true);
  expect(await Bun.file("node_modules/@xterm/xterm/lib/xterm.js.map").exists()).toBe(true);
  expect(await Bun.file("node_modules/@xterm/addon-fit/lib/addon-fit.js").exists()).toBe(true);
  expect(await Bun.file("node_modules/@xterm/addon-fit/lib/addon-fit.js.map").exists()).toBe(true);
});

test("untrusted services receive only origin-appropriate credentials", () => {
  const source = new Headers({
    authorization: "Bearer room-token",
    cookie: "room_session=abc",
    forwarded: "for=private",
    "x-forwarded-for": "10.0.0.1",
    "x-real-ip": "10.0.0.1",
    "x-client": "safe",
  });
  expect(guestRequestHeaders(source, false)).toEqual({ "x-client": "safe" });
  expect(guestRequestHeaders(source, true)).toEqual({ authorization: "Bearer room-token", cookie: "room_session=abc", "x-client": "safe" });

  const legacy = { "set-cookie": "central=stolen", "content-type": "text/plain" };
  secureGuestResponseHeaders(legacy, false);
  expect(legacy["set-cookie"]).toBeUndefined();
  const isolated = { "set-cookie": "room=ok; Path=/", "content-type": "text/plain" };
  secureGuestResponseHeaders(isolated, true);
  expect(isolated["set-cookie"]).toBe("room=ok; Path=/");
  const parentDomain = { "set-cookie": "room=bad; Domain=serverside.chat" };
  secureGuestResponseHeaders(parentDomain, true);
  expect(parentDomain["set-cookie"]).toBeUndefined();
});

test("forwarded client identity is trusted only from the local proxy", () => {
  const request = new Request("https://serverside.chat", { headers: { "x-forwarded-for": "203.0.113.8, 127.0.0.1" } });
  expect(trustedClientAddress(request, "127.0.0.1")).toBe("203.0.113.8");
  expect(trustedClientAddress(request, "198.51.100.4")).toBe("198.51.100.4");
});
