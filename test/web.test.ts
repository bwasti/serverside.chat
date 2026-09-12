import { expect, test } from "bun:test";
import { browserTuiHtml, guestRequestHeaders, secureGuestResponseHeaders, trustedClientAddress } from "../src/web";

test("browser terminal is self-hosted and connects to the constrained TUI socket", async () => {
  const page = browserTuiHtml(["google", "github"]);
  expect(page).toContain('<link rel="stylesheet" href="/_terminal/xterm.css">');
  expect(page).toContain('<script src="/_terminal/xterm.js"></script>');
  expect(page).toContain('<script src="/_terminal/addon-fit.js"></script>');
  expect(page).toContain("attachCustomKeyEventHandler");
  expect(page).toContain("event.key==='ArrowUp'?'\\x1b[1;2A'");
  expect(page).toContain("event.key==='Enter'?'\\x1b[13;2u'");
  expect(page).toContain("new WebSocket(scheme+'//'+location.host+'/_terminal/socket");
  expect(page).not.toContain('id="signin"');
  expect(page).toContain("fetch('/_auth/development',{method:'POST'");
  expect(page).toContain("fetch('/_auth/ssh/link',{method:'POST'");
  expect(page).toContain("fetch('/_auth/invite/redeem',{method:'POST'");
  expect(page).toContain("new RegExp('^/invite/([a-zA-Z0-9_-]{20,64})/?$')");
  expect(page).toContain("location.href='/room/'+encodeURIComponent(result.roomName)");
  expect(page).toContain("linkHandler:{activate:activateLink}");
  expect(page).toContain("registerOscHandler(777");
  expect(page).toContain("background:'#3f3f3f'");
  expect(page).toContain("foreground:'#dcdccc'");
  expect(page).toContain("cursor:'#f0dfaf'");
  expect(page).toContain("location.pathname.split('/').filter(Boolean)");
  expect(page).toContain("body{position:fixed;left:0;right:0;top:0;bottom:auto;height:100dvh");
  expect(page).toContain("#terminal-shell{box-sizing:border-box;width:100%;height:100%;display:flex");
  expect(page).toContain("#terminal{box-sizing:border-box;width:100%;height:auto;flex:1 1 auto");
  expect(page).toContain('id="mobilekeys" aria-label="terminal keys"');
  expect(page).toContain('id="mobileinput" rows="1" inputmode="text" enterkeyhint="send" autocomplete="off" autocorrect="off"');
  expect(page).toContain('data-terminal-key="tab">TAB</button>');
  expect(page).toContain('data-terminal-key="escape">ESC</button>');
  expect(page).toContain('data-terminal-key="up" aria-label="up arrow">↑</button>');
  expect(page).toContain("const escapeKey=String.fromCharCode(27);const terminalKeys={tab:String.fromCharCode(9)");
  expect(page).toContain("mobileKeys.addEventListener('pointerdown'");
  expect(page).toContain("mobileInput.addEventListener('compositionend'");
  expect(page).toContain("mobileInput.addEventListener('keydown'");
  expect(page).toContain("mobileInput.addEventListener('input'");
  expect(page).toContain("if(mobileDevice)mobileInput.focus({preventScroll:true});else terminal.focus()");
  expect(page).toContain("html.mobile-device #mobilekeys{display:flex}");
  expect(page).not.toContain("(max-width:700px){#mobilekeys{display:flex}");
  expect(page).toContain("terminal.textarea.enterKeyHint='send'");
  expect(page).toContain("document.body.style.height=(viewport?.height||innerHeight)+'px'");
  expect(page).toContain("new ResizeObserver(refit).observe(terminalHost)");
  expect(page).toContain("window.visualViewport?.addEventListener('resize',syncViewport)");
  expect(page).toContain("document.fonts?.ready.then(refit)");
  expect(page).not.toContain("location.pathname.match(/^/room/");
  expect(page).toContain('data-provider="google"');
  expect(page).toContain('data-provider="github"');
  const inlineScript = page.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
  expect(inlineScript).toBeTruthy();
  expect(() => new Function(inlineScript!)).not.toThrow();
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
