import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { AccountStore, type Principal, type WebSession } from "./auth";

export type OAuthProvider = "google" | "github";

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
}

export interface OAuthConfig {
  google?: OAuthProviderConfig;
  github?: OAuthProviderConfig;
}

export interface OAuthStart {
  url: string;
  browserToken: string;
  expiresAt: number;
}

export interface OAuthResult {
  principal: Principal;
  session: WebSession;
  returnTo: string;
}

const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export class OAuthService {
  constructor(private readonly accounts: AccountStore, private readonly baseUrl: string, private readonly config: OAuthConfig) {}

  available(): OAuthProvider[] {
    return (["google", "github"] as const).filter((provider) => Boolean(this.config[provider]?.clientId && this.config[provider]?.clientSecret));
  }

  begin(provider: OAuthProvider, returnTo = "/", linkTo?: Principal): OAuthStart {
    const config = this.requireConfig(provider);
    const flow = this.accounts.createOAuthFlow(provider, returnTo, 10 * 60 * 1_000, linkTo?.authenticated ? linkTo.id : undefined);
    const redirectUri = this.redirectUri(provider);
    const codeChallenge = createHash("sha256").update(flow.codeVerifier).digest("base64url");
    const url = provider === "google"
      ? new URL("https://accounts.google.com/o/oauth2/v2/auth")
      : new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", flow.state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    if (provider === "google") {
      url.searchParams.set("scope", "openid email profile");
      url.searchParams.set("nonce", flow.nonce);
      url.searchParams.set("prompt", "select_account");
    }
    return { url: url.toString(), browserToken: flow.browserToken, expiresAt: flow.expiresAt };
  }

  async finish(provider: OAuthProvider, code: string, state: string, browserToken: string): Promise<OAuthResult> {
    if (!/^[a-zA-Z0-9_.\/-]{1,512}$/.test(code)) throw new Error("authorization code is invalid");
    const config = this.requireConfig(provider);
    const flow = this.accounts.consumeOAuthFlow(provider, state, browserToken);
    const profile = provider === "google"
      ? await this.googleProfile(config, code, flow.codeVerifier, flow.nonce)
      : await this.githubProfile(config, code, flow.codeVerifier);
    const linkTo = flow.linkUserId ? this.accounts.principalForUserId(flow.linkUserId) : undefined;
    if (flow.linkUserId && !linkTo) throw new Error("account is no longer available");
    const account = this.accounts.authenticateIdentity({ provider, ...profile }, linkTo);
    return { principal: account.principal, session: this.accounts.createWebSession(account.principal), returnTo: flow.returnTo };
  }

  private async googleProfile(config: OAuthProviderConfig, code: string, codeVerifier: string, nonce: string) {
    const token = await postForm("https://oauth2.googleapis.com/token", {
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: this.redirectUri("google"),
    });
    if (typeof token.id_token !== "string") throw new Error("Google did not return an identity token");
    const verified = await jwtVerify(token.id_token, GOOGLE_JWKS, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: config.clientId,
    });
    if (verified.payload.nonce !== nonce || typeof verified.payload.sub !== "string") throw new Error("Google identity validation failed");
    const email = typeof verified.payload.email === "string" ? verified.payload.email : undefined;
    const displayName = typeof verified.payload.name === "string" ? verified.payload.name : undefined;
    return { subject: verified.payload.sub, handle: handleCandidate(email, displayName, "google-user"), displayName, email };
  }

  private async githubProfile(config: OAuthProviderConfig, code: string, codeVerifier: string) {
    const token = await postForm("https://github.com/login/oauth/access_token", {
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      code_verifier: codeVerifier,
      redirect_uri: this.redirectUri("github"),
    }, { accept: "application/json" });
    if (typeof token.access_token !== "string") throw new Error("GitHub did not return an access token");
    const response = await fetch("https://api.github.com/user", {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token.access_token}`,
        "user-agent": "serverside.chat",
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(10_000),
    });
    const user = await response.json() as Record<string, unknown>;
    if (!response.ok || (typeof user.id !== "number" && typeof user.id !== "string") || typeof user.login !== "string") throw new Error("GitHub identity lookup failed");
    const displayName = typeof user.name === "string" ? user.name : user.login;
    return { subject: String(user.id), handle: user.login, displayName, email: typeof user.email === "string" ? user.email : undefined };
  }

  private redirectUri(provider: OAuthProvider): string {
    return `${this.baseUrl.replace(/\/$/, "")}/_auth/${provider}/callback`;
  }

  private requireConfig(provider: OAuthProvider): OAuthProviderConfig {
    const config = this.config[provider];
    if (!config?.clientId || !config.clientSecret) throw new Error(`${provider} sign-in is not configured`);
    return config;
  }
}

async function postForm(url: string, fields: Record<string, string>, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok || body.error) throw new Error(typeof body.error_description === "string" ? body.error_description : "identity provider rejected sign-in");
  return body;
}

function handleCandidate(email: string | undefined, displayName: string | undefined, fallback: string): string {
  return email?.split("@", 1)[0] || displayName || fallback;
}
