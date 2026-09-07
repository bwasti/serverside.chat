import type { AccountStore, Principal, RoomPolicy, RoomRole } from "./auth";

export type MessageKind = "chat" | "system" | "agent" | "commit";

export interface Message {
  id: number;
  kind: MessageKind;
  author: string;
  text: string;
  at: Date;
  url?: string;
  detail?: string;
  authorId?: string;
  authorRole?: RoomRole;
  agentVisible?: boolean;
}

export interface AgentSnapshot {
  status: "disabled" | "idle" | "queued" | "thinking" | "working" | "error";
  detail: string;
  events: string[];
  links: Array<{ label: string; url: string }>;
}

export interface AgentRequest {
  principal: Principal;
  explicit: boolean;
}

export const ROOM_LIMITS = { connections: 128, concurrentRequests: 32, egressBytesPerHour: 64 * 1024 * 1024, databaseBytes: 5 * 1024 * 1024, filesystemBytes: 5 * 1024 * 1024 } as const;

export class Room {
  readonly name: string;
  readonly messages: Message[] = [];
  readonly members = new Set<string>();
  private readonly memberConnections = new Map<string, number>();
  private nextId = 1;
  private listeners = new Set<(message: Message) => void>();
  private serviceListeners = new Set<() => void>();
  private readonly typing = new Set<string>();
  private readonly typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly serviceStartedAt: Date;
  serviceRequests = 0;
  serviceErrors = 0;
  serviceResponseBytes = 0;
  serviceTotalLatencyMs = 0;
  readonly serviceLogs: string[] = [];
  readonly versionGraph: Array<{ text: string; url?: string }> = [];
  webConnections = 0;
  activeRequests = 0;
  databaseBytes = 0;
  filesystemBytes = 0;
  lastRequestAt = 0;
  private readonly egressSamples: Array<{ at: number; bytes: number }> = [];
  private agentResponder?: (history: Message[], activity: (status: string, detail: string, link?: { label: string; url: string; blurb?: string }) => void, request: AgentRequest) => Promise<string>;
  private agentQueue = Promise.resolve();
  private passiveTimer?: ReturnType<typeof setTimeout>;
  readonly agentState: AgentSnapshot = { status: "disabled", detail: "no model", events: [], links: [] };

  constructor(name: string, private readonly historyLimit = 250, readonly pageUrl = `http://localhost:3000/${name}`, readonly owner = "owner", private readonly statePath?: string, private readonly accounts?: AccountStore) {
    this.name = name;
    this.serviceStartedAt = this.loadState();
  }

  subscribe(listener: (message: Message) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeService(listener: () => void): () => void {
    this.serviceListeners.add(listener);
    return () => this.serviceListeners.delete(listener);
  }

  get typingMembers(): string[] { return [...this.typing].sort(); }

  setTyping(username: string, active: boolean): void {
    const existing = this.typingTimers.get(username);
    if (existing) clearTimeout(existing);
    this.typingTimers.delete(username);
    if (!active) {
      if (this.typing.delete(username)) for (const listener of this.serviceListeners) listener();
      return;
    }
    const added = !this.typing.has(username);
    this.typing.add(username);
    const expiry = setTimeout(() => {
      if (this.typingTimers.get(username) !== expiry) return;
      this.typingTimers.delete(username);
      if (this.typing.delete(username)) for (const listener of this.serviceListeners) listener();
    }, 1_800);
    this.typingTimers.set(username, expiry);
    if (added) for (const listener of this.serviceListeners) listener();
  }

  setAgentResponder(responder: (history: Message[], activity: (status: string, detail: string, link?: { label: string; url: string; blurb?: string }) => void, request: AgentRequest) => Promise<string>): void {
    this.agentResponder = responder;
    this.updateAgent("idle", "listening");
  }

  get policy(): RoomPolicy {
    return this.accounts?.roomPolicy(this.name) ?? { name: this.name, ownerId: "local:owner", ownerHandle: this.owner, visibility: "public", contributions: "members", agentMode: "passive" };
  }

  roleFor(actor: Principal | string): RoomRole | undefined {
    const principal = this.resolvePrincipal(actor);
    return this.accounts?.roleFor(principal, this.name) ?? (principal.authenticated ? (principal.handle === this.owner ? "owner" : "contributor") : undefined);
  }

  canView(actor: Principal | string): boolean {
    const principal = this.resolvePrincipal(actor);
    return this.accounts?.canView(principal, this.name) ?? true;
  }

  canContribute(actor: Principal | string): boolean {
    const principal = this.resolvePrincipal(actor);
    return this.accounts?.canContribute(principal, this.name) ?? principal.authenticated;
  }

  canInvokeAgent(actor: Principal | string): boolean {
    const principal = this.resolvePrincipal(actor);
    return this.accounts?.canInvokeAgent(principal, this.name) ?? principal.authenticated;
  }

  updatePolicy(actor: Principal, changes: Partial<Pick<RoomPolicy, "visibility" | "contributions" | "agentMode">>): RoomPolicy {
    if (!this.accounts) throw new Error("room policy storage is not configured");
    const policy = this.accounts.updateRoomPolicy(actor, this.name, changes);
    for (const listener of this.serviceListeners) listener();
    return policy;
  }

  createInvite(actor: Principal, role: Exclude<RoomRole, "owner">): string {
    if (!this.accounts) throw new Error("account storage is not configured");
    return this.accounts.createInvite(actor, this.name, role);
  }

  addAgentLink(label: string, url: string): void {
    if (!this.agentState.links.some((link) => link.url === url)) {
      this.agentState.links.push({ label, url });
      this.saveState();
    }
  }

  setVersionGraph(lines: string[]): void {
    this.versionGraph.splice(0, this.versionGraph.length, ...lines.slice(0, 12).map((line) => {
      const text = line.replace(/[\r\n]/g, " ").slice(0, 120);
      const commit = text.match(/[0-9a-f]{7,40}/)?.[0];
      return { text, url: commit ? `${this.pageUrl}?__ref=${commit}` : undefined };
    }));
    for (const listener of this.serviceListeners) listener();
  }

  recordRequest(method: string, path: string, status: number, latencyMs = 0, responseBytes = 0): void {
    this.serviceRequests++;
    if (status >= 400) this.serviceErrors++;
    this.serviceResponseBytes += responseBytes;
    this.serviceTotalLatencyMs += latencyMs;
    this.lastRequestAt = Date.now();
    this.egressSamples.push({ at: this.lastRequestAt, bytes: responseBytes });
    this.pruneEgress();
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    this.serviceLogs.push(`${time} ${status} ${latencyMs.toFixed(1)}ms ${method} ${path}`);
    if (this.serviceLogs.length > 50) this.serviceLogs.shift();
    this.saveState();
    for (const listener of this.serviceListeners) listener();
  }

  get connectionCount(): number { return [...this.memberConnections.values()].reduce((sum, count) => sum + count, 0) + this.webConnections; }
  get egressBytesLastHour(): number { this.pruneEgress(); return this.egressSamples.reduce((sum, sample) => sum + sample.bytes, 0); }

  canSendResponse(bytes: number): boolean { return this.egressBytesLastHour + Math.max(0, bytes) <= ROOM_LIMITS.egressBytesPerHour; }
  tryBeginRequest(): boolean {
    if (this.activeRequests >= ROOM_LIMITS.concurrentRequests) return false;
    this.activeRequests++;
    return true;
  }
  endRequest(): void { this.activeRequests = Math.max(0, this.activeRequests - 1); }
  setWebConnections(count: number): void { this.webConnections = Math.max(0, Math.min(ROOM_LIMITS.connections, count)); for (const listener of this.serviceListeners) listener(); }
  recordResources(databaseBytes: number, filesystemBytes: number): void {
    const nextDatabaseBytes = Math.max(0, databaseBytes);
    const nextFilesystemBytes = Math.max(0, filesystemBytes);
    if (nextDatabaseBytes === this.databaseBytes && nextFilesystemBytes === this.filesystemBytes) return;
    this.databaseBytes = nextDatabaseBytes;
    this.filesystemBytes = nextFilesystemBytes;
    this.saveState();
    for (const listener of this.serviceListeners) listener();
  }

  recordServiceLog(text: string): void {
    this.recordServiceLogs([text]);
  }

  recordServiceLogs(lines: string[]): void {
    if (!lines.length) return;
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    for (const text of lines.slice(0, 20)) this.serviceLogs.push(`${time} ${text.replace(/[\r\n]/g, " ").slice(0, 500)}`);
    if (this.serviceLogs.length > 50) this.serviceLogs.splice(0, this.serviceLogs.length - 50);
    this.saveState();
  }

  tailServiceLogs(requested = 20): string[] {
    const limit = Math.max(1, Math.min(50, Math.floor(requested) || 20));
    const output: string[] = [];
    let bytes = 0;
    for (const line of this.serviceLogs.slice(-limit).reverse()) {
      const bounded = line.replace(/[\r\n]/g, " ").slice(0, 500);
      const size = Buffer.byteLength(bounded);
      if (bytes + size > 16 * 1024) break;
      output.unshift(bounded);
      bytes += size;
    }
    return output;
  }

  join(username: string): boolean {
    if (this.connectionCount >= ROOM_LIMITS.connections) return false;
    this.memberConnections.set(username, (this.memberConnections.get(username) ?? 0) + 1);
    this.members.add(username);
    for (const listener of this.serviceListeners) listener();
    return true;
  }

  leave(username: string): void {
    const remaining = (this.memberConnections.get(username) ?? 1) - 1;
    if (remaining > 0) this.memberConnections.set(username, remaining);
    else { this.memberConnections.delete(username); this.members.delete(username); }
    for (const listener of this.serviceListeners) listener();
  }

  chat(actor: Principal | string, text: string): boolean {
    const principal = this.resolvePrincipal(actor);
    if (!this.canContribute(principal)) return false;
    const clean = text.trim().slice(0, 2_000);
    if (clean) {
      this.post("chat", principal.handle, clean, undefined, undefined, principal);
      if (this.policy.agentMode === "passive" && this.canInvokeAgent(principal)) this.scheduleAgent(principal);
    }
    return true;
  }

  notice(text: string): void {
    this.post("system", "room", text.slice(0, 2_000));
  }

  agent(actor: Principal | string, prompt: string): boolean {
    const principal = this.resolvePrincipal(actor);
    if (!this.canInvokeAgent(principal)) return false;
    const clean = prompt.trim().slice(0, 2_000);
    if (!clean) {
      this.post("agent", "room-agent", "Try /agent status, or pass me a prompt.");
      return true;
    }
    this.post("chat", principal.handle, `@room-agent ${clean}`, undefined, undefined, principal);
    if (this.agentResponder) { this.runAgent(true, principal); return true; }
    const reply = clean.toLowerCase() === "status"
      ? `Room '${this.name}' is online with ${this.members.size} connected member(s). The Wasm/AI adapter is not configured yet.`
      : "I’m present, but this prototype has no model backend yet. Your prompt was recorded in the room transcript.";
    this.post("agent", "room-agent", reply);
    return true;
  }

  private scheduleAgent(requester: Principal): void {
    if (!this.agentResponder) return;
    if (this.passiveTimer) clearTimeout(this.passiveTimer);
    this.updateAgent("queued", "new room activity");
    this.passiveTimer = setTimeout(() => this.runAgent(false, requester), 700);
  }

  private runAgent(explicit: boolean, requester: Principal): void {
    if (!this.agentResponder) return;
    if (this.passiveTimer) clearTimeout(this.passiveTimer);
    this.passiveTimer = undefined;
    this.updateAgent("queued", explicit ? "direct request" : "reviewing conversation");
    this.agentQueue = this.agentQueue.then(async () => {
      let committed = false;
      const visibleHistory = this.messages.filter((message) => message.agentVisible || message.kind === "agent" || message.kind === "commit");
      const reply = await this.agentResponder!(visibleHistory, (status, detail, link) => {
        if (detail === "commit created") committed = true;
        this.updateAgent(status as AgentSnapshot["status"], detail, link);
      }, { principal: requester, explicit });
      if (!committed && reply && reply !== "[silent]") this.post("agent", "room-agent", reply);
      this.updateAgent("idle", committed || reply === "[silent]" ? "listening" : "response sent");
    }).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : "unknown error";
      this.updateAgent("error", detail);
    });
  }

  private updateAgent(status: AgentSnapshot["status"], detail: string, link?: { label: string; url: string; blurb?: string }): void {
    this.agentState.status = status;
    this.agentState.detail = detail.slice(0, 120);
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    const event = `${time} ${status} · ${this.agentState.detail}`;
    if (this.agentState.events.at(-1) !== event) this.agentState.events.push(event);
    if (this.agentState.events.length > 30) this.agentState.events.shift();
    if (detail === "preview archived" && link) {
      this.agentState.links.splice(0, this.agentState.links.length, ...this.agentState.links.filter((existing) => existing.url !== link.url));
    } else if (link && !this.agentState.links.some((existing) => existing.url === link.url)) {
      this.agentState.links.unshift(link);
      if (this.agentState.links.length > 5) this.agentState.links.pop();
    }
    if (detail === "canonical updated" && link) {
      const commit = link.label.match(/[0-9a-f]{7,40}/)?.[0];
      if (commit) this.agentState.links.splice(0, this.agentState.links.length, ...this.agentState.links.filter((item) => !item.url.includes(commit)));
      this.post("system", "trunk", `${link.label} · ${link.url}`);
    }
    if (detail === "commit created" && link) this.post("commit", "room-agent", link.label, link.url, link.blurb);
    this.saveState();
    for (const listener of this.serviceListeners) listener();
  }

  private post(kind: MessageKind, author: string, text: string, url?: string, detail?: string, principal?: Principal): void {
    const message: Message = { id: this.nextId++, kind, author: stripTerminalControls(author), text: stripTerminalControls(text), at: new Date(), url, detail: detail ? stripTerminalControls(detail) : undefined, authorId: principal?.id, authorRole: principal ? this.roleFor(principal) : undefined, agentVisible: principal ? this.canInvokeAgent(principal) : kind !== "chat" };
    this.messages.push(message);
    if (this.messages.length > this.historyLimit) this.messages.shift();
    this.saveState();
    for (const listener of this.listeners) listener(message);
  }

  private loadState(): Date {
    const fallback = new Date();
    if (!this.statePath || !existsSync(this.statePath)) return fallback;
    try {
      const state = JSON.parse(readFileSync(this.statePath, "utf8")) as Record<string, unknown>;
      if (Array.isArray(state.messages)) for (const raw of state.messages.slice(-this.historyLimit)) {
        if (!raw || typeof raw !== "object") continue;
        const item = raw as Record<string, unknown>;
        if (typeof item.id !== "number" || typeof item.author !== "string" || typeof item.text !== "string" || !["chat", "system", "agent", "commit"].includes(String(item.kind))) continue;
        const at = new Date(String(item.at));
        if (Number.isNaN(at.getTime())) continue;
        const oldRoomUrl = `http://localhost:3000/${encodeURIComponent(this.name)}`;
        this.messages.push({ id: item.id, kind: item.kind as MessageKind, author: item.author, text: item.text.replaceAll(oldRoomUrl, this.pageUrl), at, url: typeof item.url === "string" ? rebaseRoomUrl(item.url, this.pageUrl) : undefined, detail: typeof item.detail === "string" ? item.detail : undefined, authorId: typeof item.authorId === "string" ? item.authorId : undefined, authorRole: isRoomRole(item.authorRole) ? item.authorRole : undefined, agentVisible: typeof item.agentVisible === "boolean" ? item.agentVisible : item.kind !== "chat" });
        this.nextId = Math.max(this.nextId, item.id + 1);
      }
      this.serviceRequests = finiteNumber(state.serviceRequests);
      this.serviceErrors = finiteNumber(state.serviceErrors);
      this.serviceResponseBytes = finiteNumber(state.serviceResponseBytes);
      this.serviceTotalLatencyMs = finiteNumber(state.serviceTotalLatencyMs);
      this.databaseBytes = finiteNumber(state.databaseBytes);
      this.filesystemBytes = finiteNumber(state.filesystemBytes);
      if (Array.isArray(state.egressSamples)) for (const raw of state.egressSamples) { const sample = raw as Record<string, unknown>; if (typeof sample?.at === "number" && typeof sample.bytes === "number") this.egressSamples.push({ at: sample.at, bytes: sample.bytes }); }
      this.pruneEgress();
      if (Array.isArray(state.serviceLogs)) this.serviceLogs.push(...state.serviceLogs.filter((value): value is string => typeof value === "string").slice(-50));
      const agent = state.agentState as Record<string, unknown> | undefined;
      if (agent) {
        if (Array.isArray(agent.events)) this.agentState.events.push(...agent.events.filter((value): value is string => typeof value === "string").slice(-30));
        if (Array.isArray(agent.links)) for (const raw of agent.links.slice(-5)) {
          const link = raw as Record<string, unknown>;
          if (typeof link?.label === "string" && typeof link.url === "string") this.agentState.links.push({ label: link.label, url: rebaseRoomUrl(link.url, this.pageUrl) });
        }
      }
      const startedAt = new Date(String(state.serviceStartedAt));
      return Number.isNaN(startedAt.getTime()) ? fallback : startedAt;
    } catch {
      return fallback;
    }
  }

  private saveState(): void {
    if (!this.statePath) return;
    mkdirSync(dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.tmp`;
    writeFileSync(temporary, JSON.stringify({ messages: this.messages, serviceStartedAt: this.serviceStartedAt.toISOString(), serviceRequests: this.serviceRequests, serviceErrors: this.serviceErrors, serviceResponseBytes: this.serviceResponseBytes, serviceTotalLatencyMs: this.serviceTotalLatencyMs, serviceLogs: this.serviceLogs, databaseBytes: this.databaseBytes, filesystemBytes: this.filesystemBytes, egressSamples: this.egressSamples, agentState: { events: this.agentState.events, links: this.agentState.links } }, null, 2));
    renameSync(temporary, this.statePath);
  }

  private pruneEgress(): void {
    const cutoff = Date.now() - 60 * 60 * 1_000;
    while (this.egressSamples[0] && this.egressSamples[0].at < cutoff) this.egressSamples.shift();
  }

  private resolvePrincipal(actor: Principal | string): Principal {
    if (typeof actor !== "string") return actor;
    return { id: `local:${actor}`, kind: "user", handle: actor, displayName: actor, authenticated: true };
  }
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function rebaseRoomUrl(value: string, pageUrl: string): string {
  try {
    const old = new URL(value);
    const current = new URL(pageUrl);
    if (old.pathname === current.pathname) return `${pageUrl}${old.search}${old.hash}`;
  } catch { /* Preserve malformed legacy display data rather than dropping history. */ }
  return value;
}

function isRoomRole(value: unknown): value is RoomRole {
  return value === "owner" || value === "admin" || value === "contributor" || value === "viewer";
}

function stripTerminalControls(value: string): string {
  return value
    .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|.)/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
