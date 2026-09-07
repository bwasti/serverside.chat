import type { ServerChannel } from "ssh2";
import type { Message, Room } from "./room";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const HEADER = `${ESC}48;5;234m${ESC}38;5;45m`;
const COMPOSER = `${ESC}48;5;238m${ESC}38;5;255m`;
const SIDEBAR = `${ESC}48;5;236m${ESC}38;5;250m`;
const SIDEBAR_MUTED = `${ESC}48;5;236m${ESC}38;5;244m`;
const SIDEBAR_ACTIVE = `${ESC}48;5;60m${ESC}38;5;255m`;
const HUD = `${ESC}48;5;233m${ESC}38;5;250m`;
const HUD_MUTED = `${ESC}48;5;233m${ESC}38;5;244m`;
const MUTED = `${ESC}38;5;244m`;
const CHAT = `${ESC}38;5;252m`;
const AGENT = `${ESC}38;5;81m`;
const OWNER = `${ESC}38;5;213m`;
const DIM = `${ESC}2m`;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class TuiSession {
  private width = 80;
  private height = 24;
  private input = "";
  private closed = false;
  private unsubscribe: () => void;
  private unsubscribeService: () => void;
  private lastWasCarriageReturn = false;
  private roomIndex = 0;
  private sidebarFocused = false;
  private room: Room;
  private animationTimer?: ReturnType<typeof setInterval>;
  private sidebarAnimationTimer?: ReturnType<typeof setInterval>;
  private sidebarWidth = 3;
  private scrollOffset = 0;

  constructor(private readonly stream: ServerChannel, private readonly rooms: Room[], private readonly username: string) {
    this.room = rooms[0]!;
    this.write("\x1b[?1049h\x1b[?25h");
    this.unsubscribe = this.room.subscribe(() => this.render());
    this.unsubscribeService = this.room.subscribeService(() => this.render());
    this.room.join(username);
    stream.on("data", (data: Buffer) => this.onData(data));
    stream.on("close", () => this.close());
    stream.on("end", () => this.close());
    this.render();
  }

  resize(width: number, height: number): void {
    this.width = Math.max(40, width || 80);
    this.height = Math.max(10, height || 24);
    if (this.sidebarFocused) this.animateSidebar();
    this.render();
  }

  private onData(data: Buffer): void {
    // SSH is a byte stream: a packet may contain one key, many keys, or pasted lines.
    // Handle navigation, then remove other terminal key escape sequences.
    const navigated = data.toString("utf8")
      .replace(/\x1b\[([AB])/g, (_sequence, direction: string) => {
        if (this.sidebarFocused) this.moveRoom(direction === "A" ? -1 : 1);
        else this.scrollChat(direction === "A" ? 1 : -1);
        return "";
      })
      .replace(/\x1b\[([56])~/g, (_sequence, direction: string) => {
        if (!this.sidebarFocused) this.scrollChat(direction === "5" ? 8 : -8);
        return "";
      });
    const value = navigated.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|.)/g, "");
    let dirty = false;
    for (const char of value) {
      if (char === "\x03" || char === "\x04") {
        this.stream.end();
        return;
      }
      if (char === "\t") {
        this.sidebarFocused = !this.sidebarFocused;
        this.animateSidebar();
        dirty = true;
        continue;
      }
      if (this.sidebarFocused) continue;
      if (char === "\r" || char === "\n") {
        if (char === "\n" && this.lastWasCarriageReturn) {
          this.lastWasCarriageReturn = false;
          continue;
        }
        this.lastWasCarriageReturn = char === "\r";
        if (this.submit()) return;
        dirty = true;
        continue;
      }
      this.lastWasCarriageReturn = false;
      if (char === "\x7f" || char === "\b") {
        this.input = Array.from(this.input).slice(0, -1).join("");
        dirty = true;
      } else if (!/[\x00-\x1f\x7f]/.test(char)) {
        this.input = (this.input + char).slice(0, 2_000);
        dirty = true;
      }
    }
    if (dirty) this.render();
  }

  private moveRoom(offset: number): void {
    const next = (this.roomIndex + offset + this.rooms.length) % this.rooms.length;
    if (next === this.roomIndex) return;
    this.unsubscribe();
    this.unsubscribeService();
    this.room.leave(this.username);
    this.roomIndex = next;
    this.room = this.rooms[next]!;
    this.scrollOffset = 0;
    this.unsubscribe = this.room.subscribe(() => this.render());
    this.unsubscribeService = this.room.subscribeService(() => this.render());
    this.room.join(this.username);
    this.render();
  }

  private scrollChat(offset: number): void {
    this.scrollOffset = Math.max(0, this.scrollOffset + offset);
    this.render();
  }

  private submit(): boolean {
    const line = this.input;
    this.input = "";
    this.scrollOffset = 0;
    if (line === "/quit") {
      this.stream.end();
      return true;
    }
    if (line === "/help") this.room.agent(this.username, "");
    else if (line.startsWith("/agent")) this.room.agent(this.username, line.slice(6));
    else this.room.chat(this.username, line);
    return false;
  }

  private render(): void {
    if (this.closed) return;
    this.syncAgentAnimation();
    const sidebarWidth = Math.round(this.sidebarWidth);
    const hudWidth = this.width >= 100 ? Math.min(48, Math.max(34, Math.floor(this.width * 0.30))) : 0;
    const mainWidth = this.width - sidebarWidth - hudWidth;
    const pageLinks = this.pageLinkRows(mainWidth, Math.max(1, Math.min(5, this.height - 8)));
    const messageRows = Math.max(3, this.height - 2 - pageLinks.length);
    const contentRows = this.height - 2;
    const messages = this.room.messages.flatMap((message) =>
      this.formatMessage(message, mainWidth).map((text) => ({ text, kind: message.kind, owner: message.author === this.room.owner })),
    );
    const maximumOffset = Math.max(0, messages.length - messageRows);
    this.scrollOffset = Math.min(this.scrollOffset, maximumOffset);
    const end = messages.length - this.scrollOffset;
    const visible = messages.slice(Math.max(0, end - messageRows), end);
    while (visible.length < messageRows) visible.unshift({ text: "", kind: "chat", owner: false });

    const title = `  # ${this.room.name}`;
    const status = `${this.scrollOffset ? `↑${this.scrollOffset}  ` : ""}${this.room.members.size} online  `;
    const headerGap = " ".repeat(Math.max(1, mainWidth - title.length - status.length));
    const sidebarHeader = sidebarWidth <= 3
      ? `${SIDEBAR_MUTED}${pad(" › ", sidebarWidth)}${RESET}`
      : `${SIDEBAR}${pad(truncate("  wasm chat", sidebarWidth), sidebarWidth)}${RESET}`;
    const paneTone = this.sidebarFocused ? DIM : "";
    const hudHeader = hudWidth ? `${HUD}${pad("  SERVICE", hudWidth)}${RESET}` : "";
    const header = `${sidebarHeader}${paneTone}${HEADER}${title}${headerGap}${status}${RESET}${hudHeader}`;
    const linkHeaders = pageLinks.map((link, index) => `${this.sidebarRow(index, sidebarWidth)}${paneTone}${HEADER}${link}${RESET}${this.hudRow(index, hudWidth, contentRows)}`);
    const body = visible.map(({ text, kind, owner }, index) => {
      const color = owner ? OWNER : kind === "agent" || kind === "commit" ? AGENT : kind === "system" ? MUTED : CHAT;
      const columnRow = index + pageLinks.length;
      const renderedText = kind === "commit" ? padAnsi(text, mainWidth) : pad(truncate(text, mainWidth), mainWidth);
      return `${this.sidebarRow(columnRow, sidebarWidth)}${paneTone}${color}${renderedText}${RESET}${this.hudRow(columnRow, hudWidth, contentRows)}`;
    });
    const inputText = `  ${this.input}`;
    const sidebarFooter = sidebarWidth <= 3
      ? `${SIDEBAR}${pad(" @ ", sidebarWidth)}${RESET}`
      : `${SIDEBAR}${pad(truncate(`  @${this.username}`, sidebarWidth), sidebarWidth)}${RESET}`;
    const hudFooter = hudWidth ? `${HUD_MUTED}${pad("  host scaffold", hudWidth)}${RESET}` : "";
    const composer = `${sidebarFooter}${paneTone}${COMPOSER}${pad(truncate(inputText, mainWidth), mainWidth)}${RESET}${hudFooter}`;
    const cursorColumn = sidebarWidth + Math.min(mainWidth, Array.from(inputText).length + 1);
    const screen = [header, ...linkHeaders, ...body, composer].join("\r\n");
    const cursor = this.sidebarFocused ? `${ESC}?25l` : `${ESC}${this.height};${cursorColumn}H${ESC}?25h`;
    this.write(`${ESC}?25l${ESC}H${ESC}2J${screen}${cursor}`);
  }

  private pageLinkRows(width: number, _limit: number): string[] {
    const links = [{ label: "main", url: this.room.pageUrl }];
    return links.map((link) => {
      const ref = compactUrl(link.url).replace(/^localhost:\d+\//, "");
      const description = link.label === "head" ? "working tip" : link.label;
      const label = truncate(`  ↗ ${ref}  —  ${description}`, width);
      const rendered = `\x1b]8;;${link.url}\x1b\\${ESC}4m${label}${ESC}24m\x1b]8;;\x1b\\`;
      return rendered + " ".repeat(Math.max(0, width - Array.from(label).length));
    });
  }

  private hudRow(index: number, width: number, rows: number): string {
    if (!width) return "";
    const uptimeSeconds = Math.floor((Date.now() - this.room.serviceStartedAt.getTime()) / 1_000);
    const averageLatency = this.room.serviceRequests ? this.room.serviceTotalLatencyMs / this.room.serviceRequests : 0;
    const recentRequests = this.room.serviceLogs.slice(-3);
    const fixed: Array<{ text: string; heading?: boolean; url?: string }> = [
      { text: "  RUNTIME", heading: true },
      { text: "  host scaffold" },
      { text: `  users     ${this.room.members.size}` },
      { text: `  requests  ${this.room.serviceRequests}` },
      { text: `  errors    ${this.room.serviceErrors}` },
      { text: `  avg       ${averageLatency.toFixed(1)}ms` },
      { text: `  bytes     ${formatBytes(this.room.serviceResponseBytes)}` },
      { text: `  uptime    ${formatDuration(uptimeSeconds)}` },
      { text: "" },
      { text: "  HTTP ACTIVITY", heading: true },
      ...recentRequests.map((text) => ({ text })),
      { text: "" },
      { text: `  AGENT${this.agentIsActive() ? ` ${SPINNER[Math.floor(Date.now() / 100) % SPINNER.length]}` : ""}`, heading: true },
      { text: `  ${this.room.agentState.status}` },
      { text: `  ${this.room.agentState.detail}` },
      { text: "" },
      { text: "  AGENT ACTIVITY", heading: true },
    ];
    const graphLineCount = Math.min(this.room.versionGraph.length, Math.max(0, rows - fixed.length - 2), 7);
    const versionRows: Array<{ text: string; heading?: boolean; url?: string }> = graphLineCount
      ? [{ text: "" }, { text: "  VERSION STACKS", heading: true }, ...this.room.versionGraph.slice(0, graphLineCount).map((line) => ({ text: `  ${line.text}`, url: line.url }))]
      : [];
    let row = fixed[index];
    const versionStart = rows - versionRows.length;
    if (versionRows.length && index >= versionStart) row = versionRows[index - versionStart];
    else if (row === undefined && index >= fixed.length) {
      const available = Math.max(0, versionStart - fixed.length);
      const events = this.room.agentState.events.slice(-available);
      row = { text: events[index - fixed.length] ?? "" };
    }
    row ??= { text: "" };
    const style = row.heading ? HUD_MUTED : HUD;
    const label = pad(truncate(row.text, width), width);
    const content = row.url ? `\x1b]8;;${row.url}\x1b\\${ESC}4m${label}${ESC}24m\x1b]8;;\x1b\\` : label;
    return `${style}${content}${RESET}`;
  }

  private sidebarRow(index: number, width: number): string {
    if (width <= 3) {
      const roomIndex = index - 1;
      const marker = roomIndex === this.roomIndex ? " ● " : roomIndex >= 0 && roomIndex < this.rooms.length ? " · " : "   ";
      return `${roomIndex === this.roomIndex ? SIDEBAR_ACTIVE : SIDEBAR}${pad(marker, width)}${RESET}`;
    }
    if (index === 0) return `${SIDEBAR_MUTED}${pad(truncate(this.sidebarFocused ? "  ROOMS  ↑↓" : "  ROOMS", width), width)}${RESET}`;
    const roomIndex = index - 1;
    if (roomIndex < this.rooms.length) {
      const style = roomIndex === this.roomIndex ? SIDEBAR_ACTIVE : SIDEBAR;
      return `${style}${pad(truncate(`  # ${this.rooms[roomIndex]!.name}`, width), width)}${RESET}`;
    }
    return `${SIDEBAR}${" ".repeat(width)}${RESET}`;
  }

  private formatMessage(message: Message, width: number): string[] {
    const time = message.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    const marker = message.kind === "agent" ? "✦" : message.kind === "commit" ? "◆" : message.kind === "system" ? "·" : "›";
    const prefix = ` ${time} ${marker} ${message.author}  `;
    if (message.kind === "commit" && message.url) {
      const [hash, ...title] = message.text.split(" ");
      const suffix = `${title.join(" ")}${message.detail ? ` — ${message.detail}` : ""}`;
      const visible = truncate(`${prefix}${hash} ${suffix}`, width);
      const hashStart = visible.indexOf(hash);
      if (hashStart < 0) return [visible];
      const before = visible.slice(0, hashStart);
      const after = visible.slice(hashStart + hash.length);
      return [`${before}\x1b]8;;${message.url}\x1b\\${ESC}3m${ESC}4m${hash}${ESC}24m${after}${ESC}23m\x1b]8;;\x1b\\`];
    }
    return wrap(prefix + message.text.replace(/\s+/g, " "), width);
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    this.unsubscribeService();
    if (this.animationTimer) clearInterval(this.animationTimer);
    if (this.sidebarAnimationTimer) clearInterval(this.sidebarAnimationTimer);
    this.room.leave(this.username);
    this.write("\x1b[?25h\x1b[?1049l");
  }

  private write(value: string): void {
    if (!this.stream.destroyed) this.stream.write(value);
  }

  private agentIsActive(): boolean {
    return this.room.agentState.status === "queued" || this.room.agentState.status === "thinking" || this.room.agentState.status === "working";
  }

  private syncAgentAnimation(): void {
    if (this.agentIsActive() && !this.animationTimer) {
      this.animationTimer = setInterval(() => this.render(), 100);
    } else if (!this.agentIsActive() && this.animationTimer) {
      clearInterval(this.animationTimer);
      this.animationTimer = undefined;
    }
  }

  private expandedSidebarWidth(): number {
    return Math.min(20, Math.max(16, Math.floor(this.width * 0.22)));
  }

  private animateSidebar(): void {
    if (this.sidebarAnimationTimer) return;
    this.sidebarAnimationTimer = setInterval(() => {
      const target = this.sidebarFocused ? this.expandedSidebarWidth() : 3;
      const delta = target - this.sidebarWidth;
      if (Math.abs(delta) <= 2) {
        this.sidebarWidth = target;
        clearInterval(this.sidebarAnimationTimer);
        this.sidebarAnimationTimer = undefined;
      } else {
        this.sidebarWidth += Math.sign(delta) * 2;
      }
      this.render();
    }, 30);
  }
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes}B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)}KiB`;
  return `${(bytes / 1_048_576).toFixed(1)}MiB`;
}

function compactUrl(value: string): string {
  return value.replace(/^https?:\/\//, "")
    .replace(/\?__ref=([0-9a-f]{7})[^&]*/, "#$1")
    .replace("?__ref=head", "#head")
    .replace("?__ref=stable", "#stable")
    .replace(/\?__preview=([0-9a-f]{7})[^&]*/, "#$1");
}

function truncate(value: string, width: number): string {
  return Array.from(value).slice(0, width).join("");
}

function pad(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - Array.from(value).length));
}

function padAnsi(value: string, width: number): string {
  const visible = value.replace(/\x1b\][^\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  return value + " ".repeat(Math.max(0, width - Array.from(visible).length));
}

function wrap(value: string, width: number): string[] {
  const chars = Array.from(value);
  const lines: string[] = [];
  for (let index = 0; index < chars.length; index += width) lines.push(chars.slice(index, index + width).join(""));
  return lines.length ? lines : [""];
}
