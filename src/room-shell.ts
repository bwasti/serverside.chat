import type { AccountStore, Principal } from "./auth";
import { posix } from "node:path";
import type { Room } from "./room";
import { MAX_WORKSPACE_FILE_BYTES, MAX_WORKSPACE_BYTES, type RoomWorkspace } from "./workspace";
import { RoomEditor, type EditorSaveResult } from "./editor";

export interface RoomShellStream {
  readonly destroyed: boolean;
  write(value: string): boolean;
  end(value?: string): void;
  exit?(status: number): void;
  on(event: "data", listener: (data: Buffer) => void): unknown;
  on(event: "close" | "end", listener: () => void): unknown;
}

export interface CapabilityResult {
  output?: string;
  close?: boolean;
  clear?: boolean;
  write?: { path: string; expectedRevision: string | null };
  editor?: RoomEditor;
}

const MAX_COMMAND_BYTES = 2_048;
const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const CYAN = `${ESC}38;5;45m`;
const GREEN = `${ESC}38;5;82m`;
const MUTED = `${ESC}38;5;244m`;

/** Host-owned capabilities used by the terminal adapter. No input reaches a system shell. */
export class RoomCapabilitySession {
  private cwd = "";

  constructor(
    readonly principal: Principal,
    readonly room: Room,
    readonly workspace: RoomWorkspace,
    private readonly accounts: AccountStore,
  ) {
    if (!principal.authenticated || principal.kind !== "user") throw new Error("sign in and link this SSH key before opening a room shell");
    if (!accounts.canView(principal, room.name)) throw new Error("that room does not exist or is not visible to this account");
  }

  execute(line: string): CapabilityResult {
    if (Buffer.byteLength(line) > MAX_COMMAND_BYTES) throw new Error("command exceeds 2 KiB limit");
    const [command = "", remainder = ""] = splitCommand(line);
    switch (command) {
      case "": return {};
      case "help": return { output: HELP };
      case "exit": case "quit": return { close: true };
      case "clear": return { clear: true };
      case "pwd": return { output: this.workingDirectory };
      case "cd": return { output: this.changeDirectory(remainder) };
      case "whoami": return { output: `@${this.principal.handle} · ${this.accounts.roleFor(this.principal, this.room.name) ?? "viewer"} · ${this.room.name}` };
      case "limits": return { output: `source ${formatBytes(this.workspace.listTree().reduce((sum, file) => sum + file.bytes, 0))}/${formatBytes(MAX_WORKSPACE_BYTES)} · file ${formatBytes(MAX_WORKSPACE_FILE_BYTES)} max · 1,000 entries` };
      case "files": return { output: this.list(optionalArgument(remainder, "usage: files [path]"), true, true) };
      case "ls": return { output: this.ls(remainder, false) };
      case "ll": return { output: this.ls(remainder, true) };
      case "tree": return { output: this.tree(optionalArgument(remainder, "usage: tree [path]")) };
      case "cat": return { output: this.workspace.readFile(this.pathArgument(remainder, "usage: cat <path>")) };
      case "head": return { output: this.fileWindow(remainder, "head") };
      case "tail": return { output: this.fileWindow(remainder, "tail") };
      case "wc": return { output: this.wordCount(remainder) };
      case "stat": return { output: this.fileStat(remainder) };
      case "edit": return { editor: this.openEditor(this.pathArgument(remainder, "usage: edit <path>")) };
      case "status": return { output: this.workspace.status().trimEnd() || "clean" };
      case "diff": return { output: this.workspace.diff().trimEnd() || "no changes" };
      case "history": case "log": return { output: this.workspace.log().trimEnd() };
      case "versions": return { output: this.workspace.versionGraph(12).join("\n") };
      case "write": {
        this.requireWrite();
        const path = this.pathArgument(remainder, "usage: write <path>");
        const revision = this.workspace.fileRevision(path);
        return { output: "enter replacement text; finish with .save on its own line or cancel with .abort", write: { path, expectedRevision: revision } };
      }
      case "mkdir": {
        this.requireWrite();
        const path = this.pathArgument(remainder, "usage: mkdir <path>");
        this.workspace.createDirectory(path);
        this.audit("source.mkdir", path);
        return { output: `created ${path}` };
      }
      case "rm": {
        this.requireWrite();
        const path = this.pathArgument(remainder, "usage: rm <path>");
        this.workspace.deleteFile(path);
        this.audit("source.remove", path);
        return { output: `removed ${path}` };
      }
      case "rmdir": {
        this.requireWrite();
        const path = this.pathArgument(remainder, "usage: rmdir <empty-directory>");
        this.workspace.removeDirectory(path);
        this.audit("source.rmdir", path);
        return { output: `removed ${path}` };
      }
      case "mv": {
        this.requireWrite();
        const [from, to, extra] = parseArguments(remainder);
        if (!from || !to || extra) throw new Error("usage: mv <old-path> <new-path>");
        const source = this.resolvePath(from);
        const target = this.resolvePath(to);
        this.workspace.renamePath(source, target);
        this.audit("source.rename", `${source} -> ${target}`);
        return { output: `renamed ${this.displayPath(source)} -> ${this.displayPath(target)}` };
      }
      case "touch": {
        this.requireWrite();
        const path = this.pathArgument(remainder, "usage: touch <path>");
        const revision = this.workspace.fileRevision(path);
        const content = revision === null ? Buffer.alloc(0) : this.workspace.readFileBytes(path);
        this.workspace.writeFileBytes(path, content, revision);
        this.audit("source.touch", path);
        return {};
      }
      case "cp": {
        this.requireWrite();
        const [from, to, extra] = parseArguments(remainder);
        if (!from || !to || extra) throw new Error("usage: cp <source> <destination>");
        const source = this.resolvePath(from);
        const target = this.resolvePath(to);
        const content = this.workspace.readFileBytes(source);
        const revision = this.workspace.fileRevision(target);
        this.workspace.writeFileBytes(target, content, revision);
        this.audit("source.copy", `${source} -> ${target}`);
        return { output: `copied ${this.displayPath(source)} -> ${this.displayPath(target)}` };
      }
      case "commit": {
        this.requireWrite();
        const title = freeText(remainder, "usage: commit <title>");
        const result = this.workspace.commitAs(title, "", this.principal.displayName, `${this.principal.handle}@users.serverside.chat`);
        this.refreshVersions();
        const url = `${this.room.pageUrl}?__ref=${result.commit}`;
        this.room.recordContributorCommit(this.principal, result.commit, result.title, result.blurb, url);
        this.audit("version.commit", result.commit);
        return { output: `${result.commit} ${result.title}\n${url}` };
      }
      case "preview": {
        this.requireWrite();
        const preview = this.workspace.createPreview(freeText(remainder, "usage: preview <description>"));
        const url = `${this.room.pageUrl}?__ref=${preview.id}`;
        this.room.addAgentLink(preview.description, url);
        this.refreshVersions();
        this.audit("version.preview", preview.id);
        return { output: `${preview.id} ${preview.description}\n${url}` };
      }
      case "archive": {
        this.requireWrite();
        const result = this.workspace.archivePreview(oneArgument(remainder, "usage: archive <preview-id>"));
        this.refreshVersions();
        this.audit("version.archive", result.id);
        return { output: `archived ${result.id}; its commit remains addressable` };
      }
      case "publish": {
        if (!this.accounts.canPromote(this.principal, this.room.name)) throw new Error("only the room owner can publish canonical");
        const result = this.workspace.promotePreview(oneArgument(remainder, "usage: publish <preview-id>"));
        this.refreshVersions();
        this.room.recordCanonicalUpdate(this.principal, result.commit, this.room.pageUrl);
        this.audit("version.publish", result.commit);
        return { output: `${result.commit} is now stable\n${this.room.pageUrl}` };
      }
      case "rebase": {
        this.requireWrite();
        const result = this.workspace.rebaseOntoStable();
        this.refreshVersions();
        this.audit("version.rebase", result.completed ? result.head ?? "complete" : "conflict");
        return { output: result.completed ? `rebased onto ${result.base}` : `conflicts require resolution\n${result.conflicts ?? ""}`.trimEnd() };
      }
      case "rebase-continue": {
        this.requireWrite();
        const result = this.workspace.continueRebase();
        this.refreshVersions();
        this.audit("version.rebase-continue", result.completed ? result.head ?? "complete" : "conflict");
        return { output: result.completed ? `rebase complete at ${result.head}` : `conflicts remain\n${result.conflicts ?? ""}`.trimEnd() };
      }
      case "rebase-abort": {
        this.requireWrite();
        this.workspace.abortRebase();
        this.refreshVersions();
        this.audit("version.rebase-abort");
        return { output: "rebase aborted" };
      }
      default: throw new Error(`unknown command: ${command}; try help`);
    }
  }

  saveText(path: string, text: string, expectedRevision: string | null): string {
    this.requireWrite();
    const result = this.workspace.writeFileBytes(path, Buffer.from(text), expectedRevision);
    this.audit("source.write", `${path} ${result.bytes}B`);
    return `wrote ${path} · ${result.bytes} bytes`;
  }

  private openEditor(path: string): RoomEditor {
    const revision = this.workspace.fileRevision(path);
    if (revision === null && !this.accounts.canEditSource(this.principal, this.room.name)) throw new Error("file not found");
    const content = revision === null ? Buffer.alloc(0) : this.workspace.readFileBytes(path);
    return new RoomEditor(path, content, revision, {
      readOnly: !this.accounts.canEditSource(this.principal, this.room.name),
      save: (bytes, expected) => this.saveEditor(path, bytes, expected),
      preview: (bytes, expected) => this.previewEditor(path, bytes, expected),
    });
  }

  private saveEditor(path: string, content: Buffer, expectedRevision: string | null): EditorSaveResult {
    this.requireWrite();
    const result = this.workspace.writeFileBytes(path, content, expectedRevision);
    this.audit("source.editor-save", `${path} ${result.bytes}B`);
    return { revision: result.revision, message: `saved ${this.displayPath(path)} · ${result.bytes}B` };
  }

  private previewEditor(path: string, content: Buffer, expectedRevision: string | null): EditorSaveResult {
    const saved = this.saveEditor(path, content, expectedRevision);
    if (this.workspace.hasChanges()) {
      const title = `Edit ${posix.basename(path)}`;
      const commit = this.workspace.commitAs(title, `Updated ${this.displayPath(path)} in the shared room editor.`, this.principal.displayName, `${this.principal.handle}@users.serverside.chat`);
      this.room.recordContributorCommit(this.principal, commit.commit, commit.title, commit.blurb, `${this.room.pageUrl}?__ref=${commit.commit}`);
      this.audit("version.commit", commit.commit);
    }
    const preview = this.workspace.createPreview(`Edit ${posix.basename(path)}`);
    const url = `${this.room.pageUrl}?__ref=${preview.id}`;
    this.room.addAgentLink(preview.description, url);
    this.refreshVersions();
    this.audit("version.preview", preview.id);
    return { revision: saved.revision, message: `preview ${preview.id} · ${url}` };
  }

  get workingDirectory(): string { return this.cwd ? `/${this.cwd}` : "/"; }

  promptText(): string { return `${this.room.name}:${this.workingDirectory} ${this.workspace.headCommit()}> `; }

  private changeDirectory(value: string): string {
    const input = value.trim() ? oneArgument(value, "usage: cd [path]") : "/";
    const target = this.resolvePath(input, true);
    if (target) {
      const info = this.workspace.stat(target);
      if (info.kind !== "directory") throw new Error("not a directory");
    }
    this.cwd = target;
    return this.workingDirectory;
  }

  private ls(value: string, forceLong: boolean): string {
    const args = parseArguments(value);
    let long = forceLong;
    let all = false;
    let path = "";
    let options = true;
    for (const argument of args) {
      if (options && argument === "--") { options = false; continue; }
      if (options && argument.startsWith("-") && argument !== "-") {
        for (const flag of argument.slice(1)) {
          if (flag === "l") long = true;
          else if (flag === "a") all = true;
          else throw new Error(`ls: unsupported option -${flag}`);
        }
      } else if (!path) path = argument;
      else throw new Error("usage: ls [-la] [path]");
    }
    return this.list(path, long, all);
  }

  private list(path: string, long: boolean, all: boolean): string {
    const base = this.resolvePath(path || ".", true);
    const entries = this.workspace.listDirectory(base);
    const visible = all ? entries : entries.filter((entry) => !entry.name.startsWith("."));
    if (!visible.length) return "empty directory";
    return visible.map((entry) => long
      ? `${entry.kind === "directory" ? "d" : "-"} ${String(entry.bytes).padStart(7)}  ${entry.name}${entry.kind === "directory" ? "/" : ""}`
      : `${entry.name}${entry.kind === "directory" ? "/" : ""}`).join("\n");
  }

  private tree(path: string): string {
    const base = this.resolvePath(path || ".", true);
    const output = [this.displayPath(base)];
    let count = 0;
    let limited = false;
    const walk = (directory: string, prefix: string, depth: number) => {
      if (limited) return;
      if (depth > 20) { output.push(`${prefix}… depth limit`); return; }
      const entries = this.workspace.listDirectory(directory);
      for (let index = 0; index < entries.length; index++) {
        if (count++ >= 200) { output.push(`${prefix}… output limited to 200 entries`); limited = true; return; }
        const entry = entries[index]!;
        const last = index === entries.length - 1;
        output.push(`${prefix}${last ? "└──" : "├──"} ${entry.name}${entry.kind === "directory" ? "/" : ""}`);
        if (entry.kind === "directory") walk(posix.join(directory, entry.name), `${prefix}${last ? "    " : "│   "}`, depth + 1);
      }
    };
    walk(base, "", 0);
    return output.join("\n");
  }

  private fileWindow(value: string, direction: "head" | "tail"): string {
    const args = parseArguments(value);
    let lines = 10;
    if (args[0] === "-n") {
      const parsed = Number(args[1]);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) throw new Error(`usage: ${direction} [-n 1..200] <path>`);
      lines = parsed;
      args.splice(0, 2);
    }
    if (args.length !== 1) throw new Error(`usage: ${direction} [-n 1..200] <path>`);
    const content = this.workspace.readFile(this.resolvePath(args[0]!));
    const parts = content.split("\n");
    return (direction === "head" ? parts.slice(0, lines) : parts.slice(-lines)).join("\n");
  }

  private wordCount(value: string): string {
    const path = this.pathArgument(value, "usage: wc <path>");
    const content = this.workspace.readFileBytes(path);
    const text = content.toString("utf8");
    const lines = (text.match(/\n/g) ?? []).length;
    const words = text.trim() ? text.trim().split(/\s+/u).length : 0;
    return `${lines} ${words} ${content.length} ${this.displayPath(path)}`;
  }

  private fileStat(value: string): string {
    const path = this.pathArgument(value, "usage: stat <path>", true);
    const info = this.workspace.stat(path);
    return `${info.kind} ${info.bytes}B ${new Date(info.modifiedAt).toISOString()} ${this.displayPath(path)}`;
  }

  private pathArgument(value: string, usage: string, allowRoot = false): string {
    return this.resolvePath(oneArgument(value, usage), allowRoot);
  }

  private resolvePath(value: string, allowRoot = false): string {
    const absolute = posix.resolve("/", this.cwd, value || ".");
    const relative = absolute === "/" ? "" : absolute.slice(1);
    if (!relative && !allowRoot) throw new Error("operation is not permitted on the room root");
    return relative;
  }

  private displayPath(path: string): string { return path ? `/${path}` : "/"; }

  private requireWrite(): void {
    if (!this.accounts.canEditSource(this.principal, this.room.name)) throw new Error("this account has read-only access to the room source");
  }

  private refreshVersions(): void { this.room.setVersionGraph(this.workspace.versionGraph()); }
  private audit(action: string, target = ""): void { this.accounts.audit(this.principal, this.room.name, action, target); }
}

export class RoomShellSession {
  private input: string[] = [];
  private cursor = 0;
  private history: string[] = [];
  private historyIndex = 0;
  private closed = false;
  private lastWasCarriageReturn = false;
  private editor?: RoomEditor;
  private width = 80;
  private height = 24;
  private writeMode?: { path: string; expectedRevision: string | null; lines: string[]; bytes: number };

  constructor(private readonly stream: RoomShellStream, private readonly capabilities: RoomCapabilitySession) {
    stream.on("data", (data: Buffer) => this.onData(data));
    stream.on("close", () => { this.closed = true; });
    stream.on("end", () => { this.closed = true; });
    this.write(`${CYAN}serverside.chat${RESET} capability shell · ${capabilities.room.name}\r\n${MUTED}host files and Git metadata are not exposed · help lists commands${RESET}\r\n`);
    this.prompt();
  }

  private onData(data: Buffer): void {
    if (this.editor) {
      const action = this.editor.handleData(data);
      if (action.closed) {
        this.editor = undefined;
        this.write("\x1b[2J\x1b[H");
        if (action.notice) this.output(action.notice);
        this.prompt();
      } else this.renderEditor();
      return;
    }
    const tokens = data.toString("utf8").match(/\x1b(?:\[[0-?]*[ -/]*[@-~]|O[HF]|[^\x1b])|[^\x1b]+/gs) ?? [];
    for (const token of tokens) {
      if (token.startsWith("\x1b")) { this.escape(token); continue; }
      for (const char of token) {
        if (char === "\x03") { this.input = []; this.cursor = 0; this.write("^C\r\n"); this.prompt(); continue; }
        if (char === "\x04" && !this.input.length) { this.close(); return; }
        if (char === "\r" || char === "\n") {
          if (char === "\n" && this.lastWasCarriageReturn) { this.lastWasCarriageReturn = false; continue; }
          this.lastWasCarriageReturn = char === "\r";
          this.submit();
          continue;
        }
        this.lastWasCarriageReturn = false;
        if (char === "\x7f" || char === "\b") { if (this.cursor > 0) { this.input.splice(--this.cursor, 1); this.redraw(); } continue; }
        if (char === "\x01") { this.cursor = 0; this.redraw(); continue; }
        if (char === "\x05") { this.cursor = this.input.length; this.redraw(); continue; }
        if (char === "\x02") { this.cursor = Math.max(0, this.cursor - 1); this.redraw(); continue; }
        if (char === "\x06") { this.cursor = Math.min(this.input.length, this.cursor + 1); this.redraw(); continue; }
        if (char === "\x15") { this.input.splice(0, this.cursor); this.cursor = 0; this.redraw(); continue; }
        if (char === "\x0b") { this.input.splice(this.cursor); this.redraw(); continue; }
        if (char === "\x17") { this.deleteWord(); this.redraw(); continue; }
        if (/[^\x00-\x1f\x7f]/u.test(char) && Buffer.byteLength(this.input.join("") + char) <= MAX_COMMAND_BYTES) {
          this.input.splice(this.cursor++, 0, char);
          this.redraw();
        }
      }
    }
  }

  private escape(sequence: string): void {
    const direction = sequence.match(/^\x1b\[(?:1;[2-8])?([ABCD])$/)?.[1];
    if (direction === "C") this.cursor = Math.min(this.input.length, this.cursor + 1);
    else if (direction === "D") this.cursor = Math.max(0, this.cursor - 1);
    else if (direction === "A") this.recall(-1);
    else if (direction === "B") this.recall(1);
    else if (/^\x1b(?:\[(?:H|1~|7~)|OH)$/.test(sequence)) this.cursor = 0;
    else if (/^\x1b(?:\[(?:F|4~|8~)|OF)$/.test(sequence)) this.cursor = this.input.length;
    else if (sequence === "\x1b[3~" && this.cursor < this.input.length) this.input.splice(this.cursor, 1);
    this.redraw();
  }

  private submit(): void {
    const line = this.input.join("");
    this.input = [];
    this.cursor = 0;
    this.write("\r\n");
    if (this.writeMode) {
      if (line === ".abort") {
        this.writeMode = undefined;
        this.write(`${MUTED}write cancelled${RESET}\r\n`);
      } else if (line === ".save") {
        const pending = this.writeMode;
        this.writeMode = undefined;
        try { this.output(this.capabilities.saveText(pending.path, pending.lines.join("\n"), pending.expectedRevision)); }
        catch (error) { this.error(error); }
      } else {
        const nextBytes = this.writeMode.bytes + Buffer.byteLength(line) + (this.writeMode.lines.length ? 1 : 0);
        if (nextBytes > MAX_WORKSPACE_FILE_BYTES) this.error(new Error("file exceeds 512 KiB limit"));
        else { this.writeMode.lines.push(line); this.writeMode.bytes = nextBytes; }
      }
      this.prompt();
      return;
    }
    if (line.trim()) {
      this.history.push(line);
      if (this.history.length > 100) this.history.shift();
      this.historyIndex = this.history.length;
    }
    try {
      const result = this.capabilities.execute(line);
      if (result.close) { this.close(); return; }
      if (result.clear) this.write("\x1b[2J\x1b[H");
      if (result.output) this.output(result.output);
      if (result.write) this.writeMode = { ...result.write, lines: [], bytes: 0 };
      if (result.editor) { this.editor = result.editor; this.renderEditor(); return; }
    } catch (error) { this.error(error); }
    this.prompt();
  }

  private recall(offset: number): void {
    if (!this.history.length) return;
    this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + offset));
    this.input = Array.from(this.history[this.historyIndex] ?? "");
    this.cursor = this.input.length;
  }

  private deleteWord(): void {
    while (this.cursor > 0 && /\s/u.test(this.input[this.cursor - 1]!)) this.input.splice(--this.cursor, 1);
    while (this.cursor > 0 && !/\s/u.test(this.input[this.cursor - 1]!)) this.input.splice(--this.cursor, 1);
  }

  private promptText(): string { return this.writeMode ? `${this.writeMode.path}> ` : this.capabilities.promptText(); }
  private prompt(): void { if (!this.closed) this.write(`${GREEN}${this.promptText()}${RESET}`); }
  private redraw(): void {
    if (this.closed) return;
    const prompt = this.promptText();
    const text = safeTerminalText(this.input.join(""));
    const tail = this.input.length - this.cursor;
    this.write(`\r\x1b[2K${GREEN}${prompt}${RESET}${text}${tail ? `\x1b[${tail}D` : ""}`);
  }
  private output(value: string): void { this.write(`${safeTerminalText(value).replaceAll("\n", "\r\n")}\r\n`); }
  private error(error: unknown): void { this.write(`${ESC}38;5;203m${safeTerminalText(error instanceof Error ? error.message : "command failed")}${RESET}\r\n`); }
  private write(value: string): void { if (!this.closed && !this.stream.destroyed) this.stream.write(value); }
  resize(width: number, height: number): void {
    this.width = Math.max(30, width || 80);
    this.height = Math.max(8, height || 24);
    if (this.editor) this.renderEditor();
  }
  private renderEditor(): void { if (this.editor) this.write(`\x1b[?25l\x1b[H\x1b[2J${this.editor.render(this.width, this.height)}`); }
  private close(): void {
    if (!this.closed) {
      this.closed = true;
      this.stream.exit?.(0);
      this.stream.end("\r\n");
    }
  }
}

function splitCommand(value: string): [string, string] {
  const match = value.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
  return match ? [match[1]!.toLowerCase(), match[2] ?? ""] : ["", ""];
}

export function parseArguments(value: string): string[] {
  const output: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  let active = false;
  for (const char of value.trim()) {
    if (escaped) { current += char; escaped = false; active = true; continue; }
    if (char === "\\") { escaped = true; active = true; continue; }
    if (quote) { if (char === quote) quote = ""; else current += char; active = true; continue; }
    if (char === "\"" || char === "'") { quote = char; active = true; continue; }
    if (/\s/u.test(char)) { if (active) { output.push(current); current = ""; active = false; } continue; }
    current += char;
    active = true;
  }
  if (escaped || quote) throw new Error("unfinished quote or escape");
  if (active) output.push(current);
  return output;
}

function oneArgument(value: string, usage: string): string {
  const args = parseArguments(value);
  if (args.length !== 1) throw new Error(usage);
  return args[0]!;
}

function optionalArgument(value: string, usage: string): string {
  if (!value.trim()) return "";
  return oneArgument(value, usage);
}

function freeText(value: string, usage: string): string {
  const args = parseArguments(value);
  if (!args.length) throw new Error(usage);
  return args.join(" ");
}

function safeTerminalText(value: string): string {
  return value.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|.)/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function formatBytes(value: number): string { return value < 1024 ? `${value}B` : `${(value / (1024 * 1024)).toFixed(1)}MiB`; }

const HELP = `filesystem
  pwd                       show the virtual working directory
  cd [path]                 change virtual working directory
  ls [-la] [path]           list a directory (ll is ls -l)
  files [path]              detailed directory listing
  tree [path]               show up to 200 entries
  cat <path>                read a text file
  head [-n count] <path>    read the first lines
  tail [-n count] <path>    read the last lines
  wc <path>                 line, word, and byte counts
  stat <path>               show virtual metadata
  edit <path>               open the reusable Wasm editor
  write <path>              replace a text file; .save or .abort
  touch <path>              create an empty file
  cp <source> <destination> copy a file
  mkdir <path>              create a directory
  rm <path>                 remove a file
  rmdir <path>              remove an empty directory
  mv <old> <new>            rename an entry (quote paths with spaces)

versions
  status                    working-tree status
  diff                      uncommitted changes
  history                   recent commits
  versions                  concise version graph
  commit <title>            commit the shared working tree
  preview <description>     create an immutable preview URL
  archive <preview-id>      hide a preview without deleting it
  rebase                    rebase the current stack onto stable
  rebase-continue           continue after resolving conflicts
  rebase-abort              abandon an in-progress rebase
  publish <preview-id>      owner-only stable promotion

session
  whoami  limits  clear  exit

This is a capability shell: pipes, expansion, programs, and arbitrary host paths do not exist.`;
