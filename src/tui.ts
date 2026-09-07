import type { ServerChannel } from "ssh2";
import { ROOM_LIMITS, type Message, type Room } from "./room";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const HEADER = `${ESC}48;5;234m${ESC}38;5;45m`;
const STATUS = `${ESC}48;5;234m${ESC}38;5;252m`;
const COMPOSER = `${ESC}48;5;238m${ESC}38;5;255m`;
const SIDEBAR = `${ESC}48;5;236m${ESC}38;5;250m`;
const SIDEBAR_MUTED = `${ESC}48;5;236m${ESC}38;5;244m`;
const SIDEBAR_ACTIVE = `${ESC}48;5;60m${ESC}38;5;255m`;
const HUD = `${ESC}48;5;233m${ESC}38;5;250m`;
const HUD_MUTED = `${ESC}48;5;233m${ESC}38;5;244m`;
const MUTED = `${ESC}38;5;244m`;
const CHAT = `${ESC}38;5;252m`;
const OWNER = `${ESC}38;5;213m`;
const DIM = `${ESC}2m`;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const GREEN = `${ESC}38;5;82m`;
const YELLOW = `${ESC}38;5;220m`;
const RED = `${ESC}38;5;203m`;
const CYAN = `${ESC}38;5;45m`;
const MAGENTA = `${ESC}38;5;213m`;

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
  private renderTimer?: ReturnType<typeof setTimeout>;
  private sidebarWidth = 3;
  private scrollOffset = 0;
  private lastFrame = "";
  private messageCacheRoom = "";
  private messageCacheWidth = 0;
  private readonly messageCache = new Map<number, string[]>();

  constructor(private readonly stream: ServerChannel, private readonly rooms: Room[], private readonly username: string) {
    this.room = rooms[0]!;
    this.write("\x1b[?1049h\x1b[?25h");
    this.unsubscribe = this.room.subscribe(() => this.scheduleRender());
    this.unsubscribeService = this.room.subscribeService(() => this.scheduleRender());
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
    this.unsubscribe = this.room.subscribe(() => this.scheduleRender());
    this.unsubscribeService = this.room.subscribeService(() => this.scheduleRender());
    this.messageCache.clear();
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
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }
    this.syncAnimation();
    const sidebarWidth = Math.round(this.sidebarWidth);
    const hudWidth = this.width >= 105 ? Math.min(50, Math.max(36, Math.floor(this.width * 0.32))) : 0;
    const mainWidth = this.width - sidebarWidth - hudWidth;
    const pageLinks = this.pageLinkRows(mainWidth, Math.max(1, Math.min(5, this.height - 8)));
    const topStatus = this.topStatusRows(mainWidth, this.height);
    const topRows = [...pageLinks, ...topStatus];
    const allInputRows = wrap(`  ${this.input}`, mainWidth);
    const maximumComposerRows = Math.max(1, Math.min(5, this.height - topRows.length - 4));
    const inputRows = allInputRows.slice(-maximumComposerRows);
    const messageRows = Math.max(3, this.height - 1 - topRows.length - inputRows.length);
    const contentRows = this.height - 2;
    if (this.messageCacheRoom !== this.room.name || this.messageCacheWidth !== mainWidth) {
      this.messageCacheRoom = this.room.name;
      this.messageCacheWidth = mainWidth;
      this.messageCache.clear();
    }
    const messages = this.room.messages.flatMap((message) => {
      let rows = this.messageCache.get(message.id);
      if (!rows) {
        rows = this.formatMessage(message, mainWidth);
        this.messageCache.set(message.id, rows);
      }
      return rows.map((text) => ({ text, kind: message.kind }));
    });
    if (this.messageCache.size > this.room.messages.length) {
      const retained = new Set(this.room.messages.map((message) => message.id));
      for (const id of this.messageCache.keys()) if (!retained.has(id)) this.messageCache.delete(id);
    }
    const maximumOffset = Math.max(0, messages.length - messageRows);
    this.scrollOffset = Math.min(this.scrollOffset, maximumOffset);
    const end = messages.length - this.scrollOffset;
    const visible = messages.slice(Math.max(0, end - messageRows), end);
    while (visible.length < messageRows) visible.unshift({ text: "", kind: "chat" });

    const title = `  # ${this.room.name}`;
    const status = `${this.scrollOffset ? `↑${this.scrollOffset}  ` : ""}${this.room.members.size} online  `;
    const headerGap = " ".repeat(Math.max(1, mainWidth - title.length - status.length));
    const sidebarHeader = sidebarWidth <= 3
      ? `${SIDEBAR_MUTED}${pad(" › ", sidebarWidth)}${RESET}`
      : `${SIDEBAR}${pad(truncate("  wasm chat", sidebarWidth), sidebarWidth)}${RESET}`;
    const paneTone = this.sidebarFocused ? DIM : "";
    const hudHeader = hudWidth ? `${HUD_MUTED}${pad("  VERSION CONTROL", hudWidth)}${RESET}` : "";
    const header = `${sidebarHeader}${paneTone}${HEADER}${title}${headerGap}${status}${RESET}${hudHeader}`;
    const statusHeaders = topRows.map((line, index) => `${this.sidebarRow(index, sidebarWidth)}${paneTone}${STATUS}${padAnsi(line, mainWidth)}${RESET}${this.hudRow(index, hudWidth)}`);
    const body = visible.map(({ text, kind }, index) => {
      const color = kind === "system" ? MUTED : CHAT;
      const columnRow = index + topRows.length;
      const renderedText = padAnsi(text, mainWidth);
      return `${this.sidebarRow(columnRow, sidebarWidth)}${paneTone}${color}${renderedText}${RESET}${this.hudRow(columnRow, hudWidth)}`;
    });
    const composer = inputRows.map((inputText, index) => {
      const last = index === inputRows.length - 1;
      const sidebarFooter = last
        ? sidebarWidth <= 3 ? `${SIDEBAR}${pad(" @ ", sidebarWidth)}${RESET}` : `${SIDEBAR}${pad(truncate(`  @${this.username}`, sidebarWidth), sidebarWidth)}${RESET}`
        : `${SIDEBAR}${" ".repeat(sidebarWidth)}${RESET}`;
      const hudFooter = hudWidth ? `${last ? HUD_MUTED : HUD}${pad(last ? "  linear history · rebase only" : "", hudWidth)}${RESET}` : "";
      return `${sidebarFooter}${paneTone}${COMPOSER}${pad(truncate(inputText, mainWidth), mainWidth)}${RESET}${hudFooter}`;
    });
    const cursorColumn = sidebarWidth + Math.min(mainWidth, Array.from(inputRows.at(-1) ?? "").length + 1);
    const screen = [header, ...statusHeaders, ...body, ...composer].join("\r\n");
    const cursor = this.sidebarFocused ? `${ESC}?25l` : `${ESC}${this.height};${cursorColumn}H${ESC}?25h`;
    const frame = `${screen}${cursor}`;
    if (frame === this.lastFrame) return;
    this.lastFrame = frame;
    this.write(`${ESC}?25l${ESC}H${ESC}2J${frame}`);
  }

  private pageLinkRows(width: number, _limit: number): string[] {
    const links = [{ label: "main", url: this.room.pageUrl }];
    return links.map((link) => {
      const ref = compactUrl(link.url).replace(/^localhost:\d+\//, "");
      const description = link.label === "head" ? "working tip" : link.label;
      const label = truncate(`  ↗ ${ref}  —  ${description}`, width);
      const start = label.indexOf(ref);
      const rendered = start < 0 ? label : `${label.slice(0, start)}\x1b]8;;${link.url}\x1b\\${ESC}24m${label.slice(start, start + ref.length)}\x1b]8;;\x1b\\${label.slice(start + ref.length)}`;
      return rendered + " ".repeat(Math.max(0, width - Array.from(label).length));
    });
  }

  private topStatusRows(width: number, height: number): string[] {
    const active = this.agentIsActive();
    const spinner = active ? SPINNER[Math.floor(Date.now() / 100) % SPINNER.length] : "·";
    const sitePulse = Date.now() - this.room.lastRequestAt < 1_200 ? SPINNER[Math.floor(Date.now() / 100) % SPINNER.length] : "●";
    const averageLatency = this.room.serviceRequests ? this.room.serviceTotalLatencyMs / this.room.serviceRequests : 0;
    const healthTone = this.room.serviceErrors ? RED : GREEN;
    const agentTone = this.room.agentState.status === "error" ? RED : active ? MAGENTA : MUTED;
    const site = `  SITE   ${healthTone}${sitePulse}${STATUS} ${this.room.serviceErrors ? "errors" : "healthy"}   people ${this.room.members.size}   conn ${this.room.connectionCount}/${ROOM_LIMITS.connections}   req ${this.room.serviceRequests}   err ${this.room.serviceErrors}   ${averageLatency.toFixed(1)}ms`;
    const agent = `  AGENT  ${agentTone}${spinner}${STATUS} ${this.room.agentState.status}   ${this.room.agentState.detail}`;
    const identity = [site, agent];
    const metrics = [
      usageBar("DB", this.room.databaseBytes, ROOM_LIMITS.databaseBytes, formatBytes),
      usageBar("FILES", this.room.filesystemBytes, ROOM_LIMITS.filesystemBytes, formatBytes),
      usageBar("CONN", this.room.connectionCount, ROOM_LIMITS.connections, String),
      usageBar("BYTES/H", this.room.egressBytesLastHour, ROOM_LIMITS.egressBytesPerHour, formatBytes),
    ];
    if (height < 15) return [site, agent, `  ${metrics.map((metric) => metric.compact).join("  ")}`];
    const metricRows = width >= 50
      ? [`  ${metrics[0]!.full}  ${metrics[1]!.full}`, `  ${metrics[2]!.full}  ${metrics[3]!.full}`]
      : metrics.map((metric) => `  ${metric.full}`);
    return [...identity, ...metricRows];
  }

  private hudRow(index: number, width: number): string {
    if (!width) return "";
    const row = this.room.versionGraph[index];
    if (!row) return `${HUD}${" ".repeat(width)}${RESET}`;
    return `${HUD}${renderVersionRow(row.text, row.url, width)}${RESET}`;
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
    const plainPrefix = ` ${time} ${marker} ${message.author}  `;
    const nameTone = message.author === "room-agent" ? CYAN : message.author === this.room.owner ? OWNER : message.kind === "system" ? MUTED : CHAT;
    const styledName = `${ESC}1m${nameTone}${message.author}${ESC}22m${message.kind === "system" ? MUTED : CHAT}`;
    const styledPrefix = ` ${time} ${marker} ${styledName}  `;
    if (message.kind === "commit" && message.url) {
      const [hash, ...title] = message.text.split(" ");
      const suffix = `${title.join(" ")}${message.detail ? ` — ${message.detail}` : ""}`;
      const content = truncate(`${hash} ${suffix}`, Math.max(0, width - plainPrefix.length));
      const after = content.slice(hash.length);
      return [`${styledPrefix}${ESC}3m\x1b]8;;${message.url}\x1b\\${ESC}24m${hash}\x1b]8;;\x1b\\${after}${ESC}23m`];
    }
    const lines = wrap(plainPrefix + message.text.replace(/\s+/g, " "), width);
    if (lines[0]) lines[0] = lines[0].replace(message.author, styledName);
    return lines;
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    this.unsubscribeService();
    if (this.animationTimer) clearInterval(this.animationTimer);
    if (this.sidebarAnimationTimer) clearInterval(this.sidebarAnimationTimer);
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.room.leave(this.username);
    this.write("\x1b[?25h\x1b[?1049l");
  }

  private write(value: string): void {
    if (!this.stream.destroyed) this.stream.write(value);
  }

  private agentIsActive(): boolean {
    return this.room.agentState.status === "queued" || this.room.agentState.status === "thinking" || this.room.agentState.status === "working";
  }

  private syncAnimation(): void {
    const animating = this.agentIsActive() || Date.now() - this.room.lastRequestAt < 1_200;
    if (animating && !this.animationTimer) {
      this.animationTimer = setInterval(() => this.render(), 250);
    } else if (!animating && this.animationTimer) {
      clearInterval(this.animationTimer);
      this.animationTimer = undefined;
    }
  }

  private scheduleRender(): void {
    if (this.closed || this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.render();
    }, 25);
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

function usageBar(label: string, used: number, limit: number, format: (value: number) => string): { full: string; compact: string } {
  const ratio = Math.max(0, Math.min(1, used / limit));
  const filled = Math.round(ratio * 6);
  const tone = ratio >= 0.9 ? RED : ratio >= 0.7 ? YELLOW : GREEN;
  const bar = `${tone}${"█".repeat(filled)}${MUTED}${"░".repeat(6 - filled)}${STATUS}`;
  const percent = `${Math.round(ratio * 100)}%`;
  return {
    full: `${label} ${bar} ${format(used)}/${format(limit)}`,
    compact: `${label} ${bar} ${percent}`,
  };
}

function compactUrl(value: string): string {
  return value.replace(/^https?:\/\//, "")
    .replace(/\?__ref=([0-9a-f]{7})[^&]*/, "#$1")
    .replace("?__ref=head", "#head")
    .replace("?__ref=stable", "#stable")
    .replace(/\?__preview=([0-9a-f]{7})[^&]*/, "#$1");
}

function renderVersionRow(value: string, url: string | undefined, width: number): string {
  const match = value.match(/^(.*?[0-9a-f]{7,40})(?:\s{2,})(.*)$/);
  let rendered = `  ${value}`;
  if (match) {
    const tags = match[2]!.split(" · ");
    const colored = tags.map((tag) => {
      const tone = tag === "stable" ? GREEN : tag === "head" ? CYAN : tag.includes(" ") ? MAGENTA : YELLOW;
      return `${tone}${tag}${HUD}`;
    }).join(" · ");
    const commitMatch = match[1]!.match(/[0-9a-f]{7,40}/);
    if (commitMatch && url) {
      const start = commitMatch.index ?? 0;
      const before = match[1]!.slice(0, start);
      const after = match[1]!.slice(start + commitMatch[0].length);
      rendered = `  ${before}\x1b]8;;${url}\x1b\\${ESC}24m${commitMatch[0]}\x1b]8;;\x1b\\${after}  ${colored}`;
    } else rendered = `  ${match[1]}  ${colored}`;
  }
  const fitted = padAnsi(rendered, width);
  return fitted;
}

function truncate(value: string, width: number): string {
  return Array.from(value).slice(0, width).join("");
}

function pad(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - Array.from(value).length));
}

function padAnsi(value: string, width: number): string {
  const clipped = clipAnsi(value, width);
  return clipped + " ".repeat(Math.max(0, width - visibleLength(clipped)));
}

function visibleLength(value: string): number {
  return Array.from(value.replace(/\x1b\][^\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")).length;
}

function clipAnsi(value: string, width: number): string {
  if (visibleLength(value) <= width) return value;
  let output = "";
  let visible = 0;
  for (let index = 0; index < value.length && visible < width;) {
    if (value[index] === "\x1b" && value[index + 1] === "[") {
      const end = value.slice(index).search(/[A-Za-z]/);
      if (end < 0) break;
      output += value.slice(index, index + end + 1);
      index += end + 1;
    } else if (value[index] === "\x1b" && value[index + 1] === "]") {
      const bell = value.indexOf("\x07", index + 2);
      const stringTerminator = value.indexOf("\x1b\\", index + 2);
      const end = bell >= 0 && (stringTerminator < 0 || bell < stringTerminator) ? bell + 1 : stringTerminator >= 0 ? stringTerminator + 2 : value.length;
      output += value.slice(index, end);
      index = end;
    } else {
      const character = Array.from(value.slice(index))[0]!;
      output += character;
      index += character.length;
      visible++;
    }
  }
  return `${output}\x1b]8;;\x1b\\${RESET}`;
}

function wrap(value: string, width: number): string[] {
  const lines: string[] = [];
  let remaining = value;
  while (Array.from(remaining).length > width) {
    const candidate = Array.from(remaining).slice(0, width).join("");
    const breakAt = candidate.lastIndexOf(" ");
    const index = breakAt > 0 ? breakAt : candidate.length;
    lines.push(remaining.slice(0, index).trimEnd());
    remaining = remaining.slice(index).trimStart();
  }
  lines.push(remaining);
  return lines.length ? lines : [""];
}
