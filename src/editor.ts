import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { MAX_WORKSPACE_FILE_BYTES } from "./workspace";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const HEADER = `${ESC}48;5;236m${ESC}38;5;188m`;
const FOOTER = `${ESC}48;5;239m${ESC}38;5;188m`;
const GUTTER = `${ESC}48;5;235m${ESC}38;5;102m`;
const TEXT = `${ESC}48;5;237m${ESC}38;5;188m`;
const CYAN = `${ESC}38;5;116m`;
const GREEN = `${ESC}38;5;108m`;
const YELLOW = `${ESC}38;5;223m`;
const MAGENTA = `${ESC}38;5;176m`;
const COMMENT = `${ESC}38;5;102m`;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const coreModule = new WebAssembly.Module(readFileSync(new URL("./editor-core.wasm", import.meta.url)));

interface EditorCoreExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  capacity(): number;
  scratch(): number;
  initialize(length: number): number;
  length(): number;
  cursor(): number;
  set_cursor(position: number): void;
  left(): void;
  right(): void;
  line_start(): void;
  line_end(): void;
  insert(source: number, count: number): number;
  backspace(): number;
  delete(): number;
}

export interface EditorSaveResult { revision: string; message: string }
export interface EditorHost {
  readonly readOnly: boolean;
  save(content: Buffer, expectedRevision: string | null): EditorSaveResult;
  preview(content: Buffer, expectedRevision: string | null): EditorSaveResult;
}
export interface EditorAction { closed?: boolean; notice?: string }

export class WasmTextBuffer {
  private readonly core: EditorCoreExports;

  constructor(content: Buffer) {
    if (content.length > MAX_WORKSPACE_FILE_BYTES) throw new Error("file exceeds 512 KiB editor limit");
    decoder.decode(content);
    this.core = new WebAssembly.Instance(coreModule).exports as EditorCoreExports;
    new Uint8Array(this.core.memory.buffer, 0, content.length).set(content);
    if (!this.core.initialize(content.length)) throw new Error("unable to initialize editor buffer");
  }

  get length(): number { return this.core.length(); }
  get cursor(): number { return this.core.cursor(); }
  set cursor(position: number) { this.core.set_cursor(position); }
  get bytes(): Buffer { return Buffer.from(new Uint8Array(this.core.memory.buffer, 0, this.length)); }
  get text(): string { return decoder.decode(new Uint8Array(this.core.memory.buffer, 0, this.length)); }
  get prefix(): string { return decoder.decode(new Uint8Array(this.core.memory.buffer, 0, this.cursor)); }

  insert(value: string): boolean {
    const bytes = encoder.encode(value);
    if (this.length + bytes.length > this.core.capacity()) return false;
    const scratch = this.core.scratch();
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
      const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + 64 * 1024));
      new Uint8Array(this.core.memory.buffer, scratch, chunk.length).set(chunk);
      if (!this.core.insert(scratch, chunk.length)) return false;
    }
    return true;
  }

  left(): void { this.core.left(); }
  right(): void { this.core.right(); }
  lineStart(): void { this.core.line_start(); }
  lineEnd(): void { this.core.line_end(); }
  backspace(): boolean { return Boolean(this.core.backspace()); }
  delete(): boolean { return Boolean(this.core.delete()); }
}

export class RoomEditor {
  private readonly buffer: WasmTextBuffer;
  private expectedRevision: string | null;
  private dirty = false;
  private viewportLine = 0;
  private horizontalOffset = 0;
  private preferredColumn?: number;
  private status = "Wasm buffer · UTF-8";
  private quitArmed = false;
  private width = 80;
  private height = 24;
  private lastWasCarriageReturn = false;

  constructor(readonly path: string, content: Buffer, expectedRevision: string | null, private readonly host: EditorHost) {
    this.buffer = new WasmTextBuffer(content);
    this.expectedRevision = expectedRevision;
  }

  handleData(data: Buffer): EditorAction {
    const tokens = data.toString("utf8").match(/\x1b(?:\[[0-?]*[ -/]*[@-~]|O[HF]|[^\x1b])|[^\x1b]+/gs) ?? [];
    for (const token of tokens) {
      if (token.startsWith("\x1b")) { this.handleEscape(token); continue; }
      for (const char of token) {
        if (char === "\x11") {
          if (this.dirty && !this.quitArmed) { this.quitArmed = true; this.status = "unsaved changes · Ctrl-Q again to discard"; continue; }
          return { closed: true, notice: this.dirty ? "discarded unsaved editor changes" : this.status };
        }
        if (char === "\x13") { this.save(); continue; }
        if (char === "\x10") { this.preview(); continue; }
        if (char === "\x01") { this.buffer.lineStart(); this.preferredColumn = undefined; continue; }
        if (char === "\x05") { this.buffer.lineEnd(); this.preferredColumn = undefined; continue; }
        if (char === "\x02") { this.buffer.left(); this.preferredColumn = undefined; continue; }
        if (char === "\x06") { this.buffer.right(); this.preferredColumn = undefined; continue; }
        if (char === "\x7f" || char === "\b") { this.mutate(() => this.buffer.backspace()); continue; }
        if (char === "\r" || char === "\n") {
          if (char === "\n" && this.lastWasCarriageReturn) { this.lastWasCarriageReturn = false; continue; }
          this.lastWasCarriageReturn = char === "\r";
          this.mutate(() => this.buffer.insert("\n"));
          continue;
        }
        this.lastWasCarriageReturn = false;
        if (char === "\t") { this.mutate(() => this.buffer.insert("  ")); continue; }
        if (/[^\x00-\x1f\x7f]/u.test(char)) this.mutate(() => this.buffer.insert(char));
      }
    }
    return {};
  }

  resize(width: number, height: number): void {
    this.width = Math.max(30, width || 80);
    this.height = Math.max(8, height || 24);
  }

  render(width = this.width, height = this.height): string {
    this.resize(width, height);
    const text = this.buffer.text;
    const lines = text.split("\n");
    const cursor = this.cursorPosition();
    const bodyRows = Math.max(1, this.height - 2);
    if (cursor.line < this.viewportLine) this.viewportLine = cursor.line;
    if (cursor.line >= this.viewportLine + bodyRows) this.viewportLine = cursor.line - bodyRows + 1;
    const gutterWidth = Math.max(4, String(lines.length).length + 2);
    const contentWidth = Math.max(1, this.width - gutterWidth);
    if (cursor.column < this.horizontalOffset) this.horizontalOffset = cursor.column;
    if (cursor.column >= this.horizontalOffset + contentWidth) this.horizontalOffset = cursor.column - contentWidth + 1;

    const changed = this.dirty ? "modified" : "saved";
    const access = this.host.readOnly ? " · read only" : "";
    const titleText = truncateCells(`  ${safeText(this.path)} · ${changed}${access}`, this.width);
    const title = `${HEADER}${padAnsi(titleText, this.width, HEADER)}${RESET}`;
    const body: string[] = [];
    for (let row = 0; row < bodyRows; row++) {
      const lineIndex = this.viewportLine + row;
      const value = lines[lineIndex] ?? "";
      const visible = sliceCells(safeText(value), this.horizontalOffset, contentWidth);
      const number = lineIndex < lines.length ? String(lineIndex + 1).padStart(gutterWidth - 2) : "".padStart(gutterWidth - 2);
      const gutter = `${GUTTER}${number}  `;
      body.push(`${gutter}${TEXT}${padAnsi(highlight(visible, this.path), contentWidth, TEXT)}${RESET}`);
    }
    const keys = this.host.readOnly ? "  ^Q close" : "  ^S save   ^P commit + preview   ^Q close";
    const footerText = truncateCells(`${keys}   ${safeText(this.status)}`, this.width);
    const footer = `${FOOTER}${padAnsi(footerText, this.width, FOOTER)}${RESET}`;
    const cursorRow = 2 + cursor.line - this.viewportLine;
    const cursorColumn = gutterWidth + Math.max(0, cursor.column - this.horizontalOffset) + 1;
    return `${[title, ...body, footer].join("\r\n")}${ESC}${cursorRow};${Math.min(this.width, cursorColumn)}H${ESC}?25h`;
  }

  private handleEscape(sequence: string): void {
    const direction = sequence.match(/^\x1b\[(?:1;[2-8])?([ABCD])$/)?.[1];
    if (direction === "C") { this.buffer.right(); this.preferredColumn = undefined; }
    else if (direction === "D") { this.buffer.left(); this.preferredColumn = undefined; }
    else if (direction === "A") this.moveVertical(-1);
    else if (direction === "B") this.moveVertical(1);
    else if (/^\x1b(?:\[(?:H|1~|7~)|OH)$/.test(sequence)) { this.buffer.lineStart(); this.preferredColumn = undefined; }
    else if (/^\x1b(?:\[(?:F|4~|8~)|OF)$/.test(sequence)) { this.buffer.lineEnd(); this.preferredColumn = undefined; }
    else if (sequence === "\x1b[3~") this.mutate(() => this.buffer.delete());
    else if (sequence === "\x1b[5~") for (let index = 0; index < Math.max(1, this.height - 3); index++) this.moveVertical(-1);
    else if (sequence === "\x1b[6~") for (let index = 0; index < Math.max(1, this.height - 3); index++) this.moveVertical(1);
  }

  private moveVertical(offset: -1 | 1): void {
    const text = this.buffer.text;
    const lines = text.split("\n");
    const cursor = this.cursorPosition();
    const column = this.preferredColumn ?? Array.from(cursor.lineText).length;
    this.preferredColumn = column;
    const targetLine = Math.max(0, Math.min(lines.length - 1, cursor.line + offset));
    const targetPrefix = lines.slice(0, targetLine).join("\n") + (targetLine ? "\n" : "");
    const targetColumn = Array.from(lines[targetLine] ?? "").slice(0, column).join("");
    this.buffer.cursor = encoder.encode(targetPrefix + targetColumn).length;
  }

  private cursorPosition(): { line: number; column: number; lineText: string } {
    const prefixLines = this.buffer.prefix.split("\n");
    const lineText = prefixLines.at(-1) ?? "";
    return { line: prefixLines.length - 1, column: cellWidth(lineText), lineText };
  }

  private mutate(operation: () => boolean): void {
    if (this.host.readOnly) { this.status = "read only"; return; }
    if (!operation()) { this.status = "editor limit reached"; return; }
    this.dirty = true;
    this.quitArmed = false;
    this.preferredColumn = undefined;
    this.status = `${this.buffer.length}B · modified`;
  }

  private save(): void {
    if (this.host.readOnly) { this.status = "read only"; return; }
    try {
      const result = this.host.save(this.buffer.bytes, this.expectedRevision);
      this.expectedRevision = result.revision;
      this.dirty = false;
      this.quitArmed = false;
      this.status = result.message;
    } catch (error) { this.status = error instanceof Error ? error.message : "save failed"; }
  }

  private preview(): void {
    if (this.host.readOnly) { this.status = "read only"; return; }
    try {
      const result = this.host.preview(this.buffer.bytes, this.expectedRevision);
      this.expectedRevision = result.revision;
      this.dirty = false;
      this.quitArmed = false;
      this.status = result.message;
    } catch (error) { this.status = error instanceof Error ? error.message : "preview failed"; }
  }
}

function highlight(value: string, path: string): string {
  const extension = extname(path).toLowerCase();
  const comment = extension === ".html" ? value.indexOf("<!--") : extension === ".css" || extension === ".js" || extension === ".ts" || extension === ".json" ? value.indexOf("//") : extension === ".md" ? (value.trimStart().startsWith("#") ? 0 : -1) : -1;
  if (comment >= 0) return `${syntaxTokens(value.slice(0, comment))}${COMMENT}${value.slice(comment)}${TEXT}`;
  return syntaxTokens(value);
}

function syntaxTokens(value: string): string {
  const pattern = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:const|let|var|function|return|if|else|for|while|class|new|async|await|export|default|import|from|true|false|null|undefined)\b|\b\d+(?:\.\d+)?\b|<\/?[a-zA-Z][^>]*>)/g;
  let output = "";
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    output += value.slice(cursor, match.index);
    const token = match[0];
    const tone = token.startsWith("\"") || token.startsWith("'") || token.startsWith("`") ? GREEN : /^\d/.test(token) ? MAGENTA : token.startsWith("<") ? CYAN : YELLOW;
    output += `${tone}${token}${TEXT}`;
    cursor = (match.index ?? 0) + token.length;
  }
  return output + value.slice(cursor);
}

function safeText(value: string): string { return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x1b]/g, "�"); }
function plain(value: string): string { return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""); }
function cellWidth(value: string): number { return Array.from(value).reduce((sum, char) => sum + (/\p{Mark}/u.test(char) ? 0 : /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(char) ? 2 : 1), 0); }
function truncateCells(value: string, width: number): string { return sliceCells(value, 0, width); }
function sliceCells(value: string, start: number, width: number): string {
  let column = 0;
  let output = "";
  for (const char of value) {
    const size = cellWidth(char);
    if (column + size <= start) { column += size; continue; }
    if (cellWidth(output) + size > width) break;
    output += char;
    column += size;
  }
  return output;
}
function padAnsi(value: string, width: number, background: string): string {
  const used = cellWidth(plain(value));
  return `${value}${background}${" ".repeat(Math.max(0, width - used))}`;
}
