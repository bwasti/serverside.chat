import type { AccountStore, ClankerMode, ContributionPolicy, MountCredential, Principal, RoomRole, RoomVisibility } from "./auth";
import { ROOM_LIMITS, type Message, type MessageKind, type Room } from "./room";
import type { RoomDirectory, RoomDirectoryEvent } from "./room-directory";
import { parseArguments, RoomCapabilitySession } from "./room-shell";
import type { RoomEditor } from "./editor";
import { AdaptiveRateLimiter, RATE_LIMITS, retrySeconds } from "./rate-limit";

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
const HEADER = `${ESC}48;5;239m${ESC}38;5;116m`;
const STATUS = `${ESC}48;5;237m${ESC}38;5;188m`;
const COMPOSER = `${ESC}48;5;239m${ESC}38;5;188m`;
const COMMAND = `${ESC}48;5;236m${ESC}38;5;188m`;
const COMMAND_ACTIVE = `${ESC}48;5;239m${ESC}38;5;188m`;
const SIDEBAR = `${ESC}48;5;236m${ESC}38;5;188m`;
const SIDEBAR_MUTED = `${ESC}48;5;236m${ESC}38;5;102m`;
const SIDEBAR_ACTIVE = `${ESC}48;5;59m${ESC}38;5;188m`;
const HUD = `${ESC}48;5;237m${ESC}38;5;188m`;
const HUD_MUTED = `${ESC}48;5;237m${ESC}38;5;102m`;
const MUTED = `${ESC}38;5;102m`;
const CHAT = `${ESC}48;5;235m${ESC}38;5;188m`;
const CHAT_MUTED = `${ESC}48;5;235m${ESC}38;5;102m`;
const CHAT_SELECTED = `${ESC}48;5;59m${ESC}38;5;188m`;
const CHAT_STATUS = `${ESC}48;5;236m${ESC}38;5;102m`;
const OWNER = `${ESC}38;5;110m`;
const DIM = `${ESC}2m`;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const GREEN = `${ESC}38;5;108m`;
const YELLOW = `${ESC}38;5;223m`;
const RED = `${ESC}38;5;181m`;
const CYAN = `${ESC}38;5;116m`;
const MAGENTA = `${ESC}38;5;176m`;

export interface SlashCommand {
  name: string;
  usage: string;
  description: string;
  requiresArgument: boolean;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "/clanker", usage: "/clanker <request>", description: "ask the room clanker", requiresArgument: true },
  { name: "/invite", usage: "/invite [role]", description: "create a contributor invite link", requiresArgument: false },
  { name: "/mount", usage: "/mount [revoke]", description: "mount or revoke room files", requiresArgument: false },
  { name: "/shell", usage: "/shell", description: "show SSH access for the room shell", requiresArgument: false },
  { name: "/edit", usage: "/edit <path>", description: "edit a room file", requiresArgument: true },
  { name: "/permissions", usage: "/permissions [field value]", description: "inspect or change room policy", requiresArgument: false },
  { name: "/room", usage: "/room <action> <name>", description: "create, rename, archive, or restore a room", requiresArgument: true },
  { name: "/redeem", usage: "/redeem <invite>", description: "redeem a room invitation", requiresArgument: true },
  { name: "/account", usage: "/account", description: "show account and room limits", requiresArgument: false },
  { name: "/help", usage: "/help", description: "ask the room guide for help", requiresArgument: false },
  { name: "/quit", usage: "/quit", description: "close this chat session", requiresArgument: false },
];

export function slashCommandMatches(input: string): readonly SlashCommand[] {
  const prefix = input.toLowerCase();
  if (!prefix.startsWith("/") || /\s/.test(prefix)) return [];
  return SLASH_COMMANDS.filter((command) => command.name.startsWith(prefix));
}

export class TuiSession {
  private width = 80;
  private height = 24;
  private input = "";
  private cursorOffset = 0;
  private preferredCursorColumn?: number;
  private commandSelection = 0;
  private commandPrefix = "";
  private closed = false;
  private unsubscribe: () => void;
  private unsubscribeService: () => void;
  private unsubscribeDirectory?: () => void;
  private lastWasCarriageReturn = false;
  private roomIndex = 0;
  private sidebarFocused = false;
  private accountFocused = false;
  private accountPanel?: { field: number; editing: boolean; linkUrl?: string };
  private roomSettings?: { field: number; visibility: RoomVisibility; contributions: ContributionPolicy; clankerMode: ClankerMode };
  private createRoomFocused = false;
  private creatingRoom = false;
  private createRoomField = 0;
  private createRoomVisibility: RoomVisibility = "public";
  private createRoomContributions: ContributionPolicy = "members";
  private createRoomClankerMode: ClankerMode = "passive";
  private deletingRoomName?: string;
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
  private readonly messageCache = new Map<number, { showAuthor: boolean; rows: string[] }>();
  private principal: Principal;
  private readonly allRooms: Room[];
  private rooms: Room[];
  private localNotice = "";
  private anonymousSubmissionPending = false;
  private roomCreationAvailable = false;
  private editor?: RoomEditor;
  private mountPanel?: { credential: MountCredential; scroll: number };
  private shellPanel = false;
  private selectedMessageId?: number;
  private replyToMessageId?: number;
  private deleteConfirmationId?: number;

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
    private readonly rateLimiter?: AdaptiveRateLimiter,
    private readonly mouseTracking = true,
  ) {
    this.principal = typeof principal === "string" ? { id: `local:${principal}`, kind: "user", handle: principal, displayName: principal, authenticated: true } : principal;
    this.allRooms = rooms;
    this.rooms = this.orderedVisibleRooms(this.principal);
    if (!this.rooms.length) throw new Error("principal cannot view any rooms");
    this.roomIndex = Math.max(0, this.rooms.findIndex((room) => room.name === initialRoom));
    this.room = this.rooms[this.roomIndex]!;
    if (!this.principal.authenticated && this.accounts) this.localNotice = this.reviewAnonymousLobby
      ? "anonymous · lobby messages are moderated · sign in to create rooms"
      : "anonymous · browse only · sign in to contribute";
    this.write(`\x1b[?1049h${this.mouseTracking ? "\x1b[?1000h\x1b[?1006h" : ""}\x1b[?25h`);
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
    if (this.rateLimiter) {
      const policy = this.principal.authenticated ? RATE_LIMITS.authenticatedSocket : RATE_LIMITS.anonymousSocket;
      const decision = this.rateLimiter.consume(
        `tui-input:${this.principal.id}`,
        policy,
        Math.max(1, Math.ceil(data.byteLength / 1_024)),
      );
      if (!decision.allowed) {
        this.localNotice = `input rate limited · retry in ${retrySeconds(decision)}s`;
        this.render();
        return;
      }
    }
    if (this.accountPanel) {
      this.handleAccountPanelData(data);
      return;
    }
    if (this.roomSettings) {
      this.handleRoomSettingsData(data);
      return;
    }
    if (this.mountPanel) {
      this.handleMountPanelData(data);
      return;
    }
    if (this.shellPanel) {
      this.handleShellPanelData(data);
      return;
    }
    if (this.editor) {
      const action = this.editor.handleData(data);
      if (action.closed) {
        this.editor = undefined;
        this.localNotice = action.notice ?? "closed editor";
      }
      this.render();
      return;
    }
    if (this.deleteConfirmationId !== undefined) {
      this.handleDeleteConfirmationData(data);
      return;
    }
    // SSH is a byte stream: a packet may contain one key, many keys, or pasted lines.
    // Walk escape and text tokens in order so pasted text and navigation can share a packet.
    let dirty = false;
    let inputChanged = false;
    const tokens = data.toString("utf8").match(/\x1b(?:\[[0-?]*[ -/]*[@-~]|O[HF]|[^\x1b])?|[^\x1b]+/gs) ?? [];
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
        if (char === "\x0e" && !this.deletingRoomName && !this.onCreateRoomScreen()) {
          this.openRoomCreationShortcut();
          dirty = true;
          continue;
        }
        if (char === "\t" && this.deletingRoomName) {
          this.deletingRoomName = undefined;
          this.input = "";
          this.cursorOffset = 0;
          this.localNotice = "";
          this.sidebarFocused = true;
          this.animateSidebar();
          dirty = true;
          continue;
        }
        if (char === "\t") {
          if (this.sidebarFocused) {
            this.sidebarFocused = false;
            if (this.createRoomFocused) this.beginRoomCreation();
            else if (this.accountFocused) this.beginAccountPanel();
            else this.createRoomFocused = false;
          } else {
            this.sidebarFocused = true;
            this.createRoomFocused = this.creatingRoom && this.roomCreationAvailable;
            this.accountFocused = false;
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
          else if (this.accountFocused) this.beginAccountPanel();
          this.animateSidebar();
          dirty = true;
          continue;
        }
        if (this.sidebarFocused && (char === "\x7f" || char === "\b")) {
          this.beginRoomDeletion();
          dirty = true;
          continue;
        }
        if (this.sidebarFocused) continue;
        if (this.selectedMessageId !== undefined && (char === "\r" || char === "\n")) {
          if (char === "\n" && this.lastWasCarriageReturn) {
            this.lastWasCarriageReturn = false;
            continue;
          }
          this.lastWasCarriageReturn = char === "\r";
          if (this.canUseComposer()) {
            this.replyToMessageId = this.selectedMessageId;
            this.selectedMessageId = undefined;
            this.localNotice = "";
          } else this.localNotice = "room policy does not allow replies";
          dirty = true;
          continue;
        }
        if (this.selectedMessageId !== undefined && (char === "\x7f" || char === "\b")) {
          this.beginMessageDeletion();
          dirty = true;
          continue;
        }
        if (this.selectedMessageId !== undefined && (char === "p" || char === "P")) {
          this.toggleSelectedPin();
          dirty = true;
          continue;
        }
        if (this.anonymousSubmissionPending) continue;
        if (!this.canUseComposer() && !this.deletingRoomName) continue;
        if (this.creatingRoom && this.createRoomField !== 0) {
          if (char === "\r" || char === "\n") {
            if (char === "\n" && this.lastWasCarriageReturn) {
              this.lastWasCarriageReturn = false;
              continue;
            }
            this.lastWasCarriageReturn = char === "\r";
            if (this.submit()) return;
            dirty = true;
          }
          continue;
        }
        if (char === "\r" || char === "\n") {
          if (char === "\n" && this.lastWasCarriageReturn) {
            this.lastWasCarriageReturn = false;
            continue;
          }
          this.lastWasCarriageReturn = char === "\r";
          if (this.completeSelectedCommand()) {
            dirty = true;
            inputChanged = true;
            continue;
          }
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
        else if (!/[\x00-\x1f\x7f]/.test(char)) {
          this.selectedMessageId = undefined;
          changed = this.insertAtCursor(char);
        }
        if (changed) this.localNotice = "";
        inputChanged = changed || inputChanged;
        dirty = changed || dirty;
      }
    }
    if (inputChanged && !this.onCreateRoomScreen() && !this.deletingRoomName && this.room.canContribute(this.principal)) this.room.setTyping(this.username, Boolean(this.input));
    if (dirty) this.render();
  }

  private handleEscape(sequence: string): { dirty: boolean; inputChanged: boolean } {
    if (sequence === "\x1b") {
      if (this.selectedMessageId !== undefined || this.replyToMessageId !== undefined) {
        this.selectedMessageId = undefined;
        this.replyToMessageId = undefined;
        this.scrollOffset = 0;
        this.localNotice = "";
        return { dirty: true, inputChanged: false };
      }
      this.sidebarFocused = !this.sidebarFocused;
      this.createRoomFocused = false;
      this.accountFocused = false;
      this.room.setTyping(this.username, false);
      this.animateSidebar();
      return { dirty: true, inputChanged: false };
    }
    const mouse = sequence.match(/^\x1b\[<(\d+);\d+;\d+[Mm]$/);
    if (mouse) {
      const button = Number(mouse[1]);
      if (button === 64 || button === 65) {
        this.scrollChat(button === 64 ? 3 : -3);
        return { dirty: true, inputChanged: false };
      }
      return { dirty: false, inputChanged: false };
    }
    const arrow = sequence.match(/^\x1b\[(?:(1;[2-8]))?([ABCD])$/);
    if (arrow) {
      const modifier = arrow[1];
      const direction = arrow[2]!;
      if (modifier === "1;2" && this.sidebarFocused && (direction === "A" || direction === "B")) return { dirty: this.reorderSidebarRoom(direction === "A" ? -1 : 1), inputChanged: false };
      const wordMotion = (modifier === "1;3" || modifier === "1;5") && (direction === "C" || direction === "D");
      const dirty = wordMotion && !this.sidebarFocused ? this.moveWord(direction === "D" ? -1 : 1) : this.handleArrow(direction);
      return { dirty, inputChanged: false };
    }
    if (this.sidebarFocused && (sequence === "\x1b[13;2u" || sequence === "\x1b[27;2;13~" || sequence === "\x1b\r")) {
      this.beginRoomSettings();
      return { dirty: true, inputChanged: false };
    }
    const page = sequence.match(/^\x1b\[([56])~$/);
    if (page && !this.sidebarFocused) { this.scrollChat(page[1] === "5" ? 8 : -8); return { dirty: true, inputChanged: false }; }
    if (sequence === "\x1b[3~" && this.sidebarFocused) {
      this.beginRoomDeletion();
      return { dirty: true, inputChanged: false };
    }
    if (sequence === "\x1b[3~" && this.selectedMessageId !== undefined) {
      this.beginMessageDeletion();
      return { dirty: true, inputChanged: false };
    }
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
    const createIndex = this.rooms.length;
    const accountIndex = createIndex + (hasCreate ? 1 : 0);
    const total = accountIndex + 1;
    const current = this.accountFocused ? accountIndex : this.createRoomFocused ? createIndex : this.roomIndex;
    const next = (current + offset + total) % total;
    if (hasCreate && next === createIndex) {
      if (!this.onCreateRoomScreen()) this.resetRoomCreationForm();
      this.createRoomFocused = true;
      this.accountFocused = false;
      this.creatingRoom = false;
      this.render();
      return;
    }
    if (next === accountIndex) {
      if (this.onCreateRoomScreen()) this.resetRoomCreationForm();
      this.createRoomFocused = false;
      this.accountFocused = true;
      this.creatingRoom = false;
      this.render();
      return;
    }
    const leavingRoomCreation = this.onCreateRoomScreen();
    this.createRoomFocused = false;
    this.accountFocused = false;
    this.creatingRoom = false;
    if (leavingRoomCreation) this.resetRoomCreationForm();
    const nextRoom = next;
    if (nextRoom === this.roomIndex) { this.render(); return; }
    this.unsubscribe();
    this.unsubscribeService();
    this.room.setTyping(this.username, false);
    this.room.leave(this.username);
    this.roomIndex = nextRoom;
    this.room = this.rooms[nextRoom]!;
    this.write(`\x1b]777;room:${encodeURIComponent(this.room.name)}\x07`);
    this.scrollOffset = 0;
    this.selectedMessageId = undefined;
    this.replyToMessageId = undefined;
    this.deleteConfirmationId = undefined;
    this.unsubscribe = this.room.subscribe(() => this.scheduleRender());
    this.unsubscribeService = this.room.subscribeService(() => this.scheduleRender());
    this.messageCache.clear();
    this.room.join(this.username);
    this.render();
  }

  private reorderSidebarRoom(offset: -1 | 1): boolean {
    if (this.createRoomFocused || this.accountFocused) return false;
    if (!this.accounts || !this.principal.authenticated || this.principal.kind !== "user") {
      this.localNotice = "sign in to customize your room bar";
      return true;
    }
    const next = this.roomIndex + offset;
    if (next < 0 || next >= this.rooms.length) return false;
    const previousRooms = [...this.rooms];
    const previousIndex = this.roomIndex;
    const [moved] = this.rooms.splice(this.roomIndex, 1);
    this.rooms.splice(next, 0, moved!);
    this.roomIndex = next;
    try {
      this.accounts.saveRoomOrder(this.principal, this.rooms.map((room) => room.name));
      this.localNotice = "room order saved";
    } catch {
      this.rooms = previousRooms;
      this.roomIndex = previousIndex;
      this.localNotice = "could not save room order";
    }
    return true;
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
    if (this.creatingRoom) {
      if (direction === "A" || direction === "B") {
        this.createRoomField = Math.max(0, Math.min(4, this.createRoomField + (direction === "A" ? -1 : 1)));
        this.localNotice = "";
        return true;
      }
      if (this.createRoomField > 0 && this.createRoomField < 4 && (direction === "C" || direction === "D")) {
        this.cycleRoomCreationOption(direction === "C" ? 1 : -1);
        this.localNotice = "";
        return true;
      }
    }
    if ((direction === "A" || direction === "B") && this.commandMatches().length) {
      const matches = this.commandMatches();
      this.commandSelection = (this.commandSelection + (direction === "A" ? -1 : 1) + matches.length) % matches.length;
      return true;
    }
    if (!this.input && !this.creatingRoom && (direction === "A" || direction === "B") && (this.selectedMessageId !== undefined || direction === "A")) {
      return this.moveMessageSelection(direction === "A" ? -1 : 1);
    }
    if (direction === "C") return this.moveCursor(1);
    if (direction === "D") return this.moveCursor(-1);
    const moved = this.moveCursorVertical(direction === "A" ? -1 : 1);
    if (!moved) this.scrollChat(direction === "A" ? 1 : -1);
    return true;
  }

  private moveMessageSelection(offset: -1 | 1): boolean {
    if (!this.room.messages.length) return false;
    if (this.selectedMessageId === undefined) {
      if (offset > 0) return false;
      this.selectedMessageId = this.room.messages.at(-1)!.id;
    } else {
      const current = this.room.messages.findIndex((message) => message.id === this.selectedMessageId);
      const next = current + offset;
      if (current < 0 || next >= this.room.messages.length) {
        this.selectedMessageId = undefined;
        this.scrollOffset = 0;
      } else this.selectedMessageId = this.room.messages[Math.max(0, next)]!.id;
    }
    this.localNotice = "";
    return true;
  }

  private beginMessageDeletion(): void {
    if (this.selectedMessageId === undefined) return;
    if (!this.room.canDeleteMessage(this.principal)) {
      this.localNotice = "deleting messages requires a room admin";
      return;
    }
    this.deleteConfirmationId = this.selectedMessageId;
    this.localNotice = "";
  }

  private toggleSelectedPin(): void {
    if (this.selectedMessageId === undefined) return;
    const message = this.room.messages.find((candidate) => candidate.id === this.selectedMessageId);
    if (!message) return;
    if (!this.room.canPinMessage(this.principal)) {
      this.localNotice = "pinning messages requires a room admin";
      return;
    }
    try {
      const pinned = !message.pinnedAt;
      if (!this.room.setMessagePinned(this.principal, message.id, pinned)) this.localNotice = "that message cannot be pinned";
      else this.localNotice = pinned ? `pinned @${message.author}'s message` : `unpinned @${message.author}'s message`;
    } catch (error) {
      this.localNotice = error instanceof Error ? error.message : "could not update pin";
    }
  }

  private beginRoomDeletion(): void {
    if (!this.accounts || !this.directory) {
      this.localNotice = "room management is unavailable";
      return;
    }
    if (this.createRoomFocused || this.accountFocused) {
      this.localNotice = "select a room before deleting";
      return;
    }
    if (this.room.policy.system) {
      this.localNotice = "system rooms cannot be deleted";
      return;
    }
    if (!this.accounts.canManageRoom(this.principal, this.room.name)) {
      this.localNotice = "deleting a room requires its owner or a site admin";
      return;
    }
    this.deletingRoomName = this.room.name;
    this.sidebarFocused = false;
    this.input = "";
    this.cursorOffset = 0;
    this.preferredCursorColumn = undefined;
    this.localNotice = "";
    this.lastFrame = "";
    this.room.setTyping(this.username, false);
    this.animateSidebar();
  }

  private handleDeleteConfirmationData(data: Buffer): void {
    const value = data.toString("utf8");
    if (value.includes("\x03") || value.includes("\x04")) {
      this.stream.end();
      return;
    }
    const id = this.deleteConfirmationId;
    if (id === undefined) return;
    if (value === "y" || value === "Y") {
      try {
        this.localNotice = this.room.deleteMessage(this.principal, id) ? "message deleted" : "message no longer exists";
        this.messageCache.delete(id);
        if (this.replyToMessageId === id) this.replyToMessageId = undefined;
        this.selectedMessageId = undefined;
      } catch (error) {
        this.localNotice = error instanceof Error ? error.message : "message could not be deleted";
      }
    }
    this.deleteConfirmationId = undefined;
    this.render();
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
    const hudWidth = this.currentHudWidth();
    return this.width - 3 - hudWidth;
  }

  private commandMatches(): readonly SlashCommand[] {
    const matches = this.onCreateRoomScreen() ? [] : slashCommandMatches(this.input);
    if (this.commandPrefix !== this.input) {
      this.commandPrefix = this.input;
      this.commandSelection = 0;
    }
    this.commandSelection = Math.max(0, Math.min(this.commandSelection, Math.max(0, matches.length - 1)));
    return matches;
  }

  private completeSelectedCommand(): boolean {
    const matches = this.commandMatches();
    const selected = matches[this.commandSelection];
    if (!selected) return false;
    if (!selected.requiresArgument) {
      this.input = selected.name;
      this.cursorOffset = Array.from(this.input).length;
      return false;
    }
    this.input = `${selected.name} `;
    this.cursorOffset = Array.from(this.input).length;
    this.preferredCursorColumn = undefined;
    this.commandPrefix = this.input;
    this.commandSelection = 0;
    this.localNotice = "";
    return true;
  }

  private currentHudWidth(): number {
    if (this.room.name === "lobby" || this.onCreateRoomScreen() || this.deletingRoomName) return 0;
    return this.width >= 105 ? Math.min(50, Math.max(36, Math.floor(this.width * 0.32))) : 0;
  }

  private submit(): boolean {
    const line = this.input;
    const replyToId = this.replyToMessageId;
    if (line && line !== "/quit" && !this.allowSubmission(line)) return false;
    this.input = "";
    this.cursorOffset = 0;
    this.preferredCursorColumn = undefined;
    this.commandPrefix = "";
    this.commandSelection = 0;
    this.room.setTyping(this.username, false);
    this.scrollOffset = 0;
    this.selectedMessageId = undefined;
    this.replyToMessageId = undefined;
    if (line === "/quit") {
      this.stream.end();
      return true;
    }
    if (this.deletingRoomName) {
      const target = this.deletingRoomName;
      if (line !== target) {
        this.input = line;
        this.cursorOffset = Array.from(line).length;
        this.localNotice = `type ${target} exactly to archive this room`;
        return false;
      }
      try {
        if (!this.directory) throw new Error("room management is unavailable");
        this.directory.deleteRoom(this.principal, target);
        this.deletingRoomName = undefined;
        this.localNotice = `archived #${target} · /room restore ${target} to recover it`;
      } catch (error) {
        this.input = line;
        this.cursorOffset = Array.from(line).length;
        this.localNotice = error instanceof Error ? error.message : "room deletion failed";
      }
      return false;
    }
    if (this.creatingRoom) {
      if (this.createRoomField < 4) {
        if (this.createRoomField === 0 && !line.trim()) {
          this.localNotice = "room name is required";
          return false;
        }
        this.input = line;
        this.cursorOffset = Array.from(line).length;
        this.createRoomField++;
        this.localNotice = "";
        return false;
      }
      try {
        if (!this.directory) throw new Error("room management is unavailable");
        if (!line.trim()) throw new Error("room name is required");
        const created = this.directory.createRoom(this.principal, line.trim(), {
          visibility: this.createRoomVisibility,
          contributions: this.createRoomContributions,
          clankerMode: this.createRoomClankerMode,
        });
        this.creatingRoom = false;
        this.createRoomFocused = false;
        this.selectRoom(created);
        this.localNotice = `created #${created.name}`;
      } catch (error) {
        this.input = line;
        this.cursorOffset = Array.from(line).length;
        this.createRoomField = 0;
        this.localNotice = error instanceof Error ? error.message : "room creation failed";
      }
      return false;
    }
    if (this.handleHostCommand(line)) return false;
    if (this.canSubmitAnonymousLobby()) {
      if (line) void this.submitAnonymousLobby(line === "/help" ? "help" : line, replyToId);
      return false;
    }
    const accepted = line === "/help"
      ? this.room.clanker(this.principal, "")
      : line === "/clanker" || line.startsWith("/clanker ")
        ? this.room.clanker(this.principal, line.slice("/clanker".length))
        : this.room.chat(this.principal, line, replyToId);
    if (!accepted && line) this.localNotice = "room policy does not allow that action";
    return false;
  }

  private allowSubmission(line: string): boolean {
    if (!this.rateLimiter) return true;
    const explicitClanker = line === "/help" || line === "/clanker" || line.startsWith("/clanker ");
    const command = line.startsWith("/") && !explicitClanker;
    const policy = explicitClanker
      ? RATE_LIMITS.clankerRequest
      : command ? RATE_LIMITS.authenticatedCommand : this.principal.authenticated ? RATE_LIMITS.authenticatedChat : RATE_LIMITS.anonymousChat;
    const scope = explicitClanker ? "clanker" : command ? "command" : "chat";
    const decision = this.rateLimiter.consume(`tui:${scope}:${this.principal.id}`, policy);
    if (decision.allowed) return true;
    this.localNotice = `slow down · retry in ${retrySeconds(decision)}s`;
    return false;
  }

  private async submitAnonymousLobby(text: string, replyToId?: number): Promise<void> {
    if (!this.reviewAnonymousLobby || this.anonymousSubmissionPending) return;
    const lobby = this.room;
    this.anonymousSubmissionPending = true;
    this.localNotice = "checking message…";
    this.render();
    try {
      const decision = await this.reviewAnonymousLobby(this.principal, text);
      if (this.closed) return;
      if (decision.allowed && lobby.acceptModeratedAnonymousChat(this.principal, text, replyToId)) this.localNotice = "";
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
    const trimmed = line.trim();
    const [command, field, value, ...extra] = trimmed.split(/\s+/);
    if (command !== "/permissions" && command !== "/invite" && command !== "/redeem" && command !== "/room" && command !== "/account" && command !== "/edit" && command !== "/mount" && command !== "/shell") return false;
    try {
      if (command === "/shell") {
        if (field) throw new Error("usage: /shell");
        this.shellPanel = true;
        this.localNotice = "";
        this.lastFrame = "";
        return true;
      }
      if (command === "/mount") {
        if (value || extra.length || (field && field !== "revoke")) throw new Error("usage: /mount [revoke]");
        if (field === "revoke") {
          const revoked = this.accounts.revokeMountCredentials(this.principal, this.room.name);
          this.localNotice = revoked ? "Finder mount credential revoked" : "no active Finder mount credential";
          return true;
        }
        const credential = this.accounts.createMountCredential(this.principal, this.room.name);
        this.mountPanel = { credential, scroll: 0 };
        this.localNotice = "";
        this.lastFrame = "";
        this.room.setTyping(this.username, false);
        return true;
      }
      if (command === "/edit") {
        const [path, unexpected] = parseArguments(trimmed.slice(command.length).trim());
        if (!path || unexpected) throw new Error("usage: /edit <path>");
        if (!this.directory) throw new Error("room editing is unavailable");
        const workspace = this.directory.workspaces.get(this.room.name);
        if (!workspace) throw new Error("room source is unavailable");
        const result = new RoomCapabilitySession(this.principal, this.room, workspace, this.accounts).execute(`edit ${JSON.stringify(path)}`);
        if (!result.editor) throw new Error("unable to open editor");
        this.editor = result.editor;
        this.localNotice = "";
        this.lastFrame = "";
        return true;
      }
      if (command === "/account") {
        if (field) throw new Error("usage: /account");
        const profile = this.accounts.accountProfile(this.principal);
        this.localNotice = `@${this.username} · site ${profile.siteRole} · ${profile.plan} · rooms ${profile.ownedRooms}/${profile.roomLimit}`;
        return true;
      }
      if (command === "/room") {
        if (!this.directory) throw new Error("room management is unavailable");
        if (field === "archives") {
          if (value || extra.length) throw new Error("usage: /room archives");
          const archives = this.accounts.archivedRooms(this.principal);
          this.localNotice = archives.length
            ? `archived: ${archives.map((archive) => `#${archive.name}`).join(", ")} · /room restore <name>`
            : "no restorable room archives";
          return true;
        }
        if (extra.length || !value || (field !== "create" && field !== "rename" && field !== "delete" && field !== "restore")) throw new Error("usage: /room archives or /room create|rename|delete|restore <name>");
        if (field === "create") {
          const created = this.directory.createRoom(this.principal, value);
          this.selectRoom(created);
          this.localNotice = `created #${created.name}`;
        } else if (field === "rename") {
          const previous = this.room.name;
          const renamed = this.directory.renameRoom(this.principal, previous, value);
          this.selectRoom(renamed);
          this.localNotice = `renamed #${previous} to #${renamed.name}`;
        } else if (field === "delete") {
          if (value !== this.room.name) throw new Error(`switch to #${value} before deleting it`);
          this.directory.deleteRoom(this.principal, value);
          this.localNotice = `archived #${value} · /room restore ${value} to recover it`;
        } else {
          const restored = this.directory.restoreRoom(this.principal, value);
          this.selectRoom(restored);
          this.localNotice = `restored #${value}`;
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
        if (value || extra.length) throw new Error("usage: /invite [admin|contributor|viewer]");
        const role = (field ?? "contributor") as Exclude<RoomRole, "owner">;
        if (role !== "admin" && role !== "contributor" && role !== "viewer") throw new Error("usage: /invite [admin|contributor|viewer]");
        const token = this.room.createInvite(this.principal, role);
        const origin = this.directory?.controlOrigin ?? new URL(this.room.pageUrl).origin;
        this.localNotice = `${origin}/invite/${encodeURIComponent(token)}`;
        return true;
      }
      if (!field) {
        const policy = this.room.policy;
        this.localNotice = `${policy.visibility} · ${policy.contributions} contribute · ${policy.clankerMode} clanker`;
        return true;
      }
      if (!value) throw new Error("usage: /permissions visibility|contributions|clanker value");
      if (field === "visibility" && (value === "public" || value === "private")) this.room.updatePolicy(this.principal, { visibility: value as RoomVisibility });
      else if (field === "contributions" && (value === "members" || value === "authenticated" || value === "admins" || value === "disabled")) this.room.updatePolicy(this.principal, { contributions: value as ContributionPolicy });
      else if (field === "clanker" && (value === "passive" || value === "explicit" || value === "disabled")) this.room.updatePolicy(this.principal, { clankerMode: value as ClankerMode });
      else throw new Error("invalid permission setting");
      const policy = this.room.policy;
      this.localNotice = field === "contributions" && policy.contributions === "authenticated"
        ? "DANGEROUS · any signed-in account that can view this room may chat, edit, and invoke the clanker"
        : `${policy.visibility} · ${policy.contributions} contribute · ${policy.clankerMode} clanker`;
    } catch (error) {
      this.localNotice = error instanceof Error ? error.message : "permission command failed";
    }
    return true;
  }

  private beginRoomSettings(): void {
    if (this.createRoomFocused || this.accountFocused) {
      this.localNotice = "select a room to edit its settings";
      return;
    }
    if (!this.accounts?.isAdmin(this.principal, this.room.name)) {
      this.localNotice = "room settings require a room admin";
      return;
    }
    const policy = this.room.policy;
    if (policy.system) {
      this.localNotice = "system room policy is host-managed";
      return;
    }
    this.roomSettings = { field: 0, visibility: policy.visibility, contributions: policy.contributions, clankerMode: policy.clankerMode };
    this.sidebarFocused = false;
    this.input = "";
    this.cursorOffset = 0;
    this.localNotice = "";
    this.lastFrame = "";
    this.room.setTyping(this.username, false);
    this.animateSidebar();
  }

  private closeRoomSettings(toSidebar = false): void {
    this.roomSettings = undefined;
    this.sidebarFocused = toSidebar;
    this.localNotice = "";
    this.lastFrame = "";
    if (toSidebar) this.animateSidebar();
    this.render();
  }

  private handleRoomSettingsData(data: Buffer): void {
    const settings = this.roomSettings;
    if (!settings) return;
    const tokens = data.toString("utf8").match(/\x1b(?:\[[0-?]*[ -/]*[@-~]|O[HF]|[^\x1b])|[^\x1b]+/gs) ?? [];
    let dirty = false;
    for (const token of tokens) {
      if (token.startsWith("\x1b")) {
        const arrow = token.match(/^\x1b\[(?:1;[2-8])?([ABCD])$/);
        if (!arrow) continue;
        const direction = arrow[1]!;
        if (direction === "A" || direction === "B") settings.field = Math.max(0, Math.min(3, settings.field + (direction === "A" ? -1 : 1)));
        else this.cycleRoomSetting(direction === "C" ? 1 : -1);
        dirty = true;
        continue;
      }
      for (const char of token) {
        if (char === "\x03" || char === "\x04") { this.stream.end(); return; }
        if (char === "\t") return this.closeRoomSettings(true);
        if (char === "q" || char === "Q") return this.closeRoomSettings();
        if (char !== "\r" && char !== "\n") continue;
        if (char === "\n" && this.lastWasCarriageReturn) { this.lastWasCarriageReturn = false; continue; }
        this.lastWasCarriageReturn = char === "\r";
        if (settings.field < 3) {
          this.cycleRoomSetting(1);
          dirty = true;
          continue;
        }
        try {
          this.room.updatePolicy(this.principal, {
            visibility: settings.visibility,
            contributions: settings.contributions,
            clankerMode: settings.clankerMode,
          });
          this.roomSettings = undefined;
          this.localNotice = "room settings saved";
          this.lastFrame = "";
          this.render();
          return;
        } catch (error) {
          this.localNotice = error instanceof Error ? error.message : "room settings could not be saved";
          dirty = true;
        }
      }
    }
    if (dirty) this.render();
  }

  private cycleRoomSetting(direction: -1 | 1): void {
    if (!this.roomSettings) return;
    if (this.roomSettings.field === 0) this.roomSettings.visibility = cycle(["public", "private"] as const, this.roomSettings.visibility, direction);
    else if (this.roomSettings.field === 1) this.roomSettings.contributions = cycle(["members", "authenticated", "admins", "disabled"] as const, this.roomSettings.contributions, direction);
    else if (this.roomSettings.field === 2) this.roomSettings.clankerMode = cycle(["passive", "explicit", "disabled"] as const, this.roomSettings.clankerMode, direction);
  }

  private renderRoomSettings(): void {
    if (!this.roomSettings) return;
    const width = this.width;
    const row = (index: number, label: string, value: string, detail: string) => {
      const focused = this.roomSettings?.field === index;
      const marker = focused ? `${CYAN}›${CHAT}` : `${MUTED}·${CHAT}`;
      const setting = index === 3
        ? `${focused ? `${CYAN}${ESC}1m` : MUTED}[ Save changes ]${ESC}22m${CHAT}`
        : `${MUTED}← ${CHAT}${focused ? `${ESC}1m` : ""}${value}${focused ? `${ESC}22m` : ""}${MUTED} →${CHAT}`;
      return padAnsi(`  ${marker} ${pad(label, 18)} ${setting}${detail ? `   ${MUTED}${detail}${CHAT}` : ""}`, width);
    };
    const rows = [
      "",
      row(0, "Visibility", this.roomSettings.visibility, this.roomSettings.visibility === "public" ? "anyone can view" : "members only"),
      row(1, "Contributions", this.roomSettings.contributions, this.roomSettings.contributions === "members" ? "invited contributors and admins" : this.roomSettings.contributions === "authenticated" ? `${RED}DANGEROUS · any signed-in account can edit and invoke the clanker${CHAT}` : this.roomSettings.contributions === "admins" ? "admins only" : "read only"),
      row(2, "Clanker", this.roomSettings.clankerMode, this.roomSettings.clankerMode === "passive" ? "listens when useful" : this.roomSettings.clankerMode === "explicit" ? "/clanker only" : "disabled"),
      "",
      row(3, "", "save", ""),
    ];
    const bodyHeight = Math.max(1, this.height - 2);
    while (rows.length < bodyHeight) rows.push("");
    const header = `${HEADER}${pad(truncate(`  ROOM SETTINGS  #${this.room.name}`, width), width)}${RESET}`;
    const body = rows.slice(0, bodyHeight).map((line) => `${CHAT}${padAnsi(line, width)}${RESET}`);
    const footer = `${COMPOSER}${pad(truncate(this.localNotice ? `  ${this.localNotice}` : "  ↑↓ choose   ←→ or ENTER change   ENTER save   TAB rooms   Q close", width), width)}${RESET}`;
    const frame = `${[header, ...body, footer].join("\r\n")}${ESC}?25l`;
    if (frame === this.lastFrame) return;
    this.lastFrame = frame;
    this.write(`${ESC}?25l${ESC}H${ESC}2J${frame}`);
  }

  private beginAccountPanel(): void {
    this.accountPanel = { field: 0, editing: false };
    this.accountFocused = true;
    this.createRoomFocused = false;
    this.creatingRoom = false;
    this.input = "";
    this.cursorOffset = 0;
    this.preferredCursorColumn = undefined;
    this.localNotice = "";
    this.lastFrame = "";
    this.room.setTyping(this.username, false);
  }

  private closeAccountPanel(toSidebar = false): void {
    this.accountPanel = undefined;
    this.input = "";
    this.cursorOffset = 0;
    this.preferredCursorColumn = undefined;
    this.localNotice = "";
    this.sidebarFocused = toSidebar;
    this.accountFocused = toSidebar;
    this.lastFrame = "";
    if (toSidebar) this.animateSidebar();
    this.render();
  }

  private handleAccountPanelData(data: Buffer): void {
    if (!this.accountPanel) return;
    const tokens = data.toString("utf8").match(/\x1b(?:\[[0-?]*[ -/]*[@-~]|O[HF]|[^\x1b])|[^\x1b]+/gs) ?? [];
    let dirty = false;
    for (const token of tokens) {
      if (token.startsWith("\x1b")) {
        if (token === "\x1b" && !this.accountPanel.editing) return this.closeAccountPanel();
        const arrow = token.match(/^\x1b\[([ABCD])$/);
        if (arrow) {
          if (this.accountPanel.editing && arrow[1] === "C") dirty = this.moveCursor(1) || dirty;
          else if (this.accountPanel.editing && arrow[1] === "D") dirty = this.moveCursor(-1) || dirty;
          else if (!this.accountPanel.editing && (arrow[1] === "A" || arrow[1] === "B")) {
            const count = this.principal.authenticated ? 3 : 2;
            this.accountPanel.field = (this.accountPanel.field + (arrow[1] === "A" ? -1 : 1) + count) % count;
            dirty = true;
          }
        } else if (this.accountPanel.editing && token === "\x1b[3~") dirty = this.deleteForward() || dirty;
        continue;
      }
      for (const char of token) {
        if (char === "\x03" || (char === "\x04" && !this.input)) { this.stream.end(); return; }
        if (char === "\t" && !this.accountPanel.editing) return this.closeAccountPanel(true);
        if ((char === "q" || char === "Q") && !this.accountPanel.editing) return this.closeAccountPanel();
        if (char === "\r" || char === "\n") {
          if (char === "\n" && this.lastWasCarriageReturn) { this.lastWasCarriageReturn = false; continue; }
          this.lastWasCarriageReturn = char === "\r";
          this.activateAccountField();
          dirty = true;
          continue;
        }
        this.lastWasCarriageReturn = false;
        if (!this.accountPanel.editing) continue;
        if (char === "\x7f" || char === "\b") dirty = this.deleteBack() || dirty;
        else if (char === "\x04") dirty = this.deleteForward() || dirty;
        else if (char === "\x01") dirty = this.moveCursorTo(0) || dirty;
        else if (char === "\x05") dirty = this.moveCursorTo(Array.from(this.input).length) || dirty;
        else if (char === "\x15") dirty = this.deleteBeforeCursor() || dirty;
        else if (!/[\x00-\x1f\x7f]/.test(char) && Array.from(this.input).length < 80) dirty = this.insertAtCursor(char) || dirty;
      }
    }
    if (dirty) this.render();
  }

  private activateAccountField(): void {
    if (!this.accountPanel) return;
    if (!this.principal.authenticated) {
      if (this.accountPanel.field === 0) this.openAccountSignIn();
      else this.closeAccountPanel();
      return;
    }
    if (this.accountPanel.field === 0) {
      if (!this.accountPanel.editing) {
        this.input = this.principal.displayName;
        this.cursorOffset = Array.from(this.input).length;
        this.accountPanel.editing = true;
        this.localNotice = "";
        return;
      }
      try {
        if (!this.accounts) throw new Error("account storage is unavailable");
        this.principal = this.accounts.updateDisplayName(this.principal, this.input);
        this.accountPanel.editing = false;
        this.input = "";
        this.cursorOffset = 0;
        this.localNotice = "display name updated";
      } catch (error) {
        this.localNotice = error instanceof Error ? error.message : "account update failed";
      }
      return;
    }
    if (this.accountPanel.field === 1) this.openAccountSignIn();
    else this.closeAccountPanel();
  }

  private openAccountSignIn(): void {
    if (!this.accountPanel) return;
    try {
      if (!this.accountPanel.linkUrl) {
        if (this.principal.authenticated) {
          if (!this.accounts) throw new Error("account storage is unavailable");
          const link = this.accounts.createAccountLink(this.principal);
          const controlOrigin = new URL(this.signInUrl ?? this.room.pageUrl).origin;
          this.accountPanel.linkUrl = `${controlOrigin}/?account=${encodeURIComponent(link.code)}`;
        } else if (this.signInUrl) this.accountPanel.linkUrl = this.signInUrl;
      }
      if (!this.accountPanel.linkUrl) throw new Error("sign in is unavailable in this session");
      this.write(`\x1b]777;open:${encodeURIComponent(this.accountPanel.linkUrl)}\x07`);
      this.localNotice = "open the secure sign-in link shown above";
    } catch (error) {
      this.localNotice = error instanceof Error ? error.message : "sign in is unavailable";
    }
  }

  private renderAccountPanel(): void {
    if (!this.accountPanel) return;
    const width = this.width;
    const authenticated = this.principal.authenticated && this.principal.kind === "user";
    const settings = authenticated ? this.accounts?.accountSettings(this.principal) : undefined;
    const linkUrl = this.accountPanel.linkUrl ?? (!authenticated ? this.signInUrl : undefined);
    const action = (index: number, label: string, detail = "", tone = CHAT) => {
      const focused = this.accountPanel?.field === index;
      const prefix = `  ${focused ? "›" : "·"} ${label}`;
      const clippedDetail = detail ? truncate(detail, Math.max(0, width - terminalWidth(prefix) - 3)) : "";
      const styledLabel = focused ? `${ESC}1m${tone}${label}${ESC}22m${CHAT}` : `${tone}${label}${CHAT}`;
      return padAnsi(`  ${focused ? `${CYAN}›${CHAT}` : `${MUTED}·${CHAT}`} ${styledLabel}${clippedDetail ? `   ${MUTED}${clippedDetail}${CHAT}` : ""}`, width);
    };
    const rows = authenticated && settings ? [
      "",
      `  @${settings.handle} · ${settings.displayName}`,
      `  ${OWNER}${settings.siteRole}${CHAT} · ${settings.plan} plan · ${settings.ownedRooms}/${settings.roomLimit} rooms`,
      `  sign-in  ${settings.providers.length ? settings.providers.join(" · ") : "none linked"} · ${settings.sshKeys} SSH ${settings.sshKeys === 1 ? "key" : "keys"}`,
      "",
      action(0, "Change display name", this.accountPanel.editing ? "editing below" : settings.displayName, GREEN),
      action(1, "Add a sign-in method", linkUrl ? "secure link ready" : "Google or GitHub"),
      action(2, "Back to chat"),
    ] : [
      "",
      "  Anonymous",
      "",
      "  Sign in to create rooms, contribute, and use the same account from browser and SSH.",
      "",
      action(0, "Sign in", "Google or GitHub"),
      action(1, "Back to chat"),
    ];
    if (linkUrl) {
      const index = authenticated ? 6 : 5;
      rows[index] = linkText(rows[index]!, authenticated ? "Add a sign-in method" : "Sign in", linkUrl, CYAN, CHAT);
    }
    const bodyHeight = Math.max(1, this.height - 2);
    const visible = rows.slice(0, bodyHeight);
    while (visible.length < bodyHeight) visible.push("");
    const header = `${HEADER}${pad(truncate(`  ACCOUNT  @${this.username}`, width), width)}${RESET}`;
    const body = visible.map((line) => `${CHAT}${padAnsi(line, width)}${RESET}`);
    const footerText = this.accountPanel.editing
      ? `  display name: ${this.input}`
      : this.localNotice ? `  ${this.localNotice}` : "  ↑↓ choose   ENTER select   TAB account list   Q close";
    const footer = `${COMPOSER}${pad(truncate(footerText, width), width)}${RESET}`;
    const cursorColumn = Math.min(width, terminalWidth("  display name: ") + terminalWidth(Array.from(this.input).slice(0, this.cursorOffset).join("")) + 1);
    const cursor = this.accountPanel.editing ? `${ESC}${this.height};${cursorColumn}H${ESC}?25h` : `${ESC}?25l`;
    const frame = `${[header, ...body, footer].join("\r\n")}${cursor}`;
    if (frame === this.lastFrame) return;
    this.lastFrame = frame;
    this.write(`${ESC}?25l${ESC}H${ESC}2J${frame}`);
  }

  private handleMountPanelData(data: Buffer): void {
    const value = data.toString("utf8");
    if (value.includes("\x03") || value.includes("\x04")) {
      this.stream.end();
      return;
    }
    if (value.includes("\r") || value.includes("\n") || value === "q" || value === "Q" || value === "\x1b") {
      this.mountPanel = undefined;
      this.lastFrame = "";
      this.render();
      return;
    }
    let movement = 0;
    for (const match of value.matchAll(/\x1b\[([AB56])~?/g)) {
      if (match[1] === "A") movement--;
      else if (match[1] === "B") movement++;
      else if (match[1] === "5") movement -= Math.max(1, this.height - 4);
      else if (match[1] === "6") movement += Math.max(1, this.height - 4);
    }
    if (movement && this.mountPanel) {
      this.mountPanel.scroll = Math.max(0, this.mountPanel.scroll + movement);
      this.render();
    }
  }

  private renderMountPanel(): void {
    if (!this.mountPanel) return;
    const width = this.width;
    const bodyHeight = Math.max(1, this.height - 2);
    const rows = this.mountInstructionRows(width);
    const maximumScroll = Math.max(0, rows.length - bodyHeight);
    this.mountPanel.scroll = Math.min(this.mountPanel.scroll, maximumScroll);
    const visible = rows.slice(this.mountPanel.scroll, this.mountPanel.scroll + bodyHeight);
    while (visible.length < bodyHeight) visible.push("");
    const title = `  MOUNT  #${this.mountPanel.credential.roomName}`;
    const position = maximumScroll ? `  ${this.mountPanel.scroll + 1}-${Math.min(rows.length, this.mountPanel.scroll + bodyHeight)}/${rows.length}` : "";
    const header = `${HEADER}${pad(`${truncate(title, Math.max(1, width - position.length))}${position}`, width)}${RESET}`;
    const body = visible.map((line) => {
      const section = /^(SFTP|SSHFS|FINDER \/ WEBDAV)/.test(line.trimStart());
      const secret = /^\s*(username|password):/.test(line);
      const tone = section ? CYAN : secret ? YELLOW : CHAT;
      return `${tone}${pad(truncate(line, width), width)}${RESET}`;
    });
    const footerText = maximumScroll ? "  ↑↓ scroll   ENTER/Q close   /mount revoke disables Finder" : "  ENTER/Q close   /mount rotates   /mount revoke disables Finder";
    const footer = `${COMPOSER}${pad(truncate(footerText, width), width)}${RESET}`;
    const frame = `${[header, ...body, footer].join("\r\n")}${ESC}?25l`;
    if (frame === this.lastFrame) return;
    this.lastFrame = frame;
    this.write(`${ESC}?25l${ESC}H${ESC}2J${frame}`);
  }

  private handleShellPanelData(data: Buffer): void {
    const value = data.toString("utf8");
    if (value.includes("\x03") || value.includes("\x04")) {
      this.stream.end();
      return;
    }
    if (value.includes("\r") || value.includes("\n") || value === "q" || value === "Q" || value === "\x1b") {
      this.shellPanel = false;
      this.lastFrame = "";
      this.render();
    }
  }

  private renderShellPanel(): void {
    if (!this.shellPanel) return;
    const width = this.width;
    const command = `ssh -t -p 2222 serverside.chat shell ${this.room.name}`;
    const raw = [
      "",
      "  Open this room's constrained shell in a new terminal:",
      "",
      `    ${command}`,
      "",
      "  The shell exposes only this room's bounded files and version-control capabilities.",
      this.principal.authenticated ? "  It authenticates with any SSH key linked to your account." : "  Sign in and link an SSH key to your account first.",
    ];
    const bodyHeight = Math.max(1, this.height - 2);
    const rows = raw.flatMap((line) => line ? wrap(line, Math.max(12, width - 2)) : [""]).slice(0, bodyHeight);
    while (rows.length < bodyHeight) rows.push("");
    const header = `${HEADER}${pad(truncate(`  SHELL  #${this.room.name}`, width), width)}${RESET}`;
    const body = rows.map((line) => `${CHAT}${padAnsi(line.includes(command) ? `${CYAN}${line}${CHAT}` : line, width)}${RESET}`);
    const footer = `${COMPOSER}${pad(truncate("  ENTER/Q close", width), width)}${RESET}`;
    const frame = `${[header, ...body, footer].join("\r\n")}${ESC}?25l`;
    if (frame === this.lastFrame) return;
    this.lastFrame = frame;
    this.write(`${ESC}?25l${ESC}H${ESC}2J${frame}`);
  }

  private mountInstructionRows(width: number): string[] {
    if (!this.mountPanel) return [];
    const credential = this.mountPanel.credential;
    const control = new URL(this.signInUrl ?? this.room.pageUrl);
    const host = control.hostname;
    const davUrl = `${control.origin}/_dav/${encodeURIComponent(this.room.name)}/`;
    const local = `./${this.room.name}`;
    const access = credential.readOnly ? "read only" : "read + write";
    const raw = [
      `  Room source · ${access} · 5 MiB workspace · credential expires ${new Date(credential.expiresAt).toISOString().slice(0, 10)}`,
      "",
      "  SFTP · built into macOS · interactive transfer",
      `    sftp -P 2222 ${host}:${this.room.name}`,
      "    Uses your linked SSH key. Try: ls, get worker.js, put worker.js",
      "",
      "  SSHFS · mounted folder · requires macFUSE/SSHFS",
      `    mkdir -p ${local}`,
      `    sshfs -p 2222 ${host}:/${this.room.name} ${local}`,
      "    Uses your linked SSH key.",
      "",
      "  FINDER / WEBDAV · built into macOS",
      `    Press ⌘K in Finder and enter ${davUrl}`,
      `    username: ${credential.username}`,
      `    password: ${credential.password}`,
      "    Save the credential in Keychain. It is shown only on this screen.",
      "",
      "  Running /mount again rotates the Finder credential for this room.",
      "  /mount revoke disables it immediately. Room permissions always apply.",
    ];
    const lineWidth = Math.max(12, width - 2);
    return raw.flatMap((line) => line ? wrap(line, lineWidth) : [""]);
  }

  private render(): void {
    if (this.closed) return;
    if (!this.room.canView(this.principal)) {
      this.stream.end("Room access changed. Reconnect after receiving an invitation.\r\n");
      return;
    }
    if (this.accountPanel) {
      this.renderAccountPanel();
      return;
    }
    if (this.roomSettings) {
      this.renderRoomSettings();
      return;
    }
    if (this.editor) {
      const frame = this.editor.render(this.width, this.height);
      if (frame !== this.lastFrame) {
        this.lastFrame = frame;
        this.write(`${ESC}?25l${ESC}H${ESC}2J${frame}`);
      }
      return;
    }
    if (this.mountPanel) {
      this.renderMountPanel();
      return;
    }
    if (this.shellPanel) {
      this.renderShellPanel();
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
    const deleteRoomScreen = Boolean(this.deletingRoomName);
    const roomManagementScreen = createRoomScreen || deleteRoomScreen;
    if (this.selectedMessageId !== undefined && !this.room.messages.some((message) => message.id === this.selectedMessageId)) this.selectedMessageId = undefined;
    if (this.replyToMessageId !== undefined && !this.room.messages.some((message) => message.id === this.replyToMessageId)) {
      this.replyToMessageId = undefined;
      this.localNotice = "the message being replied to was deleted";
    }
    const sidebarWidth = 3;
    const drawerWidth = Math.round(this.sidebarWidth);
    const hudWidth = this.currentHudWidth();
    const mainWidth = this.mainWidth();
    const topStatus = this.topStatusRows(mainWidth, this.height);
    const topRows = deleteRoomScreen ? [] : topStatus;
    const writable = deleteRoomScreen || this.canUseComposer();
    const readOnlyText = this.principal.authenticated
      ? this.room.policy.contributions === "disabled"
        ? "read only · contributions are disabled"
        : this.room.policy.contributions === "admins"
          ? "read only · admins can contribute"
          : `read only · ask @${this.room.owner} for an invite`
      : "read only · sign in to contribute";
    const createRoomFooter = mainWidth < 55
      ? "↑↓ field  ←→ set  ENTER  TAB rooms"
      : "↑↓ fields   ←→ change   ENTER next/create   TAB rooms";
    const composerValue = createRoomScreen
      ? createRoomFooter
      : writable ? this.input : readOnlyText;
    const selectedMessage = this.selectedMessageId === undefined ? undefined : this.room.messages.find((message) => message.id === this.selectedMessageId);
    const deletingMessage = this.deleteConfirmationId === undefined ? undefined : this.room.messages.find((message) => message.id === this.deleteConfirmationId);
    const ambientStatus = this.ambientStatus(mainWidth);
    const bottomStatus = deletingMessage
      ? truncate(`  delete @${deletingMessage.author}'s message?  Y confirm · N cancel`, mainWidth)
      : this.localNotice
        ? truncate(`  ${this.localNotice}`, mainWidth)
        : selectedMessage
          ? truncate(`  selected @${selectedMessage.author} · ENTER reply${this.room.canPinMessage(this.principal) && selectedMessage.kind !== "system" ? ` · P ${selectedMessage.pinnedAt ? "unpin" : "pin"}` : ""}${this.room.canDeleteMessage(this.principal) ? " · DELETE remove" : ""} · ↓ cancel`, mainWidth)
          : deleteRoomScreen
            ? truncate(`  type ${this.deletingRoomName} exactly · TAB cancels`, mainWidth)
            : createRoomScreen ? "" : ambientStatus;
    const showBottomStatus = !createRoomScreen || Boolean(bottomStatus);
    const inputLayout = layoutComposer(composerValue, !createRoomScreen && writable ? this.cursorOffset : 0, mainWidth);
    const maximumComposerRows = Math.max(1, Math.min(5, this.height - topRows.length - (showBottomStatus ? 1 : 0) - 5));
    let firstInputRow = Math.max(0, inputLayout.rows.length - maximumComposerRows);
    if (inputLayout.cursorRow < firstInputRow) firstInputRow = inputLayout.cursorRow;
    if (inputLayout.cursorRow >= firstInputRow + maximumComposerRows) firstInputRow = inputLayout.cursorRow - maximumComposerRows + 1;
    const inputRows = inputLayout.rows.slice(firstInputRow, firstInputRow + maximumComposerRows).map((row) => row.text);
    const commandMatches = writable && !roomManagementScreen ? this.commandMatches() : [];
    const commandCapacity = Math.max(0, Math.min(8, this.height - topRows.length - inputRows.length - (showBottomStatus ? 1 : 0) - 5));
    const maximumCommandStart = Math.max(0, commandMatches.length - commandCapacity);
    const commandStart = Math.min(maximumCommandStart, Math.max(0, this.commandSelection - Math.floor(commandCapacity / 2)));
    const commandChoices = commandCapacity
      ? commandMatches.slice(commandStart, commandStart + commandCapacity).map((command, offset) => ({ command, index: commandStart + offset }))
      : [];
    const messageRows = Math.max(1, this.height - topRows.length - inputRows.length - (showBottomStatus ? 1 : 0) - commandChoices.length - 4);
    const messageCacheRoom = createRoomScreen ? "__new-room__" : deleteRoomScreen ? "__delete-room__" : this.room.name;
    if (this.messageCacheRoom !== messageCacheRoom || this.messageCacheWidth !== mainWidth) {
      this.messageCacheRoom = messageCacheRoom;
      this.messageCacheWidth = mainWidth;
      this.messageCache.clear();
    }
    const roomMessages = roomManagementScreen ? [] : this.room.messages;
    const messages: Array<{ text: string; kind: MessageKind | "form"; id?: number }> = createRoomScreen
      ? this.createRoomFormRows().map((text) => ({ text, kind: "form" }))
      : deleteRoomScreen
        ? this.deleteRoomFormRows().map((text) => ({ text, kind: "form" }))
        : roomMessages.flatMap((message, index) => {
          const isTrunkUpdate = message.kind === "system" && message.author === "trunk";
          const previous = roomMessages[index - 1];
          const showAuthor = !isTrunkUpdate && (!previous || previous.author !== message.author || previous.author === "trunk");
          const showSpacer = Boolean(previous) && (showAuthor || (isTrunkUpdate && previous!.author !== "trunk"));
          let cached = this.messageCache.get(message.id);
          if (!cached || cached.showAuthor !== showAuthor) {
            cached = { showAuthor, rows: this.formatMessage(message, mainWidth, showAuthor) };
            this.messageCache.set(message.id, cached);
          }
          return [
            ...(showSpacer ? [{ text: "", kind: "chat" as const }] : []),
            ...cached.rows.map((text) => ({ text, kind: message.kind, id: message.id })),
          ];
        });
    if (this.messageCache.size > roomMessages.length) {
      const retained = new Set(roomMessages.map((message) => message.id));
      for (const id of this.messageCache.keys()) if (!retained.has(id)) this.messageCache.delete(id);
    }
    const maximumOffset = Math.max(0, messages.length - messageRows);
    this.scrollOffset = Math.min(this.scrollOffset, maximumOffset);
    if (this.selectedMessageId !== undefined) {
      const firstSelected = messages.findIndex((message) => message.id === this.selectedMessageId);
      const lastSelected = messages.map((message) => message.id).lastIndexOf(this.selectedMessageId);
      const viewportEnd = messages.length - this.scrollOffset;
      const viewportStart = Math.max(0, viewportEnd - messageRows);
      if (firstSelected >= 0 && firstSelected < viewportStart) this.scrollOffset = messages.length - Math.min(messages.length, firstSelected + messageRows);
      else if (lastSelected >= viewportEnd) this.scrollOffset = Math.max(0, messages.length - lastSelected - 1);
    }
    const end = messages.length - this.scrollOffset;
    const visible = messages.slice(Math.max(0, end - messageRows), end);
    while (visible.length < messageRows) {
      const blank: { text: string; kind: MessageKind | "form"; id?: number } = { text: "", kind: "chat" };
      if (roomManagementScreen) visible.push(blank);
      else visible.unshift(blank);
    }

    const status = createRoomScreen ? "setup  " : deleteRoomScreen ? "confirm  " : this.scrollOffset ? `↑${this.scrollOffset}  ` : "";
    const titleWidth = Math.max(1, mainWidth - terminalWidth(status));
    const baseTitle = createRoomScreen
      ? "+ new room"
      : deleteRoomScreen
        ? `delete # ${this.deletingRoomName}`
      : `# ${this.room.name}  ${this.room.policy.visibility === "private" ? "private" : "public"}`;
    const headerPageUrl = !roomManagementScreen && this.room.name !== "lobby" ? this.room.pageUrl : "";
    const pageRef = headerPageUrl ? compactUrl(headerPageUrl) : "";
    const titleCandidates = pageRef
      ? [`${baseTitle}   ↗ ${pageRef}`, `# ${this.room.name}   ↗ ${pageRef}`, `↗ ${pageRef}`]
      : [baseTitle];
    const plainTitle = titleCandidates.find((candidate) => terminalWidth(candidate) <= titleWidth)
      ?? truncate(titleCandidates.at(-1)!, titleWidth);
    const linkedTitle = pageRef && plainTitle.includes(pageRef)
      ? linkText(plainTitle, pageRef, headerPageUrl, CYAN, HEADER)
      : plainTitle;
    const sidebarHeader = this.sidebarHeader(sidebarWidth);
    const paneTone = this.sidebarFocused ? DIM : "";
    const hudHeader = hudWidth ? this.dimInactiveHud(`${HUD_MUTED}${pad("  VERSION CONTROL", hudWidth)}${RESET}`) : "";
    const header = `${sidebarHeader}${paneTone}${HEADER}${centerAnsi(linkedTitle, titleWidth)}${status}${RESET}${hudHeader}`;
    const statusHeaders = topRows.map((line, index) => `${this.sidebarRow(index, sidebarWidth)}${paneTone}${STATUS}${padAnsi(line, mainWidth)}${RESET}${this.hudRow(index, hudWidth)}`);
    const statusSpacerRow = topRows.length;
    const statusSpacer = `${this.sidebarRow(statusSpacerRow, sidebarWidth)}${paneTone}${CHAT}${" ".repeat(mainWidth)}${RESET}${this.hudRow(statusSpacerRow, hudWidth)}`;
    const body = visible.map(({ text, kind, id }, index) => {
      const selected = id !== undefined && id === this.selectedMessageId;
      const color = selected ? CHAT_SELECTED : kind === "system" ? CHAT_MUTED : CHAT;
      const columnRow = index + topRows.length + 1;
      const rendered = padAnsi(selected
        ? text.replaceAll(`${ESC}48;5;235m`, `${ESC}48;5;59m`)
        : text, mainWidth);
      const renderedText = this.sidebarFocused ? rendered.replaceAll(`${ESC}22m`, `${ESC}22m${DIM}`) : rendered;
      return `${this.sidebarRow(columnRow, sidebarWidth)}${paneTone}${color}${renderedText}${RESET}${this.hudRow(columnRow, hudWidth)}`;
    });
    const typing = showBottomStatus
      ? (() => {
          const padded = pad(bottomStatus, mainWidth);
          const rendered = this.localNotice && /^https?:\/\//.test(this.localNotice)
            ? linkText(padded, this.localNotice, this.localNotice, CYAN, `${ESC}3m${MUTED}`)
            : !this.principal.authenticated && this.signInUrl ? linkText(padded, "sign in", this.signInUrl, CYAN, `${ESC}3m${MUTED}`) : padded;
          const columnRow = topRows.length + 1 + visible.length;
          return [`${this.sidebarRow(columnRow, sidebarWidth)}${paneTone}${CHAT_STATUS}${ESC}3m${rendered}${ESC}23m${RESET}${this.hudRow(columnRow, hudWidth)}`];
        })()
      : [];
    const commandMenu = commandChoices.map(({ command, index }, offset) => {
      const columnRow = topRows.length + 1 + visible.length + typing.length + offset;
      const selected = index === this.commandSelection;
      const style = selected ? COMMAND_ACTIVE : COMMAND;
      return `${this.sidebarRow(columnRow, sidebarWidth)}${paneTone}${style}${renderSlashCommand(command, selected, mainWidth)}${RESET}${this.hudRow(columnRow, hudWidth)}`;
    });
    const composerSpacerRow = topRows.length + 1 + visible.length + typing.length + commandMenu.length;
    const replyTarget = this.replyToMessageId === undefined ? undefined : this.room.messages.find((message) => message.id === this.replyToMessageId);
    const replyLabel = replyTarget ? truncate(`  ↳ replying to @${replyTarget.author}  ${replyTarget.text.replace(/\s+/g, " ")}`, mainWidth) : "";
    const composerSpacer = `${SIDEBAR}${" ".repeat(sidebarWidth)}${RESET}${paneTone}${COMPOSER}${MUTED}${pad(replyLabel, mainWidth)}${RESET}${this.hudRow(composerSpacerRow, hudWidth)}`;
    const composer = inputRows.map((inputText, index) => {
      const sidebarComposer = `${SIDEBAR}${" ".repeat(sidebarWidth)}${RESET}`;
      const columnRow = composerSpacerRow + 1 + index;
      const firstVisibleInputRow = firstInputRow + index === 0;
      const displayText = firstVisibleInputRow && writable && !this.input && !createRoomScreen
        ? deleteRoomScreen ? `  type ${this.deletingRoomName} to confirm` : `  type / to see commands`
        : inputText;
      const padded = pad(truncate(displayText, mainWidth), mainWidth);
      let renderedInput = !writable && !this.principal.authenticated && this.signInUrl ? linkText(padded, "sign in", this.signInUrl, CYAN, COMPOSER) : padded;
      if (firstVisibleInputRow && !createRoomScreen) {
        renderedInput = writable && !this.input
          ? `${CYAN}›${COMPOSER} ${MUTED}${pad(truncate(deleteRoomScreen ? `type ${this.deletingRoomName} to confirm` : "type / to see commands", Math.max(0, mainWidth - 2)), Math.max(0, mainWidth - 2))}`
          : `${CYAN}›${COMPOSER}${renderedInput.slice(1)}`;
      }
      return `${sidebarComposer}${paneTone}${COMPOSER}${renderedInput}${RESET}${this.hudRow(columnRow, hudWidth)}`;
    });
    const sidebarFooter = this.sidebarFooter(sidebarWidth, createRoomScreen, deleteRoomScreen);
    const composerFooterRow = composerSpacerRow + 1 + inputRows.length;
    const composerFooter = `${sidebarFooter}${paneTone}${COMPOSER}${" ".repeat(mainWidth)}${RESET}${this.hudRow(composerFooterRow, hudWidth)}`;
    const composerCursorColumn = sidebarWidth + Math.min(mainWidth, inputLayout.cursorColumn + 1);
    const composerCursorRow = this.height - inputRows.length + inputLayout.cursorRow - firstInputRow;
    const formNamePrefix = "  › " + pad("Name", 16) + " ";
    const formCursorColumn = sidebarWidth + visibleLength(formNamePrefix) + terminalWidth(Array.from(this.input).slice(0, this.cursorOffset).join("")) + 1;
    const formCursorRow = topRows.length + 3;
    const screenRows = [header, ...statusHeaders, statusSpacer, ...body, ...typing, ...commandMenu, composerSpacer, ...composer, composerFooter];
    const screen = screenRows.join("\r\n");
    const drawerOverlay = drawerWidth > sidebarWidth
      ? screenRows.map((_, index) => {
          const row = index === 0
            ? this.sidebarHeader(drawerWidth)
            : index === screenRows.length - 1
              ? this.sidebarFooter(drawerWidth, createRoomScreen, deleteRoomScreen)
              : this.sidebarRow(index - 1, drawerWidth);
          return `${ESC}${index + 1};1H${row}`;
        }).join("")
      : "";
    const cursor = this.sidebarFocused || !writable || (createRoomScreen && (!this.creatingRoom || this.createRoomField !== 0))
      ? `${ESC}?25l`
      : createRoomScreen
        ? `${ESC}${formCursorRow};${Math.min(this.width, formCursorColumn)}H${ESC}?25h`
        : `${ESC}${composerCursorRow};${composerCursorColumn}H${ESC}?25h`;
    const frame = `${screen}${drawerOverlay}${cursor}`;
    if (frame === this.lastFrame) return;
    this.lastFrame = frame;
    this.write(`${ESC}?25l${ESC}H${ESC}2J${frame}`);
  }

  private topStatusRows(width: number, height: number): string[] {
    if (this.onCreateRoomScreen()) {
      const title = truncate("  Configure the room before entering it.", width);
      const defaults = truncate("  Defaults are public · members contribute · passive clanker.", width);
      return height < 12 ? [title] : [title, defaults];
    }
    if (this.room.name === "lobby") return this.lobbyStatusRows(width, height);
    const sitePulse = Date.now() - this.room.lastRequestAt < 1_200 ? SPINNER[Math.floor(Date.now() / 100) % SPINNER.length] : "●";
    const averageLatency = this.room.serviceRequests ? this.room.serviceTotalLatencyMs / this.room.serviceRequests : 0;
    const healthTone = this.room.serviceErrors ? RED : GREEN;
    const full = `${healthTone}${sitePulse}${STATUS} ${this.room.serviceErrors ? "errors" : "healthy"}   people ${this.room.members.size}   req ${this.room.serviceRequests}   err ${this.room.serviceErrors}   ${averageLatency.toFixed(1)}ms`;
    const medium = `${healthTone}${sitePulse}${STATUS} ${this.room.serviceErrors ? "errors" : "healthy"}   people ${this.room.members.size}   err ${this.room.serviceErrors}`;
    const compact = `${healthTone}${sitePulse}${STATUS} ${this.room.serviceErrors ? "errors" : "healthy"}   people ${this.room.members.size}`;
    const site = [full, medium, compact].find((candidate) => visibleLength(candidate) <= width) ?? compact;
    return [centerAnsi(site, width), ...this.pinnedStatusRows(width, height)];
  }

  private lobbyStatusRows(width: number, height: number): string[] {
    const message = "Every room gets a server and a clanker. Have fun!";
    const contentWidth = Math.max(1, width - Math.min(8, Math.max(0, width - 1)));
    const messageRows = wrap(message, contentWidth).map((line) => centerAnsi(`${ESC}1m${line}${ESC}22m${STATUS}`, width));
    const padding = height >= 18 ? 2 : height >= 12 ? 1 : 0;
    const banner = [...Array<string>(padding).fill(""), ...messageRows, ...Array<string>(padding).fill("")];
    return [...banner, ...this.pinnedStatusRows(width, Math.max(3, height - banner.length))];
  }

  private pinnedStatusRows(width: number, height: number): string[] {
    const pins = this.room.pinnedMessages;
    if (!pins.length) return [];
    const capacity = Math.max(1, Math.min(8, Math.floor(height / 3)));
    const rows: string[] = [];
    let truncated = false;
    for (const message of pins) {
      const content = `@${message.author}  ${message.text.replace(/\s+/g, " ")}`;
      const wrapped = wrapLinkedChatText(content, Math.max(1, width - 4), STATUS);
      const available = capacity - rows.length;
      for (let index = 0; index < wrapped.length && rows.length < capacity; index++) {
        const marker = index === 0 ? `${YELLOW}◆${STATUS}` : " ";
        rows.push(`  ${marker} ${wrapped[index]}`);
      }
      if (rows.length >= capacity) {
        truncated = message !== pins.at(-1) || wrapped.length > available;
        break;
      }
    }
    if (truncated) rows[capacity - 1] = `  ${MUTED}… more pinned content${STATUS}`;
    return rows;
  }

  private hudRow(index: number, width: number): string {
    if (!width) return "";
    const resources = this.resourceHudRows(width);
    const logStart = Math.max(resources.length, Math.max(2, Math.floor((this.height - 1) * 2 / 3)));
    const logging = this.loggingHudRows(width, Math.max(0, this.height - 1 - logStart));
    let rendered: string;
    if (index >= logStart && index < logStart + logging.length) {
      rendered = `${HUD}${padAnsi(logging[index - logStart]!, width)}${RESET}`;
      return this.dimInactiveHud(rendered);
    }
    const resourceStart = Math.max(0, logStart - resources.length);
    if (index >= resourceStart && index < resourceStart + resources.length) {
      rendered = `${HUD}${padAnsi(resources[index - resourceStart]!, width)}${RESET}`;
      return this.dimInactiveHud(rendered);
    }
    const row = index < resourceStart ? this.room.versionGraph[index] : undefined;
    rendered = row ? `${HUD}${renderVersionRow(row.text, row.url, width)}${RESET}` : `${HUD}${" ".repeat(width)}${RESET}`;
    return this.dimInactiveHud(rendered);
  }

  private loggingHudRows(_width: number, capacity: number): string[] {
    if (capacity <= 0) return [];
    const live = Date.now() - this.room.lastRequestAt < 1_200;
    const pulse = live ? SPINNER[Math.floor(Date.now() / 100) % SPINNER.length] : "·";
    const serverHeader = `${HUD_MUTED}  SERVER LOGS  ${live ? GREEN : MUTED}${pulse}${HUD}`;
    if (capacity === 1) return [serverHeader];
    const clankerHeader = `${HUD_MUTED}  CLANKER ERRORS${HUD}`;
    if (capacity === 2) return [serverHeader, clankerHeader];
    const available = capacity - 2;
    const clankerSlots = this.room.clankerErrorLogs.length ? Math.max(1, Math.min(2, Math.floor(available / 3))) : 0;
    const serverSlots = available - clankerSlots;
    return [
      serverHeader,
      ...rightAlignedLogSlots(this.room.serviceLogs, serverSlots),
      clankerHeader,
      ...rightAlignedLogSlots(this.room.clankerErrorLogs, clankerSlots, renderClankerErrorLog),
    ];
  }

  private resourceHudRows(width: number): string[] {
    return [
      denseUsageBar("DB", this.room.databaseBytes, ROOM_LIMITS.databaseBytes, formatCompactBytes, width),
      denseUsageBar("CONN", this.room.connectionCount, ROOM_LIMITS.connections, String, width),
      denseUsageBar("FILES", this.room.filesystemBytes, ROOM_LIMITS.filesystemBytes, formatCompactBytes, width),
      denseUsageBar("BYTES/H", this.room.egressBytesLastHour, ROOM_LIMITS.egressBytesPerHour, formatCompactBytes, width),
      denseUsageBar("OUT/H", this.room.clankerOutputTokensLastHour, this.room.clankerOutputTokenLimit, formatCompactCount, width),
    ];
  }

  private dimInactiveHud(value: string): string {
    if (!this.sidebarFocused) return value;
    return `${DIM}${value.replaceAll(RESET, `${RESET}${DIM}`)}${RESET}`;
  }

  private sidebarRow(index: number, width: number): string {
    const itemIndex = index - 1;
    if (width <= 3) {
      if (itemIndex >= 0 && itemIndex < this.rooms.length) {
        const roomActive = !this.onCreateRoomScreen() && !this.accountFocused && itemIndex === this.roomIndex;
        return `${roomActive ? SIDEBAR_ACTIVE : SIDEBAR}${pad(roomActive ? " ● " : " · ", width)}${RESET}`;
      }
      if (this.roomCreationAvailable && itemIndex === this.rooms.length) return `${this.createRoomFocused ? SIDEBAR_ACTIVE : SIDEBAR}${pad(" + ", width)}${RESET}`;
      return `${SIDEBAR}${" ".repeat(width)}${RESET}`;
    }
    if (index === 0) return `${SIDEBAR_MUTED}${pad(truncate(this.sidebarFocused ? "  ROOMS  ^N new" : "  ROOMS", width), width)}${RESET}`;
    const hasCreate = this.roomCreationAvailable;
    if (hasCreate && itemIndex === this.rooms.length) {
      const style = this.createRoomFocused ? SIDEBAR_ACTIVE : SIDEBAR;
      return `${style}${pad(truncate("  + new room", width), width)}${RESET}`;
    }
    if (itemIndex >= 0 && itemIndex < this.rooms.length) {
      const style = !this.onCreateRoomScreen() && !this.accountFocused && itemIndex === this.roomIndex ? SIDEBAR_ACTIVE : SIDEBAR;
      const room = this.rooms[itemIndex]!;
      const detail = width >= 18 ? `${room.members.size} · ${room.policy.visibility}  ` : "";
      const labelWidth = Math.max(0, width - terminalWidth(detail));
      const label = pad(truncate(`  # ${room.name}`, labelWidth), labelWidth);
      return `${style}${label}${detail ? `${MUTED}${detail}${style}` : ""}${RESET}`;
    }
    return `${SIDEBAR}${" ".repeat(width)}${RESET}`;
  }

  private sidebarHeader(width: number): string {
    return width <= 3
      ? `${SIDEBAR_MUTED}${pad(" › ", width)}${RESET}`
      : `${SIDEBAR}${pad(truncate("  serverside.chat", width), width)}${RESET}`;
  }

  private sidebarFooter(width: number, createRoomScreen: boolean, deleteRoomScreen: boolean): string {
    if (createRoomScreen) return `${SIDEBAR}${pad(width <= 3 ? " + " : "  setup", width)}${RESET}`;
    if (deleteRoomScreen) return `${SIDEBAR}${pad(width <= 3 ? " ! " : "  archive", width)}${RESET}`;
    return width <= 3
      ? `${this.accountFocused ? SIDEBAR_ACTIVE : SIDEBAR}${pad(" @ ", width)}${RESET}`
      : `${this.accountFocused ? SIDEBAR_ACTIVE : SIDEBAR}${pad(truncate(`  @${this.username}`, width), width)}${RESET}`;
  }

  private formatMessage(message: Message, width: number, showAuthor: boolean): string[] {
    const time = message.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    const gutter = 9;
    const contentWidth = Math.max(1, width - gutter);
    const continuation = " ".repeat(gutter);
    const baseTone = message.kind === "system" ? CHAT_MUTED : CHAT;
    const timestamp = `  ${MUTED}${time}${baseTone}  `;
    const nameTone = message.author === "clanker" ? MAGENTA : message.author === this.room.owner ? OWNER : message.kind === "system" ? MUTED : CHAT;
    const displayAuthor = truncate(message.author, contentWidth);
    const styledName = `${ESC}1m${nameTone}${displayAuthor}${ESC}22m${baseTone}`;
    if (message.kind === "system" && message.author === "trunk") {
      return wrapLinkedChatText(message.text.replace(/\s+/g, " "), contentWidth, MUTED)
        .map((line, index) => `${CHAT}${index === 0 ? timestamp : continuation}${ESC}3m${MUTED}${line}${ESC}23m${CHAT_MUTED}`);
    }
    const authorRows = showAuthor ? [`${continuation}${styledName}`] : [];
    const replyRows = message.replyTo
      ? wrapLinkedChatText(`↳ @${message.replyTo.author}  ${message.replyTo.excerpt}`, contentWidth, MUTED).map((line) => `${continuation}${MUTED}${line}${baseTone}`)
      : [];
    if (message.kind === "commit" && message.url) {
      const [hash, ...title] = message.text.split(" ");
      const suffix = `${title.join(" ")}${message.detail ? ` — ${message.detail}` : ""}`;
      const contentRows = wrapLinkedChatText(`${hash} ${suffix}`, contentWidth, baseTone).map((line, index) => {
        const prefix = index === 0 ? timestamp : continuation;
        if (index !== 0 || !line.startsWith(hash)) return `${prefix}${ESC}3m${line}${ESC}23m${baseTone}`;
        return `${prefix}${ESC}3m\x1b]8;;${message.url}\x1b\\${ESC}24m${hash}\x1b]8;;\x1b\\${line.slice(hash.length)}${ESC}23m${baseTone}`;
      });
      return [...authorRows, ...replyRows, ...contentRows];
    }
    const contentRows = wrapLinkedChatText(message.text.replace(/\s+/g, " "), contentWidth, baseTone)
      .map((line, index) => `${index === 0 ? timestamp : continuation}${line}`);
    return [...authorRows, ...replyRows, ...contentRows];
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

  private ambientStatus(width: number): string {
    const typing = this.typingStatus(width).trim();
    const clanker = this.conciseClankerStatus();
    if (typing || this.clankerIsActive()) return truncate(`  ${[typing, clanker].filter(Boolean).join(" · ")}`, width);
    return this.anonymousLobbyStatus(width) || truncate(`  ${clanker}`, width);
  }

  private conciseClankerStatus(): string {
    const status = this.room.clankerState.status;
    if (this.room.policy.clankerMode === "disabled" || status === "disabled") return "clanker disabled";
    if (status === "queued" || status === "thinking" || status === "working") return `${SPINNER[Math.floor(Date.now() / 100) % SPINNER.length]} clanker ${status}`;
    if (status === "error") return "clanker error";
    return this.room.policy.clankerMode === "passive" ? "" : "clanker waits for /clanker";
  }

  private anonymousLobbyStatus(width: number): string {
    if (this.principal.authenticated || !this.accounts || !this.reviewAnonymousLobby || this.room.name !== "lobby") return "";
    return truncate("  anonymous · lobby messages are moderated · sign in to create rooms", width);
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
    this.accountPanel = undefined;
    this.roomSettings = undefined;
    this.mountPanel = undefined;
    this.shellPanel = false;
    this.write(`${this.mouseTracking ? "\x1b[?1006l\x1b[?1000l" : ""}\x1b[?25h\x1b[?1049l`);
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

  private orderedVisibleRooms(principal: Principal): Room[] {
    const visible = this.allRooms.filter((room) => room.canView(principal));
    const order = this.accounts?.roomOrder(principal) ?? [];
    if (!order.length) return visible;
    const rank = new Map(order.map((name, index) => [name, index]));
    return visible.map((room, index) => ({ room, index, rank: rank.get(room.name) }))
      .sort((left, right) => left.rank === undefined
        ? right.rank === undefined ? left.index - right.index : 1
        : right.rank === undefined ? -1 : left.rank - right.rank)
      .map(({ room }) => room);
  }

  private onCreateRoomScreen(): boolean {
    return this.createRoomFocused || this.creatingRoom;
  }

  private resetRoomCreationForm(): void {
    this.input = "";
    this.cursorOffset = 0;
    this.preferredCursorColumn = undefined;
    this.createRoomField = 0;
    this.createRoomVisibility = "public";
    this.createRoomContributions = "members";
    this.createRoomClankerMode = "passive";
    this.localNotice = "";
  }

  private beginRoomCreation(): void {
    const alreadyCreating = this.creatingRoom;
    this.createRoomFocused = false;
    this.creatingRoom = true;
    if (!alreadyCreating) this.createRoomField = 0;
    this.localNotice = "";
    this.messageCacheRoom = "";
    this.messageCache.clear();
  }

  private openRoomCreationShortcut(): void {
    if (this.input) {
      this.localNotice = "send or clear the current draft before creating a room";
      return;
    }
    if (!this.principal.authenticated || this.principal.kind !== "user") {
      this.localNotice = "sign in to create rooms";
      return;
    }
    if (!this.accounts || !this.directory) {
      this.localNotice = "room creation is unavailable";
      return;
    }
    this.roomCreationAvailable = this.computeRoomCreationAvailability();
    if (!this.roomCreationAvailable) {
      const profile = this.accounts.accountProfile(this.principal);
      this.localNotice = `room limit reached · ${profile.ownedRooms}/${profile.roomLimit}`;
      return;
    }
    this.room.setTyping(this.username, false);
    this.selectedMessageId = undefined;
    this.replyToMessageId = undefined;
    this.scrollOffset = 0;
    this.sidebarFocused = false;
    this.accountFocused = false;
    this.resetRoomCreationForm();
    this.beginRoomCreation();
    this.animateSidebar();
  }

  private deleteRoomFormRows(): string[] {
    const name = this.deletingRoomName ?? this.room.name;
    return [
      `  ${RED}${ESC}1mArchive #${name}?${ESC}22m${CHAT}`,
      "",
      `  ${CHAT}The website and chat will go offline immediately.`,
      `  ${CHAT}Source, versions, database, files, transcript, policy, and memberships are retained.`,
      `  ${MUTED}Invites and mount credentials are revoked rather than restored.${CHAT}`,
      "",
      `  ${YELLOW}Type the full room name to confirm.${CHAT}`,
      `  ${MUTED}Restore later with  /room restore ${name}${CHAT}`,
    ];
  }

  private cycleRoomCreationOption(direction: -1 | 1): void {
    if (this.createRoomField === 1) {
      const values: RoomVisibility[] = ["public", "private"];
      this.createRoomVisibility = cycle(values, this.createRoomVisibility, direction);
    } else if (this.createRoomField === 2) {
      const values: ContributionPolicy[] = ["members", "authenticated", "admins", "disabled"];
      this.createRoomContributions = cycle(values, this.createRoomContributions, direction);
    } else if (this.createRoomField === 3) {
      const values: ClankerMode[] = ["passive", "explicit", "disabled"];
      this.createRoomClankerMode = cycle(values, this.createRoomClankerMode, direction);
    }
  }

  private createRoomFormRows(): string[] {
    const visibility = this.createRoomVisibility === "public" ? "anyone can view" : "invitation required to view";
    const contributions = this.createRoomContributions === "members"
      ? "owner and invited contributors"
      : this.createRoomContributions === "authenticated" ? `${RED}DANGEROUS · any signed-in account can edit and invoke the clanker${CHAT}`
      : this.createRoomContributions === "admins" ? "owner and room admins only" : "read only";
    const clanker = this.createRoomClankerMode === "passive"
      ? "listens and acts when useful"
      : this.createRoomClankerMode === "explicit" ? "responds only to /clanker" : "no room clanker";
    const name = this.input || `${MUTED}required${CHAT}`;
    return [
      this.createRoomFormRow(0, "Name", name, "URL: serverside.chat/<name>"),
      this.createRoomFormRow(1, "Visibility", this.createRoomVisibility, visibility, true),
      this.createRoomFormRow(2, "Contributions", this.createRoomContributions === "admins" ? "admins only" : this.createRoomContributions, contributions, true),
      this.createRoomFormRow(3, "Clanker", this.createRoomClankerMode === "explicit" ? "/clanker only" : this.createRoomClankerMode, clanker, true),
      this.createRoomFormRow(4, "", "Create room", ""),
    ];
  }

  private createRoomFormRow(index: number, label: string, value: string, detail: string, adjustable = false): string {
    const focused = this.creatingRoom && this.createRoomField === index;
    const marker = focused ? `${CYAN}›${CHAT}` : `${MUTED}·${CHAT}`;
    const labelText = label ? `${focused ? CYAN : MUTED}${pad(label, 16)}${CHAT} ` : " ".repeat(17);
    const setting = index === 4
      ? `${focused ? `${CYAN}${ESC}1m` : MUTED}[ ${value} ]${ESC}22m${CHAT}`
      : `${adjustable ? `${MUTED}← ${CHAT}` : ""}${focused ? `${ESC}1m` : ""}${value}${focused ? `${ESC}22m` : ""}${adjustable ? `${MUTED} →${CHAT}` : ""}`;
    return `  ${marker} ${labelText}${setting}${detail ? `   ${MUTED}${detail}${CHAT}` : ""}`;
  }

  private adoptPrincipal(principal: Principal, preferredRoom: string): void {
    const oldUsername = this.username;
    this.unsubscribe();
    this.unsubscribeService();
    this.room.setTyping(oldUsername, false);
    this.room.leave(oldUsername);
    this.principal = principal;
    this.mountPanel = undefined;
    this.shellPanel = false;
    this.accountPanel = undefined;
    this.roomSettings = undefined;
    this.accountFocused = false;
    this.createRoomFocused = false;
    this.creatingRoom = false;
    this.deletingRoomName = undefined;
    this.rooms = this.orderedVisibleRooms(principal);
    if (!this.rooms.length) throw new Error("account cannot view any rooms");
    this.roomIndex = Math.max(0, this.rooms.findIndex((room) => room.name === preferredRoom));
    this.room = this.rooms[this.roomIndex]!;
    this.scrollOffset = 0;
    this.selectedMessageId = undefined;
    this.replyToMessageId = undefined;
    this.deleteConfirmationId = undefined;
    this.messageCacheRoom = "";
    this.messageCache.clear();
    this.unsubscribe = this.room.subscribe(() => this.scheduleRender());
    this.unsubscribeService = this.room.subscribeService(() => this.scheduleRender());
    this.room.join(this.username);
  }

  private refreshRooms(event: RoomDirectoryEvent): void {
    if (this.closed) return;
    const preferred = event.kind === "rename" && event.previousName === this.room.name ? event.name : this.room.name;
    const visible = this.orderedVisibleRooms(this.principal);
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
    this.accountPanel = undefined;
    this.roomSettings = undefined;
    this.accountFocused = false;
    this.createRoomFocused = false;
    this.creatingRoom = false;
    this.deletingRoomName = undefined;
    this.mountPanel = undefined;
    this.shellPanel = false;
    if (room === this.room) return;
    this.unsubscribe();
    this.unsubscribeService();
    this.room.setTyping(this.username, false);
    this.room.leave(this.username);
    this.room = room;
    this.write(`\x1b]777;room:${encodeURIComponent(room.name)}\x07`);
    this.roomIndex = Math.max(0, this.rooms.findIndex((candidate) => candidate === room));
    this.scrollOffset = 0;
    this.selectedMessageId = undefined;
    this.replyToMessageId = undefined;
    this.deleteConfirmationId = undefined;
    this.messageCacheRoom = "";
    this.messageCache.clear();
    this.unsubscribe = room.subscribe(() => this.scheduleRender());
    this.unsubscribeService = room.subscribeService(() => this.scheduleRender());
    room.join(this.username);
    this.render();
  }

  private clankerIsActive(): boolean {
    return this.room.clankerState.status === "queued" || this.room.clankerState.status === "thinking" || this.room.clankerState.status === "working";
  }

  private syncAnimation(): void {
    const animating = this.clankerIsActive() || Date.now() - this.room.lastRequestAt < 1_200;
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
    return Math.min(34, Math.max(24, Math.floor(this.width * 0.28)));
  }

  private animateSidebar(): void {
    if (this.sidebarAnimationTimer) return;
    this.sidebarAnimationTimer = setInterval(() => {
      const target = this.sidebarFocused ? this.expandedSidebarWidth() : 3;
      const delta = target - this.sidebarWidth;
      if (Math.abs(delta) <= 6) {
        this.sidebarWidth = target;
        clearInterval(this.sidebarAnimationTimer);
        this.sidebarAnimationTimer = undefined;
      } else {
        this.sidebarWidth += Math.sign(delta) * 6;
      }
      this.render();
    }, 30);
  }
}

function cycle<T>(values: readonly T[], current: T, direction: -1 | 1): T {
  const index = Math.max(0, values.indexOf(current));
  return values[(index + direction + values.length) % values.length]!;
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatCompactBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes}B`;
  if (bytes < 1_048_576) return `${Math.round(bytes / 1_024)}K`;
  const mib = bytes / 1_048_576;
  return `${Number.isInteger(mib) ? mib : mib.toFixed(1)}M`;
}

function formatCompactCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${Number((value / 1_000).toFixed(value < 10_000 ? 1 : 0))}K`;
  return `${Number((value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0))}M`;
}

function denseUsageBar(label: string, used: number, limit: number, format: (value: number) => string, width: number): string {
  const ratio = Math.max(0, Math.min(1, used / limit));
  const labelWidth = 7;
  const usage = `${format(used)}/${format(limit)}`;
  const barWidth = Math.max(4, width - 2 - labelWidth - 1 - 2 - terminalWidth(usage));
  const filled = Math.round(ratio * barWidth);
  const tone = ratio >= 0.9 ? RED : ratio >= 0.7 ? YELLOW : GREEN;
  const bar = `${tone}${"█".repeat(filled)}${MUTED}${"░".repeat(barWidth - filled)}${HUD}`;
  return `  ${pad(label, labelWidth)} ${bar}  ${usage}`;
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

export function renderServiceLog(value: string): string {
  const safe = value.replace(/[\r\n]/g, " ");
  const clankerError = safe.match(/^(\d{2}:\d{2}:\d{2}) CLANKER error (.*)$/);
  if (clankerError) return `  ${MUTED}${clankerError[1]}${HUD} ${CYAN}CLANKER ${RED}error${HUD} ${clankerError[2]}`;
  const request = safe.match(/^(\d{2}:\d{2}:\d{2}) (\d{3}) (.*)$/);
  if (request) {
    const status = Number(request[2]);
    const tone = status >= 500 ? RED : status >= 400 ? YELLOW : GREEN;
    return `  ${MUTED}${request[1]}${HUD} ${tone}${request[2]}${HUD} ${request[3]}`;
  }
  const timestamp = safe.match(/^(\d{2}:\d{2}:\d{2}) (.*)$/);
  return timestamp ? `  ${MUTED}${timestamp[1]}${HUD} ${timestamp[2]}` : `  ${safe}`;
}

function renderClankerErrorLog(value: string): string {
  return renderServiceLog(value.replace(/^(\d{2}:\d{2}:\d{2}) CLANKER error /, "$1 "));
}

function rightAlignedLogSlots(logs: string[], capacity: number, render = renderServiceLog): string[] {
  if (capacity <= 0) return [];
  const visible = logs.slice(-capacity).map(render);
  return [...Array<string>(capacity - visible.length).fill(""), ...visible];
}

function renderSlashCommand(command: SlashCommand, selected: boolean, width: number): string {
  const style = selected ? COMMAND_ACTIVE : COMMAND;
  const marker = ` ${selected ? "›" : " "} `;
  const usageWidth = Math.min(32, Math.max(12, Math.floor(width * 0.42)));
  const usage = pad(truncate(command.usage, usageWidth), usageWidth);
  const descriptionWidth = Math.max(0, width - terminalWidth(marker) - usageWidth - 1);
  const description = truncate(command.description, descriptionWidth);
  return padAnsi(`${selected ? YELLOW : MUTED}${marker}${CYAN}${usage}${style} ${MUTED}${description}`, width);
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

export function linkifyChatUrls(value: string, restoreTone = CHAT): string {
  return renderChatUrlSpans(value, 0, chatUrlSpans(value), restoreTone);
}

function wrapLinkedChatText(value: string, width: number, restoreTone: string): string[] {
  const spans = chatUrlSpans(value);
  let cursor = 0;
  return wrap(value, width).map((line) => {
    const origin = value.indexOf(line, cursor);
    if (origin < 0) return linkifyChatUrls(line, restoreTone);
    cursor = origin + line.length;
    return renderChatUrlSpans(line, origin, spans, restoreTone);
  });
}

interface ChatUrlSpan { start: number; end: number; url: string }

function chatUrlSpans(value: string): ChatUrlSpan[] {
  const spans: ChatUrlSpan[] = [];
  for (const match of value.matchAll(/https?:\/\/[^\s<>"'`\x00-\x1f\x7f]+/gi)) {
    if (match.index === undefined) continue;
    const url = trimUrlPunctuation(match[0]);
    if (url && validChatUrl(url)) spans.push({ start: match.index, end: match.index + url.length, url });
  }
  return spans;
}

function renderChatUrlSpans(value: string, origin: number, spans: ChatUrlSpan[], restoreTone: string): string {
  let output = "";
  let cursor = 0;
  const rowEnd = origin + value.length;
  for (const span of spans) {
    const start = Math.max(origin, span.start);
    const end = Math.min(rowEnd, span.end);
    if (start >= end) continue;
    const localStart = start - origin;
    const localEnd = end - origin;
    output += value.slice(cursor, localStart);
    output += `${CYAN}\x1b]8;;${span.url}\x1b\\${value.slice(localStart, localEnd)}\x1b]8;;\x1b\\${restoreTone}`;
    cursor = localEnd;
  }
  return `${output}${value.slice(cursor)}`;
}

function trimUrlPunctuation(value: string): string {
  let result = value.replace(/[.,!?;:]+$/g, "");
  const pairs: Array<[string, string]> = [["(", ")"], ["[", "]"], ["{", "}"]];
  let changed = true;
  while (changed && result) {
    changed = false;
    for (const [open, close] of pairs) {
      if (!result.endsWith(close)) continue;
      const opens = result.split(open).length - 1;
      const closes = result.split(close).length - 1;
      if (closes > opens) { result = result.slice(0, -1); changed = true; }
    }
  }
  return result;
}

function validChatUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch { return false; }
}

function padAnsi(value: string, width: number): string {
  const clipped = clipAnsi(value, width);
  return clipped + " ".repeat(Math.max(0, width - visibleLength(clipped)));
}

function centerAnsi(value: string, width: number): string {
  const clipped = clipAnsi(value, width);
  const remaining = Math.max(0, width - visibleLength(clipped));
  const left = Math.floor(remaining / 2);
  return `${" ".repeat(left)}${clipped}${" ".repeat(remaining - left)}`;
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
