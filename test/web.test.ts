import { expect, test } from "bun:test";
import { browserTuiHtml } from "../src/web";

test("browser terminal is self-hosted and connects to the constrained TUI socket", async () => {
  const page = browserTuiHtml(["google", "github"]);
  expect(page).toContain('<link rel="stylesheet" href="/_terminal/xterm.css">');
  expect(page).toContain('<script src="/_terminal/xterm.js"></script>');
  expect(page).toContain('<script src="/_terminal/addon-fit.js"></script>');
  expect(page).toContain("attachCustomKeyEventHandler");
  expect(page).toContain("new WebSocket(scheme+'//'+location.host+'/_terminal/socket");
  expect(page).toContain('<button id="signin" hidden>sign in</button>');
  expect(page).toContain("fetch('/_auth/development',{method:'POST'");
  expect(page).toContain("fetch('/_auth/ssh/link',{method:'POST'");
  expect(page).toContain("linkHandler:{activate:activateLink}");
  expect(page).toContain('data-provider="google"');
  expect(page).toContain('data-provider="github"');
  expect(browserTuiHtml([], false)).not.toContain('id="devwarning"');
  expect(await Bun.file("node_modules/@xterm/xterm/lib/xterm.js").exists()).toBe(true);
  expect(await Bun.file("node_modules/@xterm/xterm/lib/xterm.js.map").exists()).toBe(true);
  expect(await Bun.file("node_modules/@xterm/addon-fit/lib/addon-fit.js").exists()).toBe(true);
  expect(await Bun.file("node_modules/@xterm/addon-fit/lib/addon-fit.js.map").exists()).toBe(true);
});
