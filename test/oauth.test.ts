import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore } from "../src/auth";
import { OAuthService } from "../src/oauth";

test("Google and GitHub starts use exact callbacks, state, PKCE, and browser binding", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-oauth-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const oauth = new OAuthService(accounts, "https://serverside.chat", {
    google: { clientId: "google-client", clientSecret: "google-secret" },
    github: { clientId: "github-client", clientSecret: "github-secret" },
  });

  expect(oauth.available()).toEqual(["google", "github"]);
  const github = oauth.begin("github", "/?ssh=link-code");
  const githubUrl = new URL(github.url);
  expect(githubUrl.origin + githubUrl.pathname).toBe("https://github.com/login/oauth/authorize");
  expect(githubUrl.searchParams.get("redirect_uri")).toBe("https://serverside.chat/_auth/github/callback");
  expect(githubUrl.searchParams.get("code_challenge_method")).toBe("S256");
  expect(githubUrl.searchParams.get("code_challenge")).toHaveLength(43);
  expect(() => accounts.consumeOAuthFlow("github", githubUrl.searchParams.get("state")!, "wrong-browser-token")).toThrow("invalid or expired");
  expect(accounts.consumeOAuthFlow("github", githubUrl.searchParams.get("state")!, github.browserToken)).toMatchObject({ returnTo: "/?ssh=link-code" });

  const google = oauth.begin("google");
  const googleUrl = new URL(google.url);
  expect(googleUrl.origin + googleUrl.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  expect(googleUrl.searchParams.get("scope")).toBe("openid email profile");
  expect(googleUrl.searchParams.get("nonce")).toBeTruthy();
  accounts.close();
});

test("an additional OAuth identity links only to the initiating canonical account", () => {
  const data = mkdtempSync(join(tmpdir(), "serverside-chat-oauth-link-"));
  const accounts = new AccountStore(join(data, "accounts.sqlite"));
  const canonical = accounts.createDevelopmentAccount("alice").principal;
  const bootstrap = accounts.createAccountLink(canonical);
  const bootstrapPrincipal = accounts.consumeAccountLink(bootstrap.code);
  const oauth = new OAuthService(accounts, "https://serverside.chat", { github: { clientId: "client", clientSecret: "secret" } });
  const flow = oauth.begin("github", "/", bootstrapPrincipal);
  const flowUrl = new URL(flow.url);
  expect(accounts.consumeOAuthFlow("github", flowUrl.searchParams.get("state")!, flow.browserToken).linkUserId).toBe(canonical.id);
  const linked = accounts.authenticateIdentity({ provider: "github", subject: "42", handle: "different-handle" }, canonical);
  const resolved = accounts.authenticateIdentity({ provider: "github", subject: "42", handle: "ignored" });
  const other = accounts.createDevelopmentAccount("bob").principal;

  expect(linked.principal.id).toBe(canonical.id);
  expect(resolved.principal.id).toBe(canonical.id);
  expect(() => accounts.authenticateIdentity({ provider: "github", subject: "42", handle: "ignored" }, other)).toThrow("another account");
  accounts.close();
});
