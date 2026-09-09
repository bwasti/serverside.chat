import type { AccountStore, AgentMode, ContributionPolicy, Principal, RoomRole, RoomVisibility } from "./auth";
import { ROOM_LIMITS, type Message, type Room } from "./room";
import type { RoomDirectory, RoomDirectoryEvent } from "./room-directory";

export interface TuiStream {
  readonly destroyed: boolean;
  write(value: string): boolean;
  end(value?: string): void;
  on(event: "data", listener: (data: Buffer) => void): unknown;
  on(event: "close" | "end", listener: () => void): unknown;
}

export type AnonymousLobbyReview = (principal: Principal, text: string) => Promise<{ allowed: boolean; reason?: string }>;

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
  private cursorOffset = 0;
  private preferredCursorColumn?: number;
  private closed = false;
  private unsubscribe: () => void;
  private unsubscribeService: () => void;
  private unsubscribeDirectory?: () => void;
  private lastWasCarriageReturn = false;
  private roomIndex = 0;
  private sidebarFocused = false;
  private createRoomFocused = false;
  private creatingRoom = false;
  private room: Room;
  private animationTimer?: ReturnType<typeof setInterval>;
  private sidebarAnimationTimer?: ReturnType<typeof setInterval>;
  private authenticationTimer?: ReturnType<typeof setInterval>;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private sidebarWidth = 3;
  private scrollOffset = 0;
  private lastFrame = "";
  private messageCacheRoom = "";
  private messageCacheWidth = 0;
  private readonly messageCache = new Map<number, string[]>();
  private principal: Principal;
  private readonly allRooms: Room[];
  private rooms: Room[];
  private localNotice = "";
  private anonymousSubmissionPending = false;
  private roomCreationAvailable = false;

  constructor(
    private readonly stream: TuiStream,
    rooms: Room[],
    principal: Principal | string,
    private readonly accounts?: AccountStore,
    initialRoom?: string,
    private readonly signInUrl?: string,
    refreshPrincipal?: () => Principal | undefined,
    authenticatedRoom?: string,
    private readonly directory?: RoomDirectory,
    private readonly reviewAnonymousLobby?: AnonymousLobbyReview,
  ) {
    this.principal = typeof principal === "string" ? { id: `local:${principal}`, kind: "user", handle: principal, displayName: principal, authenticated: true } : principal;
    this.allRooms = rooms;
    this.rooms = rooms.filter((room) => room.canView(this.principal));
    if (!this.rooms.length) throw new Error("principal cannot view any rooms");
    this.roomIndex = Math.max(0, this.rooms.findIndex((room) => room.name === initialRoom));
    this.room = this.rooms[this.roomIndex]!;
    if (!this.principal.authenticated && this.accounts) this.localNotice = this.reviewAnonymousLobby
      ? "anonymous · lobby messages are moderated · sign in to create rooms"
      : "anonymous · browse only · sign in to contribute";
    this.write("\x1b[?1049h\x1b[?25h");
    this.unsubscribe = this.room.subscribe(() => this.scheduleRender());
    this.unsubscribeService = this.room.subscribeService(() => this.scheduleRender());
    this.unsubscribeDirectory = directory?.subscribe((event) => this.refreshRooms(event));
    this.room.join(this.username);
    stream.on("data", (data: Buffer) => this.onData(data));
    stream.on("close", () => this.close());
    stream.on("end", () => this.close());
    if (!this.principal.authenticated && refreshPrincipal) this.authenticationTimer = setInterval(() => {
      const refreshed = refreshPrincipal();
      if (!refreshed?.authenticated) return;
      if (this.authenticationTimer) clearInterval(this.authenticationTimer);
      this.authenticationTimer = undefined;
      this.adoptPrincipal(refreshed, authenticatedRoom ?? this.room.name);
      this.localNotice = `signed in as @${this.username}`;
      this.render();
    }, 1_000);
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
    // Walk escape and text tokens in order so pasted text and navigation can share a packet.
    let dirty = false;
    let inputChanged = false;
    const tokens = data.toString("utf8").match(/\x1b(?:\[[0-?]*[ -/]*[@-~]|O[HF]|[^\x1b])|[^\x1b]+/gs) ?? [];
    for (const token of tokens) {
      if (token.startsWith("\x1b")) {
        const result = this.handleEscape(token);
        dirty = result.dirty || dirty;
        inputChanged = result.inputChanged || inputChanged;
        if (result.inputChanged) this.localNotice = "";
        continue;
      }
      for (const char of token) {
        if (char === "\x03" || (char === "\x04" && !this.input)) {
          this.stream.end();
          return;
        }
        if (char === "\t") {
          if (this.sidebarFocused) {
            this.sidebarFocused = false;
            if (this.createRoomFocused) this.beginRoomCreation();
            else this.createRoomFocused = false;
          } else {
            this.sidebarFocused = true;
            this.createRoomFocused = this.creatingRoom && this.roomCreationAvailable;
          }
          this.room.setTyping(this.username, false);
          this.animateSidebar();
          dirty = true;
          continue;
        }
        if (this.sidebarFocused && (char === "\r" || char === "\n")) {
          if (char === "\n" && this.lastWasCarriageReturn) {
            this.lastWasCarriageReturn = false;
            continue;
          }
          this.lastWasCarriageReturn = char === "\r";
          this.sidebarFocused = false;
          if (this.createRoomFocused) this.beginRoomCreation();
          this.animateSidebar();
          dirty = true;
          continue;
        }
        if (this.sidebarFocused) continue;
        if (this.anonymousSubmissionPending) continue;
        if (!this.canUseComposer()) continue;
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
        let changed = false;
        if (char === "\x7f" || char === "\b") changed = this.deleteBack();
        else if (char === "\x04") changed = this.deleteForward();
        else if (char === "\x01") dirty = this.moveCursorTo(0) || dirty;
        else if (char === "\x05") dirty = this.moveCursorTo(Array.from(this.input).length) || dirty;
        else if (char === "\x02") dirty = this.moveCursor(-1) || dirty;
        else if (char === "\x06") dirty = this.moveCursor(1) || dirty;
        else if (char === "\x17") changed = this.deleteWordBack();
        else if (char === "\x15") changed = this.deleteBeforeCursor();
        else if (char === "\x0b") changed = this.deleteAfterCursor();
        else if (!/[\x00-\x1f\x7f]/.test(char)) changed = this.insertAtCursor(char);
        if (changed) this.localNotice = "";
        inputChanged = changed || inputChanged;
        dirty = changed || dirty;
      }
    }
    if (inputChanged && !this.onCreateRoomScreen() && this.room.canContribute(this.principal)) this.room.setTyping(this.username, Boolean(this.input));
    if (dirty) this.render();
  }

  private handleEscape(sequence: string): { dirty: boolean; inputChanged: boolean } {
    const arrow = sequence.match(/^\x1b\[(?:(1;[2-8]))?([ABCD])$/);
    if (arrow) {
      const modifier = arrow[1];
      const direction = arrow[2]!;
      const wordMotion = (modifier === "1;3" || modifier === "1;5") && (direction === "C" || direction === "D");
      const dirty = wordMotion && !this.sidebarFocused ? this.moveWord(direction === "D" ? -1 : 1) : this.handleArrow(direction);
      return { dirty, inputChanged: false };
    }
    const page = sequence.match(/^\x1b\[([56])~$/);
    if (page && !this.sidebarFocused) { this.scrollChat(page[1] === "5" ? 8 : -8); return { dirty: true, inputChanged: false }; }
    if (/^\x1b(?:\[(?:H|1~|7~)|OH)$/.test(sequence) && !this.sidebarFocused) return { dirty: this.moveCursorTo(0), inputChanged: false };
    if (/^\x1b(?:\[(?:F|4~|8~)|OF)$/.test(sequence) && !this.sidebarFocused) return { dirty: this.moveCursorTo(Array.from(this.input).length), inputChanged: false };
    if (sequence === "\x1bb" && !this.sidebarFocused) return { dirty: this.moveWord(-1), inputChanged: false };
    if (sequence === "\x1bf" && !this.sidebarFocused) return { dirty: this.moveWord(1), inputChanged: false };
    if (sequence === "\x1b\x7f" || sequence === "\x1b\x08") {
      const changed = !this.sidebarFocused && this.deleteWordBack();
      return { dirty: changed, inputChanged: changed };
    }
    if (sequence === "\x1b[3~") {
      const changed = !this.sidebarFocused && this.deleteForward();
      return { dirty: changed, inputChanged: changed };
    }
    return { dirty: false, inputChanged: false };
  }

  private moveSidebar(offset: number): void {
    const hasCreate = this.roomCreationAvailable = this.computeRoomCreationAvailability();
    const total = this.rooms.length + (hasCreate ? 1 : 0);
    const current = this.createRoomFocused ? 0 : this.roomIndex + (hasCreate ? 1 : 0);
    const next = (current + offset + total) % total;
    if (hasCreate && next === 0) {
      this.createRoomFocused = true;
      this.creatingRoom = false;
      this.render();
      return;
    }
    this.createRoomFocused = false;
    this.creatingRoom = false;
    const nextRoom = next - (hasCreate ? 1 : 0);
    if (nextRoom === this.roomIndex) { this.render(); return; }
    this.unsubscribe();
    this.unsubscribeService();
    this.room.setTyping(this.username, false);
    this.room.leave(this.username);
    this.roomIndex = nextRoom;
    this.room = this.rooms[nextRoom]!;
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

  private handleArrow(direction: string): boolean {
    if (this.sidebarFocused) {
      if (direction === "A" || direction === "B") this.moveSidebar(direction === "A" ? -1 : 1);
      return direction === "A" || direction === "B";
    }
    if (direction === "C") return this.moveCursor(1);
    if (direction === "D") return this.moveCursor(-1);
    const moved = this.moveCursorVertical(direction === "A" ? -1 : 1);
    if (!moved) this.scrollChat(direction === "A" ? 1 : -1);
    return true;
  }

  private moveCursor(offset: number): boolean {
    return this.moveCursorTo(this.cursorOffset + offset);
  }

  private moveCursorTo(offset: number, preserveColumn = false): boolean {
    const next = Math.max(0, Math.min(Array.from(this.input).length, offset));
    if (next === this.cursorOffset) return false;
    this.cursorOffset = next;
    if (!preserveColumn) this.preferredCursorColumn = undefined;
    return true;
  }

  private moveCursorVertical(offset: number): boolean {
    const layout = layoutComposer(this.input, this.cursorOffset, this.mainWidth());
    const targetRow = layout.cursorRow + offset;
    if (targetRow < 0 || targetRow >= layout.rows.length) return false;
    const desiredColumn = this.preferredCursorColumn ?? layout.cursorColumn;
    const target = layout.rows[targetRow]!;
    this.preferredCursorColumn = desiredColumn;
    return this.moveCursorTo(Math.max(0, Math.min(target.end, target.start + desiredColumn) - 2), true);
  }

  private moveWord(direction: -1 | 1): boolean {
    const chars = Array.from(this.input);
    let next = this.cursorOffset;
    if (direction < 0) {
      while (next > 0 && /\s/.test(chars[next - 1]!)) next--;
      while (next > 0 && !/\s/.test(chars[next - 1]!)) next--;
    } else {
      while (next < chars.length && !/\s/.test(chars[next]!)) next++;
      while (next < chars.length && /\s/.test(chars[next]!)) next++;
    }
    return this.moveCursorTo(next);
  }

  private insertAtCursor(value: string): boolean {
    const chars = Array.from(this.input);
    if (chars.length >= 2_000) return false;
    const inserted = Array.from(value).slice(0, 2_000 - chars.length);
    if (!inserted.length) return false;
    chars.splice(this.cursorOffset, 0, ...inserted);
    this.input = chars.join("");
    this.cursorOffset += inserted.length;
    this.preferredCursorColumn = undefined;
    return true;
  }

  private deleteBack(): boolean {
    if (!this.cursorOffset) return false;
    const chars = Array.from(this.input);
    chars.splice(this.cursorOffset - 1, 1);
    this.input = chars.join("");
    this.cursorOffset--;
    this.preferredCursorColumn = undefined;
    return true;
  }

  private deleteForward(): boolean {
    const chars = Array.from(this.input);
    if (this.cursorOffset >= chars.length) return false;
    chars.splice(this.cursorOffset, 1);
    this.input = chars.join("");
    this.preferredCursorColumn = undefined;
    return true;
  }

  private deleteWordBack(): boolean {
    const end = this.cursorOffset;
    if (!end) return false;
    const chars = Array.from(this.input);
    let start = end;
    while (start > 0 && /\s/.test(chars[start - 1]!)) start--;
    while (start > 0 && !/\s/.test(chars[start - 1]!)) start--;
    chars.splice(start, end - start);
    this.input = chars.join("");
    this.cursorOffset = start;
    this.preferredCursorColumn = undefined;
    return true;
  }

  private deleteBeforeCursor(): boolean {
    if (!this.cursorOffset) return false;
    const chars = Array.from(this.input);
    chars.splice(0, this.cursorOffset);
    this.input = chars.join("");
    this.cursorOffset = 0;
    this.preferredCursorColumn = undefined;
    return true;
  }

  private deleteAfterCursor(): boolean {
    const chars = Array.from(this.input);
    if (this.cursorOffset >= chars.length) return false;
    this.input = chars.slice(0, this.cursorOffset).join("");
    this.preferredCursorColumn = undefined;
    return true;
  }

  private mainWidth(): number {
    const sidebarWidth = Math.round(this.sidebarWidth);
    const hudWidth = this.currentHudWidth();
    return this.width - sidebarWidth - hudWidth;
  }

  private currentHudWidth(): number {
    if (this.room.name === "lobby" || this.onCreateRoomScreen()) return 0;
    return this.width >= 105 ? Math.min(50, Math.max(36, Math.floor(this.width * 0.32))) : 0;
  }

  private submit(): boolean {
    const line = this.input;
    this.input = "";
    this.cursorOffset = 0;
    this.preferredCursorColumn = undefined;
    this.room.setTyping(this.username, false);
    this.scrollOffset = 0;
    if (line === "/quit") {
      this.stream.end();
      return true;
    }
    if (this.creatingRoom) {
      try {
        if (!this.directory) throw new Error("room management is unavailable");
        if (!line.trim()) throw new Error("room name is required");
        const created = this.directory.createRoom(this.principal, line.trim());
        this.creatingRoom = false;
        this.createRoomFocused = false;
        this.selectRoom(created);
        this.localNotice = `created #${created.name}`;
      } catch (error) {
        this.localNotice = error instanceof Error ? error.message : "room creation failed";
      }
      return false;
    }
    if (this.handleHostCommand(line)) return false;
    if (this.canSubmitAnonymousLobby()) {
      if (line) void this.submitAnonymousLobby(line === "/help" ? "help" : line);
      return false;
    }
    const accepted = line === "/help"
      ? this.room.agent(this.principal, "")
      : line.startsWith("/agent")
        ? this.room.agent(this.principal, line.slice(6))
        : this.room.chat(this.principal, line);
    if (!accepted && line) this.localNotice = "room policy does not allow that action";
    return false;
  }

  private async submitAnonymousLobby(text: string): Promise<void> {
    if (!this.reviewAnonymousLobby || this.anonymousSubmissionPending) return;
    const lobby = this.room;
    this.anonymousSubmissionPending = true;
    this.localNotice = "checking message…";
    this.render();
    try {
      const decision = await this.reviewAnonymousLobby(this.principal, text);
      if (this.closed) return;
      if (decision.allowed && lobby.acceptModeratedAnonymousChat(this.principal, text)) this.localNotice = "";
      else this.localNotice = decision.reason ?? "message was not posted";
    } catch {
      if (!this.closed) this.localNotice = "lobby moderation is unavailable · try again later";
    } finally {
      this.anonymousSubmissionPending = false;
      if (!this.closed) this.render();
    }
  }

  private handleHostCommand(line: string): boolean {
    if (!this.accounts) return false;
    const [command, field, value, ...extra] = line.trim().split(/\s+/);
    if (command !== "/permissions" && command !== "/invite" && command !== "/redeem" && command !== "/room" && command !== "/account") return false;
    try {
      if (command === "/account") {
        if (field) throw new Error("usage: /account");
        const profile = this.accounts.accountProfile(this.principal);
        this.localNotice = `@${this.username} · site ${profile.siteRole} · ${profile.plan} · rooms ${profile.ownedRooms}/${profile.roomLimit}`;
        return true;
      }
      if (command === "/room") {
        if (!this.directory) throw new Error("room management is unavailable");
        if (extra.length || !value || (field !== "create" && field !== "rename" && field !== "delete")) throw new Error("usage: /room create|rename|delete <name>");
        if (field === "create") {
          const created = this.directory.createRoom(this.principal, value);
          this.selectRoom(created);
          this.localNotice = `created #${created.name}`;
        } else if (field === "rename") {
          const previous = this.room.name;
          const renamed = this.directory.renameRoom(this.principal, previous, value);
          this.selectRoom(renamed);
          this.localNotice = `renamed #${previous} to #${renamed.name}`;
        } else {
          if (value !== this.room.name) throw new Error(`switch to #${value} before deleting it`);
          this.directory.deleteRoom(this.principal, value);
          this.localNotice = `deleted #${value} · data retained in server trash`;
        }
        return true;
      }
      if (command === "/redeem") {
        if (!field || value) throw new Error("usage: /redeem <invite>");
        const redeemed = this.accounts.redeem(this.principal, field);
        this.adoptPrincipal(redeemed.principal, redeemed.roomName);
        this.localNotice = `signed in as ${this.username} · ${redeemed.role} in #${redeemed.roomName}`;
        return true;
      }
      if (command === "/invite") {
        const role = field as Exclude<RoomRole, "owner">;
        if (role !== "admin" && role !== "contributor" && role !== "viewer") throw new Error("usage: /invite admin|contributor|viewer");
        const token = this.room.createInvite(this.principal, role);
        this.localNotice = `invite ${token} · ${role} · expires in 24h`;
        return true;
      }
      if (!field) {
        const policy = this.room.policy;
        this.localNotice = `${policy.visibility} · ${policy.contributions} contribute · ${policy.agentMode} agent`;
        return true;
      }
      if (!value) throw new Error("usage: /permissions visibility|contributions|agent value");
      if (field === "visibility" && (value === "public" || value === "private")) this.room.updatePolicy(this.principal, { visibility: value as RoomVisibility });
      else if (field === "contributions" && (value === "members" || value === "admins" || value === "disabled")) this.room.updatePolicy(this.principal, { contributions: value as ContributionPolicy });
      else if (field === "agent" && (value === "passive" || value === "explicit" || value === "disabled")) this.room.updatePolicy(this.principal, { agentMode: value as AgentMode });
      else throw new Error("invalid permission setting");
      const policy = this.room.policy;
      this.localNotice = `${policy.visibility} · ${policy.contributions} contribute · ${policy.agentMode} agent`;
    } catch (error) {
      this.localNotice = error instanceof Error ? error.message : "permission command failed";
    }
    return true;
  }

  private render(): void {
    if (this.closed) return;
    if (!this.room.canView(this.principal)) {
      this.stream.end("Room access changed. Reconnect after receiving an invitation.\r\n");
      return;
    }
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }
    this.syncAnimation();
    this.roomCreationAvailable = this.computeRoomCreationAvailability();
    if (!this.roomCreationAvailable && this.onCreateRoomScreen()) {
      this.createRoomFocused = false;
      this.creatingRoom = false;
    }
    const createRoomScreen = this.onCreateRoomScreen();
    const sidebarWidth = Math.round(this.sidebarWidth);
    const hudWidth = this.currentHudWidth();
    const mainWidth = this.mainWidth();
    const pageLinks = this.pageLinkRows(mainWidth, Math.max(1, Math.min(5, this.height - 8)));
    const topStatus = this.topStatusRows(mainWidth, this.height);
    const topRows = [...pageLinks, ...topStatus];
    const writable = this.canUseComposer();
    const readOnlyText = this.principal.authenticated
      ? this.room.policy.contributions === "disabled"
        ? "read only · contributions are disabled"
        : this.room.policy.contributions === "admins"
          ? "read only · admins can contribute"
          : `read only · ask @${this.room.owner} for an invite`
      : "read only · sign in to contribute";
    const composerValue = createRoomScreen
      ? this.creatingRoom ? this.input : ""
      : writable ? this.input : readOnlyText;
    const inputLayout = layoutComposer(composerValue, this.creatingRoom || (!createRoomScreen && writable) ? this.cursorOffset : 0, mainWidth);
    const maximumComposerRows = Math.max(1, Math.min(5, this.height - topRows.length - 4));
    let firstInputRow = Math.max(0, inputLayout.rows.length - maximumComposerRows);
    if (inputLayout.cursorRow < firstInputRow) firstInputRow = inputLayout.cursorRow;
    if (inputLayout.cursorRow >= firstInputRow + maximumComposerRows) firstInputRow = inputLayout.cursorRow - maximumComposerRows + 1;
    const inputRows = inputLayout.rows.slice(firstInputRow, firstInputRow + maximumComposerRows).map((row) => row.text);
    const bottomStatus = this.localNotice
      ? truncate(`  ${this.localNotice}`, mainWidth)
      : createRoomScreen ? "" : this.typingStatus(mainWidth);
    const messageRows = Math.max(3, this.height - 1 - topRows.length - inputRows.length - (bottomStatus ? 1 : 0));
    const messageCacheRoom = createRoomScreen ? "__new-room__" : this.room.name;
    if (this.messageCacheRoom !== messageCacheRoom || this.messageCacheWidth !== mainWidth) {
      this.messageCacheRoom = messageCacheRoom;
      this.messageCacheWidth = mainWidth;
      this.messageCache.clear();
    }
    const roomMessages = createRoomScreen ? [] : this.room.messages;
    const messages = roomMessages.flatMap((message) => {
      let rows = this.messageCache.get(message.id);
      if (!rows) {
        rows = this.formatMessage(message, mainWidth);
        this.messageCache.set(message.id, rows);
      }
      return rows.map((text) => ({ text, kind: message.kind }));
    });
    if (this.messageCache.size > roomMessages.length) {
      const retained = new Set(roomMessages.map((message) => message.id));
      for (const id of this.messageCache.keys()) if (!retained.has(id)) this.messageCache.delete(id);
    }
    const maximumOffset = Math.max(0, messages.length - messageRows);
    this.scrollOffset = Math.min(this.scrollOffset, maximumOffset);
    const end = messages.length - this.scrollOffset;
    const visible = messages.slice(Math.max(0, end - messageRows), end);
    while (visible.length < messageRows) visible.unshift({ text: "", kind: "chat" });

    const title = createRoomScreen ? "  + new room" : `  # ${this.room.name}  ${this.room.policy.visibility === "private" ? "private" : "public"}`;
    const status = createRoomScreen ? "name your room  " : `${this.scrollOffset ? `↑${this.scrollOffset}  ` : ""}${this.room.members.size} online  `;
    const headerGap = " ".repeat(Math.max(1, mainWidth - title.length - status.length));
    const sidebarHeader = sidebarWidth <= 3
      ? `${SIDEBAR_MUTED}${pad(" › ", sidebarWidth)}${RESET}`
      : `${SIDEBAR}${pad(truncate("  serverside.chat", sidebarWidth), sidebarWidth)}${RESET}`;
    const paneTone = this.sidebarFocused ? DIM : "";
    const hudHeader = hudWidth ? this.dimInactiveHud(`${HUD_MUTED}${pad("  VERSION CONTROL", hudWidth)}${RESET}`) : "";
    const header = `${sidebarHeader}${paneTone}${HEADER}${title}${headerGap}${status}${RESET}${hudHeader}`;
    const statusHeaders = topRows.map((line, index) => `${this.sidebarRow(index, sidebarWidth)}${paneTone}${STATUS}${padAnsi(line, mainWidth)}${RESET}${this.hudRow(index, hudWidth)}`);
    const body = visible.map(({ text, kind }, index) => {
      const color = kind === "system" ? MUTED : CHAT;
      const columnRow = index + topRows.length;
      const rendered = padAnsi(text, mainWidth);
      const renderedText = this.sidebarFocused ? rendered.replaceAll(`${ESC}22m`, `${ESC}22m${DIM}`) : rendered;
      return `${this.sidebarRow(columnRow, sidebarWidth)}${paneTone}${color}${renderedText}${RESET}${this.hudRow(columnRow, hudWidth)}`;
    });
    const typing = bottomStatus
      ? (() => {
          const padded = pad(bottomStatus, mainWidth);
          const rendered = !this.principal.authenticated && this.signInUrl ? linkText(padded, "sign in", this.signInUrl, CYAN, `${ESC}3m${MUTED}`) : padded;
          return [`${this.sidebarRow(topRows.length + visible.length, sidebarWidth)}${paneTone}${CHAT}${ESC}3m${MUTED}${rendered}${ESC}23m${RESET}${this.hudRow(topRows.length + visible.length, hudWidth)}`];
        })()
      : [];
    const composer = inputRows.map((inputText, index) => {
      const last = index === inputRows.length - 1;
      const sidebarFooter = last
        ? sidebarWidth <= 3 ? `${SIDEBAR}${pad(" @ ", sidebarWidth)}${RESET}` : `${SIDEBAR}${pad(truncate(`  @${this.username}`, sidebarWidth), sidebarWidth)}${RESET}`
        : `${SIDEBAR}${" ".repeat(sidebarWidth)}${RESET}`;
      const columnRow = topRows.length + visible.length + typing.length + index;
      const padded = pad(truncate(inputText, mainWidth), mainWidth);
      const renderedInput = !writable && !this.principal.authenticated && this.signInUrl ? linkText(padded, "sign in", this.signInUrl, CYAN, COMPOSER) : padded;
      return `${sidebarFooter}${paneTone}${COMPOSER}${renderedInput}${RESET}${this.hudRow(columnRow, hudWidth)}`;
    });
    const cursorColumn = sidebarWidth + Math.min(mainWidth, inputLayout.cursorColumn + 1);
    const cursorRow = this.height - inputRows.length + 1 + inputLayout.cursorRow - firstInputRow;
    const screen = [header, ...statusHeaders, ...body, ...typing, ...composer].join("\r\n");
    const cursor = this.sidebarFocused || !writable ? `${ESC}?25l` : `${ESC}${cursorRow};${cursorColumn}H${ESC}?25h`;
    const frame = `${screen}${cursor}`;
    if (frame === this.lastFrame) return;
    this.lastFrame = frame;
    this.write(`${ESC}?25l${ESC}H${ESC}2J${frame}`);
  }

  private pageLinkRows(width: number, _limit: number): string[] {
    if (this.room.name === "lobby" || this.onCreateRoomScreen()) return [];
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
    if (this.onCreateRoomScreen()) {
      const title = truncate("  Create a new room", width);
      const name = truncate("  Choose a short URL name using letters, numbers, or dashes.", width);
      const keys = truncate("  ENTER create   TAB rooms", width);
      return height < 12 ? [title, name] : [title, name, keys];
    }
    if (this.room.name === "lobby") {
      const intro = truncate("  serverside.chat  —  shared rooms where people and AI build live websites", width);
      const keys = truncate("  TAB other pages   ↑↓ choose   ENTER open", width);
      const guide = truncate("  Ask the guide how to use rooms, agents, invites, previews, or publishing.", width);
      return height < 12 ? [intro, keys] : [intro, keys, guide];
    }
    const active = this.agentIsActive();
    const spinner = active ? SPINNER[Math.floor(Date.now() / 100) % SPINNER.length] : "·";
    const sitePulse = Date.now() - this.room.lastRequestAt < 1_200 ? SPINNER[Math.floor(Date.now() / 100) % SPINNER.length] : "●";
    const averageLatency = this.room.serviceRequests ? this.room.serviceTotalLatencyMs / this.room.serviceRequests : 0;
    const healthTone = this.room.serviceErrors ? RED : GREEN;
    const agentDisabled = this.room.policy.agentMode === "disabled";
    const agentTone = agentDisabled ? MUTED : this.room.agentState.status === "error" ? RED : active ? MAGENTA : MUTED;
    const site = `  SITE   ${healthTone}${sitePulse}${STATUS} ${this.room.serviceErrors ? "errors" : "healthy"}   people ${this.room.members.size}   conn ${this.room.connectionCount}/${ROOM_LIMITS.connections}   req ${this.room.serviceRequests}   err ${this.room.serviceErrors}   ${averageLatency.toFixed(1)}ms`;
    const agentMode = this.room.policy.agentMode === "passive" ? "passive" : this.room.policy.agentMode === "explicit" ? "/agent only" : "room policy";
    const agent = `  AGENT  ${agentTone}${agentDisabled ? "·" : spinner}${STATUS} ${agentDisabled ? "disabled" : this.room.agentState.status}   ${agentDisabled ? agentMode : `${this.room.agentState.detail} · ${agentMode}`}`;
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
    const logStart = Math.max(2, Math.floor((this.height - 1) * 2 / 3));
    let rendered: string;
    if (index >= logStart) {
      if (index === logStart) {
        const live = Date.now() - this.room.lastRequestAt < 1_200;
        const pulse = live ? SPINNER[Math.floor(Date.now() / 100) % SPINNER.length] : "·";
        rendered = `${HUD_MUTED}${padAnsi(`  LIVE LOGS  ${live ? GREEN : MUTED}${pulse}${HUD_MUTED}`, width)}${RESET}`;
        return this.dimInactiveHud(rendered);
      }
      const capacity = Math.max(0, this.height - 1 - logStart - 1);
      const logs = this.room.serviceLogs.slice(-capacity);
      const slot = index - logStart - 1;
      const log = logs[slot - (capacity - logs.length)];
      rendered = `${HUD}${padAnsi(log ? renderServiceLog(log) : "", width)}${RESET}`;
      return this.dimInactiveHud(rendered);
    }
    const row = this.room.versionGraph[index];
    rendered = row ? `${HUD}${renderVersionRow(row.text, row.url, width)}${RESET}` : `${HUD}${" ".repeat(width)}${RESET}`;
    return this.dimInactiveHud(rendered);
  }

  private dimInactiveHud(value: string): string {
    if (!this.sidebarFocused) return value;
    return `${DIM}${value.replaceAll(RESET, `${RESET}${DIM}`)}${RESET}`;
  }

  private sidebarRow(index: number, width: number): string {
    if (width <= 3) {
      const roomIndex = index - 1;
      const roomActive = !this.onCreateRoomScreen() && roomIndex === this.roomIndex;
      const marker = roomActive ? " ● " : roomIndex >= 0 && roomIndex < this.rooms.length ? " · " : "   ";
      return `${roomActive ? SIDEBAR_ACTIVE : SIDEBAR}${pad(marker, width)}${RESET}`;
    }
    if (index === 0) return `${SIDEBAR_MUTED}${pad(truncate(this.sidebarFocused ? "  ROOMS  ↑↓" : "  ROOMS", width), width)}${RESET}`;
    const hasCreate = this.roomCreationAvailable;
    if (hasCreate && index === 1) {
      const style = this.createRoomFocused ? SIDEBAR_ACTIVE : SIDEBAR;
      return `${style}${pad(truncate("  + new room", width), width)}${RESET}`;
    }
    const roomIndex = index - 1 - (hasCreate ? 1 : 0);
    if (roomIndex < this.rooms.length) {
      const style = !this.onCreateRoomScreen() && roomIndex === this.roomIndex ? SIDEBAR_ACTIVE : SIDEBAR;
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

  private typingStatus(width: number): string {
    const names = this.room.typingMembers.filter((name) => name !== this.username);
    if (!names.length) return "";
    const subject = names.length === 1
      ? names[0]!
      : names.length === 2
        ? `${names[0]} and ${names[1]}`
        : `${names[0]}, ${names[1]} +${names.length - 2}`;
    return truncate(`  ${subject} ${names.length === 1 ? "is" : "are"} typing…`, width);
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    this.unsubscribeService();
    this.unsubscribeDirectory?.();
    if (this.animationTimer) clearInterval(this.animationTimer);
    if (this.sidebarAnimationTimer) clearInterval(this.sidebarAnimationTimer);
    if (this.authenticationTimer) clearInterval(this.authenticationTimer);
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.room.setTyping(this.username, false);
    this.room.leave(this.username);
    this.write("\x1b[?25h\x1b[?1049l");
  }

  private write(value: string): void {
    if (!this.stream.destroyed) this.stream.write(value);
  }

  private get username(): string { return this.principal.handle; }

  private canUseComposer(): boolean {
    return this.creatingRoom
      || this.room.canContribute(this.principal)
      || this.canSubmitAnonymousLobby()
      || Boolean(this.accounts?.isAdmin(this.principal, this.room.name));
  }

  private canSubmitAnonymousLobby(): boolean {
    return Boolean(this.reviewAnonymousLobby && this.room.name === "lobby" && this.room.policy.system && !this.principal.authenticated && this.principal.kind === "anonymous");
  }

  private computeRoomCreationAvailability(): boolean {
    if (!this.accounts || !this.directory || !this.principal.authenticated || this.principal.kind !== "user") return false;
    const profile = this.accounts.accountProfile(this.principal);
    return profile.ownedRooms < profile.roomLimit;
  }

  private onCreateRoomScreen(): boolean {
    return this.createRoomFocused || this.creatingRoom;
  }

  private beginRoomCreation(): void {
    const alreadyCreating = this.creatingRoom;
    this.createRoomFocused = false;
    this.creatingRoom = true;
    if (!alreadyCreating) {
      this.input = "";
      this.cursorOffset = 0;
      this.preferredCursorColumn = undefined;
    }
    this.localNotice = "type a room name, then press Enter";
    this.messageCacheRoom = "";
    this.messageCache.clear();
  }

  private adoptPrincipal(principal: Principal, preferredRoom: string): void {
    const oldUsername = this.username;
    this.unsubscribe();
    this.unsubscribeService();
    this.room.setTyping(oldUsername, false);
    this.room.leave(oldUsername);
    this.principal = principal;
    this.createRoomFocused = false;
    this.creatingRoom = false;
    this.rooms = this.allRooms.filter((room) => room.canView(principal));
    if (!this.rooms.length) throw new Error("account cannot view any rooms");
    this.roomIndex = Math.max(0, this.rooms.findIndex((room) => room.name === preferredRoom));
    this.room = this.rooms[this.roomIndex]!;
    this.scrollOffset = 0;
    this.messageCacheRoom = "";
    this.messageCache.clear();
    this.unsubscribe = this.room.subscribe(() => this.scheduleRender());
    this.unsubscribeService = this.room.subscribeService(() => this.scheduleRender());
    this.room.join(this.username);
  }

  private refreshRooms(event: RoomDirectoryEvent): void {
    if (this.closed) return;
    const preferred = event.kind === "rename" && event.previousName === this.room.name ? event.name : this.room.name;
    const visible = this.allRooms.filter((room) => room.canView(this.principal));
    if (!visible.length) {
      this.stream.end("No rooms are visible to this account.\r\n");
      return;
    }
    this.rooms = visible;
    this.roomCreationAvailable = this.computeRoomCreationAvailability();
    if (!this.roomCreationAvailable) {
      this.createRoomFocused = false;
      this.creatingRoom = false;
    }
    const next = visible.find((room) => room.name === preferred) ?? visible[0]!;
    if (next !== this.room) this.selectRoom(next);
    else {
      this.roomIndex = visible.indexOf(next);
      this.render();
    }
  }

  private selectRoom(room: Room): void {
    this.createRoomFocused = false;
    this.creatingRoom = false;
    if (room === this.room) return;
    this.unsubscribe();
    this.unsubscribeService();
    this.room.setTyping(this.username, false);
    this.room.leave(this.username);
    this.room = room;
    this.roomIndex = Math.max(0, this.rooms.findIndex((candidate) => candidate === room));
    this.scrollOffset = 0;
    this.messageCacheRoom = "";
    this.messageCache.clear();
    this.unsubscribe = room.subscribe(() => this.scheduleRender());
    this.unsubscribeService = room.subscribeService(() => this.scheduleRender());
    room.join(this.username);
    this.render();
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

function renderServiceLog(value: string): string {
  const safe = value.replace(/[\r\n]/g, " ");
  const request = safe.match(/^(\d{2}:\d{2}:\d{2}) (\d{3}) (.*)$/);
  if (request) {
    const status = Number(request[2]);
    const tone = status >= 500 ? RED : status >= 400 ? YELLOW : GREEN;
    return `  ${MUTED}${request[1]}${HUD} ${tone}${request[2]}${HUD} ${request[3]}`;
  }
  const timestamp = safe.match(/^(\d{2}:\d{2}:\d{2}) (.*)$/);
  return timestamp ? `  ${MUTED}${timestamp[1]}${HUD} ${timestamp[2]}` : `  ${safe}`;
}

export interface ComposerLayout {
  rows: Array<{ text: string; start: number; end: number }>;
  cursorRow: number;
  cursorColumn: number;
}

export function layoutComposer(input: string, cursorOffset: number, width: number): ComposerLayout {
  const lineWidth = Math.max(1, width);
  const inputChars = Array.from(input);
  const chars = [" ", " ", ...inputChars];
  const rows: ComposerLayout["rows"] = [];
  let start = 0;
  while (start < chars.length) {
    let end = start;
    let cells = 0;
    let breakAfter = -1;
    while (end < chars.length) {
      const characterWidth = terminalCharacterWidth(chars[end]!);
      if (cells + characterWidth > lineWidth) break;
      cells += characterWidth;
      if (end >= 2 && chars[end] === " ") breakAfter = end + 1;
      end++;
    }
    if (end < chars.length && breakAfter > start) end = breakAfter;
    if (end === start) end++;
    rows.push({ text: chars.slice(start, end).join(""), start, end });
    start = end;
  }
  if (!rows.length) rows.push({ text: "", start: 0, end: 0 });
  const absoluteCursor = 2 + Math.max(0, Math.min(inputChars.length, cursorOffset));
  if (absoluteCursor === chars.length && terminalWidth(rows.at(-1)!.text) === lineWidth) {
    rows.push({ text: "", start: chars.length, end: chars.length });
  }
  let cursorRow = rows.length - 1;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    if (absoluteCursor < row.end || (index === rows.length - 1 && absoluteCursor <= row.end)) {
      cursorRow = index;
      break;
    }
  }
  const row = rows[cursorRow]!;
  return { rows, cursorRow, cursorColumn: terminalWidth(chars.slice(row.start, absoluteCursor).join("")) };
}

function truncate(value: string, width: number): string {
  let output = "";
  let cells = 0;
  for (const character of value) {
    const characterWidth = terminalCharacterWidth(character);
    if (cells + characterWidth > width) break;
    output += character;
    cells += characterWidth;
  }
  return output;
}

function pad(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - terminalWidth(value)));
}

function linkText(value: string, label: string, url: string, tone: string, restoreTone: string): string {
  const start = value.indexOf(label);
  if (start < 0 || !/^https?:\/\//.test(url)) return value;
  return `${value.slice(0, start)}${tone}\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\${restoreTone}${value.slice(start + label.length)}`;
}

function padAnsi(value: string, width: number): string {
  const clipped = clipAnsi(value, width);
  return clipped + " ".repeat(Math.max(0, width - visibleLength(clipped)));
}

function visibleLength(value: string): number {
  return terminalWidth(value.replace(/\x1b\][^\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""));
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
      const characterWidth = terminalCharacterWidth(character);
      if (visible + characterWidth > width) break;
      output += character;
      index += character.length;
      visible += characterWidth;
    }
  }
  return `${output}\x1b]8;;\x1b\\${RESET}`;
}

function wrap(value: string, width: number): string[] {
  const lines: string[] = [];
  let remaining = Array.from(value);
  while (terminalWidth(remaining.join("")) > width) {
    let cells = 0;
    let end = 0;
    let breakAt = -1;
    while (end < remaining.length) {
      const characterWidth = terminalCharacterWidth(remaining[end]!);
      if (cells + characterWidth > width) break;
      cells += characterWidth;
      if (/\s/.test(remaining[end]!)) breakAt = end;
      end++;
    }
    const index = breakAt > 0 ? breakAt : Math.max(1, end);
    lines.push(remaining.slice(0, index).join("").trimEnd());
    remaining = Array.from(remaining.slice(index).join("").trimStart());
  }
  lines.push(remaining.join(""));
  return lines.length ? lines : [""];
}

function terminalWidth(value: string): number {
  let width = 0;
  for (const character of value) width += terminalCharacterWidth(character);
  return width;
}

function terminalCharacterWidth(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0;
  if (codePoint === 0 || codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0) || codePoint === 0x200d || /\p{Mark}/u.test(character)) return 0;
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329 || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0x303e)
    || (codePoint >= 0x3040 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1f64f)
    || (codePoint >= 0x1f900 && codePoint <= 0x1f9ff)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) ? 2 : 1;
}
