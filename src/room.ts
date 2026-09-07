export type MessageKind = "chat" | "system" | "agent" | "commit";

export interface Message {
  id: number;
  kind: MessageKind;
  author: string;
  text: string;
  at: Date;
  url?: string;
  detail?: string;
}

export interface AgentSnapshot {
  status: "disabled" | "idle" | "queued" | "thinking" | "working" | "error";
  detail: string;
  events: string[];
  links: Array<{ label: string; url: string }>;
}

export class Room {
  readonly name: string;
  readonly messages: Message[] = [];
  readonly members = new Set<string>();
  private nextId = 1;
  private listeners = new Set<(message: Message) => void>();
  private serviceListeners = new Set<() => void>();
  readonly serviceStartedAt: Date;
  serviceRequests = 0;
  serviceErrors = 0;
  serviceResponseBytes = 0;
  serviceTotalLatencyMs = 0;
  readonly serviceLogs: string[] = [];
  readonly versionGraph: Array<{ text: string; url?: string }> = [];
  private agentResponder?: (history: Message[], activity: (status: string, detail: string, link?: { label: string; url: string; blurb?: string }) => void, requester: string) => Promise<string>;
  private agentQueue = Promise.resolve();
  private passiveTimer?: ReturnType<typeof setTimeout>;
  readonly agentState: AgentSnapshot = { status: "disabled", detail: "no model", events: [], links: [] };

  constructor(name: string, private readonly historyLimit = 250, readonly pageUrl = `http://localhost:3000/${name}`, readonly owner = "owner", private readonly statePath?: string) {
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

  setAgentResponder(responder: (history: Message[], activity: (status: string, detail: string, link?: { label: string; url: string; blurb?: string }) => void, requester: string) => Promise<string>): void {
    this.agentResponder = responder;
    this.updateAgent("idle", "listening");
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
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    this.serviceLogs.push(`${time} ${status} ${latencyMs.toFixed(1)}ms ${method} ${path}`);
    if (this.serviceLogs.length > 50) this.serviceLogs.shift();
    this.saveState();
    for (const listener of this.serviceListeners) listener();
  }

  recordServiceLog(text: string): void {
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    this.serviceLogs.push(`${time} ${text.replace(/[\r\n]/g, " ").slice(0, 500)}`);
    if (this.serviceLogs.length > 50) this.serviceLogs.shift();
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

  join(username: string): void {
    this.members.add(username);
    for (const listener of this.serviceListeners) listener();
  }

  leave(username: string): void {
    if (this.members.delete(username)) for (const listener of this.serviceListeners) listener();
  }

  chat(username: string, text: string): void {
    const clean = text.trim().slice(0, 2_000);
    if (clean) {
      this.post("chat", username, clean);
      this.scheduleAgent(username);
    }
  }

  notice(text: string): void {
    this.post("system", "room", text.slice(0, 2_000));
  }

  agent(username: string, prompt: string): void {
    const clean = prompt.trim().slice(0, 2_000);
    if (!clean) {
      this.post("agent", "room-agent", "Try /agent status, or pass me a prompt.");
      return;
    }
    this.post("chat", username, `@room-agent ${clean}`);
    if (this.agentResponder) return this.runAgent(true, username);
    const reply = clean.toLowerCase() === "status"
      ? `Room '${this.name}' is online with ${this.members.size} connected member(s). The Wasm/AI adapter is not configured yet.`
      : "I’m present, but this prototype has no model backend yet. Your prompt was recorded in the room transcript.";
    this.post("agent", "room-agent", reply);
  }

  private scheduleAgent(username: string): void {
    if (!this.agentResponder) return;
    if (this.passiveTimer) clearTimeout(this.passiveTimer);
    this.updateAgent("queued", "new room activity");
    this.passiveTimer = setTimeout(() => this.runAgent(false, username), 700);
  }

  private runAgent(explicit: boolean, requester: string): void {
    if (!this.agentResponder) return;
    if (this.passiveTimer) clearTimeout(this.passiveTimer);
    this.passiveTimer = undefined;
    this.updateAgent("queued", explicit ? "direct request" : "reviewing conversation");
    this.agentQueue = this.agentQueue.then(async () => {
      let committed = false;
      const reply = await this.agentResponder!(this.messages.slice(), (status, detail, link) => {
        if (detail === "commit created") committed = true;
        this.updateAgent(status as AgentSnapshot["status"], detail, link);
      }, requester);
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

  private post(kind: MessageKind, author: string, text: string, url?: string, detail?: string): void {
    const message = { id: this.nextId++, kind, author, text, at: new Date(), url, detail };
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
        this.messages.push({ id: item.id, kind: item.kind as MessageKind, author: item.author, text: item.text.replaceAll(oldRoomUrl, this.pageUrl), at, url: typeof item.url === "string" ? rebaseRoomUrl(item.url, this.pageUrl) : undefined, detail: typeof item.detail === "string" ? item.detail : undefined });
        this.nextId = Math.max(this.nextId, item.id + 1);
      }
      this.serviceRequests = finiteNumber(state.serviceRequests);
      this.serviceErrors = finiteNumber(state.serviceErrors);
      this.serviceResponseBytes = finiteNumber(state.serviceResponseBytes);
      this.serviceTotalLatencyMs = finiteNumber(state.serviceTotalLatencyMs);
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
    writeFileSync(temporary, JSON.stringify({ messages: this.messages, serviceStartedAt: this.serviceStartedAt.toISOString(), serviceRequests: this.serviceRequests, serviceErrors: this.serviceErrors, serviceResponseBytes: this.serviceResponseBytes, serviceTotalLatencyMs: this.serviceTotalLatencyMs, serviceLogs: this.serviceLogs, agentState: { events: this.agentState.events, links: this.agentState.links } }, null, 2));
    renameSync(temporary, this.statePath);
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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
