import type { AccountStore, Principal, RoomPolicy, RoomRole } from "./auth";

export type MessageKind = "chat" | "system" | "clanker" | "commit";

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
  clankerVisible?: boolean;
  replyTo?: { id: number; author: string; excerpt: string };
  pinnedAt?: Date;
  pinnedBy?: string;
}

export interface ClankerSnapshot {
  status: "disabled" | "idle" | "queued" | "thinking" | "working" | "error";
  detail: string;
  events: string[];
  links: Array<{ label: string; url: string }>;
}

export interface ClankerRequest {
  principal: Principal;
  explicit: boolean;
}

export const ROOM_LIMITS = {
  connections: 128,
  concurrentRequests: 32,
  egressBytesPerHour: 64 * 1024 * 1024,
  databaseBytes: 5 * 1024 * 1024,
  sourceBytes: 5 * 1024 * 1024,
  scratchBytes: 5 * 1024 * 1024,
  filesystemBytes: 10 * 1024 * 1024,
} as const;
const TELEMETRY_VERSION = 2;

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
  sourceBytes = 0;
  scratchFilesystemBytes = 0;
  clankerOutputTokensLastHour = 0;
  clankerOutputTokenLimit = 1;
  lastRequestAt = 0;
  private readonly egressSamples: Array<{ at: number; bytes: number }> = [];
  private clankerResponder?: (history: Message[], activity: (status: string, detail: string, link?: { label: string; url: string; blurb?: string }) => void, request: ClankerRequest) => Promise<string>;
  private clankerQueue = Promise.resolve();
  private passiveTimer?: ReturnType<typeof setTimeout>;
  readonly clankerState: ClankerSnapshot = { status: "disabled", detail: "no model", events: [], links: [] };

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

  setClankerResponder(responder: (history: Message[], activity: (status: string, detail: string, link?: { label: string; url: string; blurb?: string }) => void, request: ClankerRequest) => Promise<string>): void {
    this.clankerResponder = responder;
    this.updateClanker("idle", "listening");
  }

  get policy(): RoomPolicy {
    return this.accounts?.roomPolicy(this.name) ?? { name: this.name, ownerId: "local:owner", ownerHandle: this.owner, visibility: "public", contributions: "members", clankerMode: "passive", system: false };
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

  canInvokeClanker(actor: Principal | string): boolean {
    const principal = this.resolvePrincipal(actor);
    return this.accounts?.canInvokeClanker(principal, this.name) ?? principal.authenticated;
  }

  updatePolicy(actor: Principal, changes: Partial<Pick<RoomPolicy, "visibility" | "contributions" | "clankerMode">>): RoomPolicy {
    if (!this.accounts) throw new Error("room policy storage is not configured");
    const policy = this.accounts.updateRoomPolicy(actor, this.name, changes);
    for (const listener of this.serviceListeners) listener();
    return policy;
  }

  createInvite(actor: Principal, role: Exclude<RoomRole, "owner">): string {
    if (!this.accounts) throw new Error("account storage is not configured");
    return this.accounts.createInvite(actor, this.name, role);
  }

  addClankerLink(label: string, url: string): void {
    if (!this.clankerState.links.some((link) => link.url === url)) {
      this.clankerState.links.push({ label, url });
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
    if (status >= 500) this.serviceErrors++;
    this.serviceResponseBytes += responseBytes;
    this.serviceTotalLatencyMs += latencyMs;
    this.lastRequestAt = Date.now();
    this.egressSamples.push({ at: this.lastRequestAt, bytes: responseBytes });
    this.pruneEgress();
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    const safeMethod = method.replace(/[^A-Z]/gi, "").slice(0, 12) || "REQUEST";
    const safePath = path.replace(/[\r\n]/g, " ").slice(0, 240);
    this.serviceLogs.push(`${time} ${status} ${latencyMs.toFixed(1)}ms ${safeMethod} ${safePath}`);
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
    const nextScratchBytes = Math.max(0, filesystemBytes);
    const nextFilesystemBytes = this.sourceBytes + nextScratchBytes;
    if (nextDatabaseBytes === this.databaseBytes && nextScratchBytes === this.scratchFilesystemBytes && nextFilesystemBytes === this.filesystemBytes) return;
    this.databaseBytes = nextDatabaseBytes;
    this.scratchFilesystemBytes = nextScratchBytes;
    this.filesystemBytes = nextFilesystemBytes;
    this.saveState();
    for (const listener of this.serviceListeners) listener();
  }

  recordSourceBytes(sourceBytes: number): void {
    const nextSourceBytes = Math.max(0, sourceBytes);
    const nextFilesystemBytes = nextSourceBytes + this.scratchFilesystemBytes;
    if (nextSourceBytes === this.sourceBytes && nextFilesystemBytes === this.filesystemBytes) return;
    this.sourceBytes = nextSourceBytes;
    this.filesystemBytes = nextFilesystemBytes;
    this.saveState();
    for (const listener of this.serviceListeners) listener();
  }

  recordClankerOutputTokenUsage(tokens: number, limit: number): void {
    const nextTokens = Math.max(0, Math.floor(tokens));
    const nextLimit = Math.max(1, Math.floor(limit));
    if (nextTokens === this.clankerOutputTokensLastHour && nextLimit === this.clankerOutputTokenLimit) return;
    this.clankerOutputTokensLastHour = nextTokens;
    this.clankerOutputTokenLimit = nextLimit;
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
    for (const listener of this.serviceListeners) listener();
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

  chat(actor: Principal | string, text: string, replyToId?: number): boolean {
    const principal = this.resolvePrincipal(actor);
    if (!this.canContribute(principal)) return false;
    const replyTo = replyToId === undefined ? undefined : this.replyReference(replyToId);
    if (replyToId !== undefined && !replyTo) return false;
    const clean = text.trim().slice(0, 2_000);
    if (clean) {
      this.post("chat", principal.handle, clean, undefined, undefined, principal, undefined, replyTo);
      if (this.policy.clankerMode === "passive" && this.canInvokeClanker(principal)) this.scheduleClanker(principal);
    }
    return true;
  }

  acceptModeratedAnonymousChat(principal: Principal, text: string, replyToId?: number): boolean {
    if (this.name !== "lobby" || !this.policy.system || principal.authenticated || principal.kind !== "anonymous") return false;
    const replyTo = replyToId === undefined ? undefined : this.replyReference(replyToId);
    if (replyToId !== undefined && !replyTo) return false;
    const clean = text.trim().slice(0, 600);
    if (!clean) return false;
    this.post("chat", principal.handle, clean, undefined, undefined, principal, true, replyTo);
    if (this.policy.clankerMode === "passive" && this.clankerResponder) this.scheduleClanker(principal);
    return true;
  }

  canDeleteMessage(actor: Principal | string): boolean {
    const principal = this.resolvePrincipal(actor);
    return this.accounts?.isAdmin(principal, this.name) ?? (principal.authenticated && principal.handle === this.owner);
  }

  get pinnedMessages(): Message[] {
    return this.messages.filter((message) => message.pinnedAt).sort((left, right) => left.pinnedAt!.getTime() - right.pinnedAt!.getTime());
  }

  canPinMessage(actor: Principal | string): boolean {
    return this.canDeleteMessage(actor);
  }

  setMessagePinned(actor: Principal | string, messageId: number, pinned: boolean): boolean {
    const principal = this.resolvePrincipal(actor);
    if (!this.canPinMessage(principal)) throw new Error("pinning messages requires a room admin");
    const message = this.messages.find((candidate) => candidate.id === messageId);
    if (!message || message.kind === "system") return false;
    if (Boolean(message.pinnedAt) === pinned) return true;
    if (pinned && this.pinnedMessages.length >= 5) throw new Error("this room already has 5 pinned messages");
    message.pinnedAt = pinned ? new Date() : undefined;
    message.pinnedBy = pinned ? principal.id : undefined;
    this.accounts?.audit(principal, this.name, pinned ? "chat.message.pin" : "chat.message.unpin", `${messageId} @${message.author}`);
    this.saveState();
    for (const listener of this.serviceListeners) listener();
    return true;
  }

  deleteMessage(actor: Principal | string, messageId: number): boolean {
    const principal = this.resolvePrincipal(actor);
    if (!this.canDeleteMessage(principal)) throw new Error("deleting messages requires a room admin");
    const index = this.messages.findIndex((message) => message.id === messageId);
    if (index < 0) return false;
    const [deleted] = this.messages.splice(index, 1);
    this.accounts?.audit(principal, this.name, "chat.message.delete", `${messageId} @${deleted!.author}`);
    this.saveState();
    for (const listener of this.serviceListeners) listener();
    return true;
  }

  notice(text: string): void {
    this.post("system", "room", text.slice(0, 2_000));
  }

  recordContributorCommit(principal: Principal, commit: string, title: string, detail = "", url?: string): void {
    this.post("commit", principal.handle, `${commit} ${title}`.slice(0, 2_000), url, detail.slice(0, 240), principal);
  }

  recordCanonicalUpdate(principal: Principal, commit: string, url: string): void {
    this.post("system", "trunk", `updated to ${commit} by @${principal.handle} · ${url}`.slice(0, 2_000));
  }

  clanker(actor: Principal | string, prompt: string): boolean {
    const principal = this.resolvePrincipal(actor);
    if (!this.canInvokeClanker(principal)) return false;
    const clean = prompt.trim().slice(0, 2_000);
    if (!clean) {
      this.post("clanker", "clanker", "Try /clanker status, or pass me a prompt.");
      return true;
    }
    this.post("chat", principal.handle, `@clanker ${clean}`, undefined, undefined, principal);
    if (this.clankerResponder) { this.runClanker(true, principal); return true; }
    const reply = clean.toLowerCase() === "status"
      ? `Room '${this.name}' is online with ${this.members.size} connected member(s). The clanker runtime is not configured yet.`
      : "I’m present, but this prototype has no model backend yet. Your prompt was recorded in the room transcript.";
    this.post("clanker", "clanker", reply);
    return true;
  }

  private scheduleClanker(requester: Principal): void {
    if (!this.clankerResponder) return;
    if (this.passiveTimer) clearTimeout(this.passiveTimer);
    this.updateClanker("queued", "new room activity");
    this.passiveTimer = setTimeout(() => this.runClanker(false, requester), 700);
  }

  private runClanker(explicit: boolean, requester: Principal): void {
    if (!this.clankerResponder) return;
    if (this.passiveTimer) clearTimeout(this.passiveTimer);
    this.passiveTimer = undefined;
    this.updateClanker("queued", explicit ? "direct request" : "reviewing conversation");
    this.clankerQueue = this.clankerQueue.then(async () => {
      let committed = false;
      const visibleHistory = this.messages.filter((message) => message.clankerVisible || message.kind === "clanker" || message.kind === "commit");
      const reply = await this.clankerResponder!(visibleHistory, (status, detail, link) => {
        if (detail === "commit created") committed = true;
        this.updateClanker(status as ClankerSnapshot["status"], detail, link);
      }, { principal: requester, explicit });
      if (!committed && reply && reply !== "[silent]") this.post("clanker", "clanker", reply);
      this.updateClanker("idle", committed || reply === "[silent]" ? "listening" : "response sent");
    }).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : "unknown error";
      this.updateClanker("error", detail);
    });
  }

  private updateClanker(status: ClankerSnapshot["status"], detail: string, link?: { label: string; url: string; blurb?: string }): void {
    this.clankerState.status = status;
    this.clankerState.detail = detail.slice(0, 120);
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    const event = `${time} ${status} · ${this.clankerState.detail}`;
    if (this.clankerState.events.at(-1) !== event) this.clankerState.events.push(event);
    if (this.clankerState.events.length > 30) this.clankerState.events.shift();
    if (status === "error") {
      const log = `${time} CLANKER error ${this.clankerState.detail}`;
      if (this.serviceLogs.at(-1) !== log) this.serviceLogs.push(log);
      if (this.serviceLogs.length > 50) this.serviceLogs.splice(0, this.serviceLogs.length - 50);
    }
    if (detail === "preview archived" && link) {
      this.clankerState.links.splice(0, this.clankerState.links.length, ...this.clankerState.links.filter((existing) => existing.url !== link.url));
    } else if (link && !this.clankerState.links.some((existing) => existing.url === link.url)) {
      this.clankerState.links.unshift(link);
      if (this.clankerState.links.length > 5) this.clankerState.links.pop();
    }
    if (detail === "canonical updated" && link) {
      const commit = link.label.match(/[0-9a-f]{7,40}/)?.[0];
      if (commit) this.clankerState.links.splice(0, this.clankerState.links.length, ...this.clankerState.links.filter((item) => !item.url.includes(commit)));
      this.post("system", "trunk", `updated to ${commit ?? link.label} · ${link.url}`);
    }
    if (detail === "commit created" && link) this.post("commit", "clanker", link.label, link.url, link.blurb);
    this.saveState();
    for (const listener of this.serviceListeners) listener();
  }

  private post(kind: MessageKind, author: string, text: string, url?: string, detail?: string, principal?: Principal, clankerVisible?: boolean, replyTo?: Message["replyTo"]): void {
    const message: Message = { id: this.nextId++, kind, author: stripTerminalControls(author), text: stripTerminalControls(text), at: new Date(), url, detail: detail ? stripTerminalControls(detail) : undefined, authorId: principal?.id, authorRole: principal ? this.roleFor(principal) : undefined, clankerVisible: clankerVisible ?? (principal ? this.canInvokeClanker(principal) : kind !== "chat"), replyTo };
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
        const storedKind = String(item.kind);
        if (typeof item.id !== "number" || typeof item.author !== "string" || typeof item.text !== "string" || !["chat", "system", "clanker", "agent", "commit"].includes(storedKind)) continue;
        const kind: MessageKind = storedKind === "agent" ? "clanker" : storedKind as MessageKind;
        const at = new Date(String(item.at));
        if (Number.isNaN(at.getTime())) continue;
        const oldRoomUrl = `http://localhost:3000/${encodeURIComponent(this.name)}`;
        const rawReply = item.replyTo as Record<string, unknown> | undefined;
        const replyTo = rawReply && typeof rawReply.id === "number" && typeof rawReply.author === "string" && typeof rawReply.excerpt === "string"
          ? { id: rawReply.id, author: legacyClankerAuthor(stripTerminalControls(rawReply.author).slice(0, 80)), excerpt: legacyClankerMention(stripTerminalControls(rawReply.excerpt).slice(0, 120)) }
          : undefined;
        const legacyVisible = typeof item.agentVisible === "boolean" ? item.agentVisible : undefined;
        const pinnedAt = item.pinnedAt === undefined ? undefined : new Date(String(item.pinnedAt));
        this.messages.push({ id: item.id, kind, author: legacyClankerAuthor(item.author), text: legacyClankerMention(item.text.replaceAll(oldRoomUrl, this.pageUrl)), at, url: typeof item.url === "string" ? rebaseRoomUrl(item.url, this.pageUrl) : undefined, detail: typeof item.detail === "string" ? legacyClankerMention(item.detail) : undefined, authorId: typeof item.authorId === "string" ? item.authorId : undefined, authorRole: isRoomRole(item.authorRole) ? item.authorRole : undefined, clankerVisible: typeof item.clankerVisible === "boolean" ? item.clankerVisible : legacyVisible ?? kind !== "chat", replyTo, pinnedAt: pinnedAt && !Number.isNaN(pinnedAt.getTime()) ? pinnedAt : undefined, pinnedBy: typeof item.pinnedBy === "string" ? item.pinnedBy : undefined });
        this.nextId = Math.max(this.nextId, item.id + 1);
      }
      this.serviceRequests = finiteNumber(state.serviceRequests);
      this.serviceErrors = state.telemetryVersion === TELEMETRY_VERSION ? finiteNumber(state.serviceErrors) : 0;
      this.serviceResponseBytes = finiteNumber(state.serviceResponseBytes);
      this.serviceTotalLatencyMs = finiteNumber(state.serviceTotalLatencyMs);
      this.databaseBytes = finiteNumber(state.databaseBytes);
      this.sourceBytes = finiteNumber(state.sourceBytes);
      this.scratchFilesystemBytes = state.scratchFilesystemBytes === undefined
        ? finiteNumber(state.filesystemBytes)
        : finiteNumber(state.scratchFilesystemBytes);
      this.filesystemBytes = this.sourceBytes + this.scratchFilesystemBytes;
      if (Array.isArray(state.egressSamples)) for (const raw of state.egressSamples) { const sample = raw as Record<string, unknown>; if (typeof sample?.at === "number" && typeof sample.bytes === "number") this.egressSamples.push({ at: sample.at, bytes: sample.bytes }); }
      this.pruneEgress();
      if (Array.isArray(state.serviceLogs)) this.serviceLogs.push(...state.serviceLogs.filter((value): value is string => typeof value === "string").slice(-50).map(legacyClankerTelemetry));
      const clanker = (state.clankerState ?? state.agentState) as Record<string, unknown> | undefined;
      if (clanker) {
        if (Array.isArray(clanker.events)) this.clankerState.events.push(...clanker.events.filter((value): value is string => typeof value === "string").slice(-30).map(legacyClankerTelemetry));
        if (Array.isArray(clanker.links)) for (const raw of clanker.links.slice(-5)) {
          const link = raw as Record<string, unknown>;
          if (typeof link?.label === "string" && typeof link.url === "string") this.clankerState.links.push({ label: link.label, url: rebaseRoomUrl(link.url, this.pageUrl) });
        }
        const lastClankerError = this.clankerState.events.at(-1)?.match(/^(\d{2}:\d{2}:\d{2}) error · (.*)$/);
        if (lastClankerError) {
          const log = `${lastClankerError[1]} CLANKER error ${lastClankerError[2]}`;
          if (!this.serviceLogs.includes(log)) this.serviceLogs.push(log);
          if (this.serviceLogs.length > 50) this.serviceLogs.splice(0, this.serviceLogs.length - 50);
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
    writeFileSync(temporary, JSON.stringify({ telemetryVersion: TELEMETRY_VERSION, messages: this.messages, serviceStartedAt: this.serviceStartedAt.toISOString(), serviceRequests: this.serviceRequests, serviceErrors: this.serviceErrors, serviceResponseBytes: this.serviceResponseBytes, serviceTotalLatencyMs: this.serviceTotalLatencyMs, serviceLogs: this.serviceLogs, databaseBytes: this.databaseBytes, filesystemBytes: this.filesystemBytes, sourceBytes: this.sourceBytes, scratchFilesystemBytes: this.scratchFilesystemBytes, egressSamples: this.egressSamples, clankerState: { events: this.clankerState.events, links: this.clankerState.links } }, null, 2));
    renameSync(temporary, this.statePath);
  }

  private pruneEgress(): void {
    const cutoff = Date.now() - 60 * 60 * 1_000;
    while (this.egressSamples[0] && this.egressSamples[0].at < cutoff) this.egressSamples.shift();
  }

  private replyReference(messageId: number): Message["replyTo"] | undefined {
    const message = this.messages.find((candidate) => candidate.id === messageId);
    if (!message) return undefined;
    return {
      id: message.id,
      author: stripTerminalControls(message.author).slice(0, 80),
      excerpt: stripTerminalControls(message.text).replace(/\s+/g, " ").slice(0, 120),
    };
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

function legacyClankerAuthor(value: string): string { return value === "room-agent" ? "clanker" : value; }
function legacyClankerMention(value: string): string { return value.replace(/@room-agent\b/g, "@clanker"); }
function legacyClankerTelemetry(value: string): string {
  return legacyClankerMention(value).replace(/\bAGENT\b/g, "CLANKER").replace(/\bagent\b/g, "clanker");
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
