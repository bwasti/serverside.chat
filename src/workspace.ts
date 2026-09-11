import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, relative, resolve, sep } from "node:path";

export const MAX_WORKSPACE_FILE_BYTES = 512 * 1024;
export const MAX_WORKSPACE_BYTES = 5 * 1024 * 1024;
const MAX_WORKSPACE_ENTRIES = 1_000;
const MAX_PUBLISHED_CACHE_ENTRIES = 128;

export class RoomWorkspace {
  readonly root: string;
  private readonly metadataPath: string;
  readonly previews = new Map<string, string>();
  readonly previewDescriptions = new Map<string, string>();
  readonly previewBranches = new Map<string, string>();
  readonly archivedPreviews = new Set<string>();
  private readonly publishedCache = new Map<string, string>();
  activeCommit!: string;

  constructor(dataDir: string, readonly roomName: string, sourceRoot?: string) {
    this.root = resolve(dataDir, "rooms", roomName, "repo");
    this.metadataPath = resolve(dataDir, "rooms", roomName, "deployments.json");
    if (sourceRoot && !existsSync(this.root)) {
      mkdirSync(dirname(this.root), { recursive: true });
      runGit(undefined, ["clone", "-q", "--no-hardlinks", sourceRoot, this.root]);
    } else {
      mkdirSync(this.root, { recursive: true });
      this.seed();
      if (!existsSync(resolve(this.root, ".git"))) this.git(["init", "-q"]);
      if (!this.git(["rev-parse", "--verify", "HEAD"], true).ok) this.commit("initialize room service");
    }
    this.loadDeployments();
    this.updateStableTag();
  }

  listTree(): Array<{ path: string; bytes: number }> {
    const output: Array<{ path: string; bytes: number }> = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === ".git") continue;
        const absolute = resolve(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error("symbolic links are not supported");
        if (entry.isDirectory()) walk(absolute);
        else if (entry.isFile()) output.push({ path: relative(this.root, absolute), bytes: statSync(absolute).size });
        if (output.length > MAX_WORKSPACE_ENTRIES) throw new Error("repository exceeds 1,000 file limit");
      }
    };
    walk(this.root);
    return output.sort((a, b) => a.path.localeCompare(b.path));
  }

  readFile(path: string): string {
    return this.readFileBytes(path).toString("utf8");
  }

  readFileBytes(path: string): Buffer {
    const target = this.safePath(path);
    if (!existsSync(target)) throw new Error("file not found");
    const info = lstatSync(target);
    if (info.isSymbolicLink()) throw new Error("symbolic links are not supported");
    if (!info.isFile()) throw new Error("file not found");
    if (info.size > MAX_WORKSPACE_FILE_BYTES) throw new Error("file is too large to read");
    return readFileSync(target);
  }

  writeFile(path: string, content: string): { path: string; bytes: number } {
    return this.writeFileBytes(path, Buffer.from(content));
  }

  writeFileBytes(path: string, content: Buffer, expectedRevision?: string | null): { path: string; bytes: number; revision: string } {
    const target = this.safePath(path);
    const bytes = content.byteLength;
    if (bytes > MAX_WORKSPACE_FILE_BYTES) throw new Error("file exceeds 512 KiB limit");
    const currentRevision = this.fileRevision(path);
    if (expectedRevision !== undefined && expectedRevision !== currentRevision) throw new Error("file changed since it was opened");
    if (!existsSync(target)) this.assertEntryCapacityFor(target);
    const oldBytes = existsSync(target) ? statSync(target).size : 0;
    const total = this.listTree().reduce((sum, file) => sum + file.bytes, 0) - oldBytes + bytes;
    if (total > MAX_WORKSPACE_BYTES) throw new Error("repository working tree exceeds 5 MiB limit");
    mkdirSync(dirname(target), { recursive: true });
    this.assertNoSymlinkParents(target);
    const temporary = resolve(dirname(target), `.${crypto.randomUUID()}.room-write`);
    try {
      writeFileSync(temporary, content, { mode: 0o644 });
      renameSync(temporary, target);
    } catch (error) {
      if (existsSync(temporary)) unlinkSync(temporary);
      throw error;
    }
    return { path, bytes, revision: contentRevision(content) };
  }

  deleteFile(path: string): { deleted: string } {
    const target = this.safePath(path);
    if (!existsSync(target)) throw new Error("file not found");
    const info = lstatSync(target);
    if (info.isSymbolicLink()) throw new Error("symbolic links are not supported");
    if (!info.isFile()) throw new Error("file not found");
    unlinkSync(target);
    return { deleted: path };
  }

  fileRevision(path: string): string | null {
    const target = this.safePath(path);
    if (!existsSync(target)) return null;
    const info = lstatSync(target);
    if (info.isSymbolicLink()) throw new Error("symbolic links are not supported");
    if (!info.isFile()) throw new Error("path is not a file");
    if (info.size > MAX_WORKSPACE_FILE_BYTES) throw new Error("file is too large to read");
    return contentRevision(readFileSync(target));
  }

  stat(path = ""): { kind: "file" | "directory"; bytes: number; modifiedAt: number } {
    const target = path ? this.safePath(path) : this.root;
    if (!existsSync(target)) throw new Error("file not found");
    const info = lstatSync(target);
    if (info.isSymbolicLink()) throw new Error("symbolic links are not supported");
    if (!info.isFile() && !info.isDirectory()) throw new Error("unsupported filesystem entry");
    return { kind: info.isDirectory() ? "directory" : "file", bytes: info.isFile() ? info.size : 0, modifiedAt: info.mtimeMs };
  }

  listDirectory(path = ""): Array<{ name: string; kind: "file" | "directory"; bytes: number; modifiedAt: number }> {
    const target = path ? this.safePath(path) : this.root;
    if (!existsSync(target) || !lstatSync(target).isDirectory()) throw new Error("directory not found");
    return readdirSync(target, { withFileTypes: true }).filter((entry) => entry.name !== ".git").map((entry) => {
      const absolute = resolve(target, entry.name);
      const info = lstatSync(absolute);
      if (entry.isSymbolicLink()) throw new Error("symbolic links are not supported");
      if (!entry.isFile() && !entry.isDirectory()) throw new Error("unsupported filesystem entry");
      return { name: entry.name, kind: entry.isDirectory() ? "directory" as const : "file" as const, bytes: entry.isFile() ? info.size : 0, modifiedAt: info.mtimeMs };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  createDirectory(path: string): { path: string } {
    const target = this.safePath(path);
    if (existsSync(target)) throw new Error("file already exists");
    if (this.entryCount() >= MAX_WORKSPACE_ENTRIES) throw new Error("repository exceeds 1,000 entry limit");
    this.assertNoSymlinkParents(target);
    mkdirSync(target);
    return { path };
  }

  removeDirectory(path: string): { deleted: string } {
    const target = this.safePath(path);
    if (!existsSync(target) || !lstatSync(target).isDirectory()) throw new Error("directory not found");
    rmdirSync(target);
    return { deleted: path };
  }

  renamePath(oldPath: string, newPath: string): { oldPath: string; newPath: string } {
    const source = this.safePath(oldPath);
    const target = this.safePath(newPath);
    if (!existsSync(source)) throw new Error("file not found");
    if (lstatSync(source).isSymbolicLink()) throw new Error("symbolic links are not supported");
    this.assertNoSymlinkParents(target);
    if (!existsSync(dirname(target)) || !lstatSync(dirname(target)).isDirectory()) throw new Error("target directory not found");
    renameSync(source, target);
    return { oldPath, newPath };
  }

  status(): string { return this.git(["status", "--short", "--branch"]).stdout; }
  hasChanges(): boolean { return Boolean(this.git(["status", "--porcelain"]).stdout.trim()); }
  diff(): string { return this.limit(this.git(["diff", "--", "."]).stdout); }
  log(): string { return this.git(["log", "-12", "--oneline", "--decorate"]).stdout; }
  versionGraph(limit = 8): string[] {
    const count = Math.max(1, Math.min(12, Math.floor(limit) || 8));
    const head = this.head();
    const previews = new Map(this.visiblePreviews().map((preview) => [preview.commit, preview.description]));
    const lines = this.git(["log", "--graph", "--all", "--topo-order", "--decorate=short", `-${count}`, "--format=%h%x09%s%x09%d"]).stdout
      .trimEnd().split("\n").filter(Boolean).map((line) => {
        const match = line.match(/^([*|\\/ .-]*)(.*)$/);
        const graph = (match?.[1] ?? "").replaceAll("*", "●").replaceAll("|", "│").replaceAll("\\", "╲").replaceAll("/", "╱");
        const fields = (match?.[2] ?? line).split("\t");
        const commit = fields[0] ?? "";
        if (!/^[0-9a-f]{7,40}$/.test(commit)) return `${graph}…`;
        const labels: string[] = [];
        if (commit === head) labels.push("head");
        if (commit === this.activeCommit) labels.push("stable");
        const preview = previews.get(commit);
        if (preview) labels.push(preview);
        const refs = (fields[2] ?? "").replace(/[()]/g, "").split(",").map((ref) => ref.trim().replace(/^HEAD -> /, "").replace(/^tag: /, "")).filter((ref) => ref && ref !== "stable" && ref !== labels[0]);
        const tags = [...labels, ...refs.filter((ref) => !labels.includes(ref))];
        const summary = tags.length ? tags.slice(0, 3).join(" · ") : (fields[1] ?? "commit");
        return `${graph}${commit}  ${summary}`.replace(/\s+$/, "").slice(0, 120);
      });
    if (Number(this.git(["rev-list", "--all", "--count"]).stdout.trim()) > count) lines.push("…");
    return lines;
  }
  branches(): string { return this.git(["branch", "--format=%(refname:short)"]).stdout; }
  deploymentStatus(): { activeCommit: string; headCommit: string; activeIsHead: boolean; previews: Array<{ id: string; commit: string; description: string }> } {
    const headCommit = this.head();
    return {
      activeCommit: this.activeCommit,
      headCommit,
      activeIsHead: this.activeCommit === headCommit,
      previews: this.visiblePreviews(),
    };
  }

  visiblePreviews(): Array<{ id: string; commit: string; description: string }> {
    return [...this.previews]
      .filter(([id, commit]) => !this.archivedPreviews.has(id) && !this.git(["merge-base", "--is-ancestor", commit, this.activeCommit], true).ok)
      .map(([id, commit]) => ({ id, commit, description: this.previewDescriptions.get(id) ?? "preview" }))
      .slice(-5);
  }

  commit(message: string, blurb = ""): { commit: string; title: string; blurb: string } {
    return this.commitAs(message, blurb, "room-agent", "agent@serverside.chat");
  }

  commitAs(message: string, blurb: string, authorName: string, authorEmail: string): { commit: string; title: string; blurb: string } {
    const clean = message.replace(/[\r\n]/g, " ").trim().slice(0, 120) || "agent update";
    const detail = blurb.replace(/[\r\n]/g, " ").trim().slice(0, 240);
    const name = authorName.replace(/[\r\n<>]/g, " ").trim().slice(0, 80) || "room contributor";
    const email = /^[^\s<>@]+@[^\s<>@]+$/.test(authorEmail) ? authorEmail.slice(0, 120) : "contributor@serverside.chat";
    this.git(["add", "-A", "--", "."]);
    const args = ["-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-q", "--allow-empty", "-m", clean];
    if (detail) args.push("-m", detail);
    this.git(args);
    return { commit: this.git(["rev-parse", "--short", "HEAD"]).stdout.trim(), title: clean, blurb: detail };
  }

  createBranch(name: string): { branch: string } {
    const branch = validBranch(name);
    this.git(["switch", "-c", branch]);
    return { branch };
  }

  switchBranch(name: string): { branch: string } {
    const branch = validBranch(name);
    this.git(["switch", branch]);
    return { branch };
  }

  rebaseOntoStable(): { completed: boolean; head?: string; base: string; conflicts?: string } {
    if (this.status().split("\n").some((line) => line && !line.startsWith("##"))) throw new Error("working tree must be clean before rebase");
    const result = this.git(["rebase", "stable"], true);
    if (!result.ok) {
      return { completed: false, base: this.activeCommit, conflicts: this.status() };
    }
    return { completed: true, head: this.head(), base: this.activeCommit };
  }

  continueRebase(): { completed: boolean; head?: string; conflicts?: string } {
    this.git(["add", "-A", "--", "."]);
    const result = this.git(["-c", "core.editor=true", "rebase", "--continue"], true);
    if (!result.ok) return { completed: false, conflicts: this.status() };
    return { completed: true, head: this.head() };
  }

  abortRebase(): { aborted: true } {
    if (!this.git(["rebase", "--abort"], true).ok) throw new Error("no rebase is in progress");
    return { aborted: true };
  }

  createPreview(description: string): { id: string; commit: string; description: string } {
    if (this.status().split("\n").some((line) => line && !line.startsWith("##"))) throw new Error("commit changes before publishing");
    const commit = this.head();
    const id = `${commit}-${crypto.randomUUID().slice(0, 6)}`;
    const blurb = description.replace(/[\r\n]/g, " ").trim().slice(0, 80) || "preview";
    const branch = this.git(["branch", "--show-current"]).stdout.trim() || "detached";
    for (const [existingId, existingBranch] of this.previewBranches) if (existingBranch === branch) this.archivedPreviews.add(existingId);
    this.previews.set(id, commit);
    this.previewDescriptions.set(id, blurb);
    this.previewBranches.set(id, branch);
    this.saveDeployments();
    return { id, commit, description: blurb };
  }

  promotePreview(id: string): { commit: string } {
    const commit = this.previews.get(id);
    if (!commit) throw new Error("preview not found");
    if (!this.git(["merge-base", "--is-ancestor", this.activeCommit, commit], true).ok) {
      throw new Error("promotion must be a fast-forward from stable; rebase the branch onto stable and create a new preview");
    }
    const merges = this.git(["rev-list", "--merges", `${this.activeCommit}..${commit}`]).stdout.trim();
    if (merges) throw new Error("promotion rejected: merge commits are forbidden; rebase to produce linear history");
    this.activeCommit = commit;
    this.archivedPreviews.add(id);
    for (const [previewId, previewCommit] of this.previews) {
      if (this.git(["merge-base", "--is-ancestor", previewCommit, commit], true).ok) this.archivedPreviews.add(previewId);
    }
    this.updateStableTag();
    this.saveDeployments();
    return { commit };
  }

  archivePreview(id: string): { id: string; commit: string; archived: true } {
    const commit = this.previews.get(id);
    if (!commit) throw new Error("preview not found");
    this.archivedPreviews.add(id);
    this.saveDeployments();
    return { id, commit, archived: true };
  }

  readPublished(path: string, ref?: string): string {
    const commit = this.resolveDeploymentRef(ref);
    if (!commit) throw new Error("preview not found");
    const safe = relative(this.root, this.safePath(path));
    const key = `${commit}:${safe}`;
    const cached = this.publishedCache.get(key);
    if (cached !== undefined) return cached;
    const content = this.limit(this.git(["show", key]).stdout);
    this.publishedCache.set(key, content);
    if (this.publishedCache.size > MAX_PUBLISHED_CACHE_ENTRIES) {
      this.publishedCache.delete(this.publishedCache.keys().next().value!);
    }
    return content;
  }

  readPublishedAsset(path: string, ref?: string): string | undefined {
    const commit = this.resolveDeploymentRef(ref);
    if (!commit) return undefined;
    let safe: string;
    try { safe = relative(this.root, this.safePath(path)); }
    catch { return undefined; }
    const key = `${commit}:${safe}`;
    const cached = this.publishedCache.get(key);
    if (cached !== undefined) return cached;
    const type = this.git(["cat-file", "-t", key], true);
    if (!type.ok || type.stdout.trim() !== "blob") return undefined;
    const content = this.limit(this.git(["show", key]).stdout);
    this.publishedCache.set(key, content);
    if (this.publishedCache.size > MAX_PUBLISHED_CACHE_ENTRIES) this.publishedCache.delete(this.publishedCache.keys().next().value!);
    return content;
  }

  private seed(): void {
    if (!existsSync(resolve(this.root, "index.html"))) writeFileSync(resolve(this.root, "index.html"), defaultPage(this.roomName));
    if (!existsSync(resolve(this.root, "worker.js"))) writeFileSync(resolve(this.root, "worker.js"), `export default {\n  async fetch(request, env) {\n    env.log.info("request", { method: request.method, path: request.path });\n    return env.assets.fetch(request);\n  },\n};\n`);
    if (!existsSync(resolve(this.root, "README.md"))) writeFileSync(resolve(this.root, "README.md"), `# ${this.roomName}\n\nRoom service source.\n`);
  }

  private loadDeployments(): void {
    this.activeCommit = this.head();
    if (!existsSync(this.metadataPath)) return;
    try {
      const data = JSON.parse(readFileSync(this.metadataPath, "utf8")) as { activeCommit?: string; previews?: Record<string, string>; previewDescriptions?: Record<string, string>; previewBranches?: Record<string, string>; archivedPreviews?: string[] };
      if (data.activeCommit && /^[0-9a-f]{7,40}$/.test(data.activeCommit)) this.activeCommit = data.activeCommit;
      for (const [id, commit] of Object.entries(data.previews ?? {})) {
        if (/^[0-9a-f]+-[a-f0-9-]+$/.test(id) && /^[0-9a-f]{7,40}$/.test(commit)) this.previews.set(id, commit);
      }
      for (const [id, description] of Object.entries(data.previewDescriptions ?? {})) {
        if (this.previews.has(id) && typeof description === "string") this.previewDescriptions.set(id, description.slice(0, 80));
      }
      for (const [id, branch] of Object.entries(data.previewBranches ?? {})) if (this.previews.has(id)) this.previewBranches.set(id, branch);
      for (const id of data.archivedPreviews ?? []) if (this.previews.has(id)) this.archivedPreviews.add(id);
    } catch { throw new Error(`invalid deployment metadata for room ${this.roomName}`); }
  }

  private saveDeployments(): void {
    const temporary = `${this.metadataPath}.tmp`;
    writeFileSync(temporary, JSON.stringify({ activeCommit: this.activeCommit, previews: Object.fromEntries(this.previews), previewDescriptions: Object.fromEntries(this.previewDescriptions), previewBranches: Object.fromEntries(this.previewBranches), archivedPreviews: [...this.archivedPreviews] }, null, 2));
    renameSync(temporary, this.metadataPath);
  }

  private updateStableTag(): void {
    this.git(["tag", "-f", "stable", this.activeCommit]);
  }

  private safePath(path: string): string {
    if (!path || path.includes("\0") || path.split(/[\\/]/).some((segment) => segment.toLowerCase() === ".git")) throw new Error("invalid repository path");
    const target = resolve(this.root, path);
    if (!target.startsWith(this.root + sep)) throw new Error("path escapes repository");
    this.assertNoSymlinkParents(target);
    return target;
  }

  private assertNoSymlinkParents(target: string): void {
    let cursor = dirname(target);
    while (cursor.startsWith(this.root) && cursor !== this.root) {
      if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error("symbolic links are not supported");
      cursor = dirname(cursor);
    }
  }

  private git(args: string[], allowFailure = false) { return runGit(this.root, args, allowFailure); }
  headCommit(): string { return this.git(["rev-parse", "--short", "HEAD"]).stdout.trim(); }
  private head(): string { return this.headCommit(); }
  private entryCount(): number {
    let count = 0;
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === ".git") continue;
        count++;
        if (count > MAX_WORKSPACE_ENTRIES) throw new Error("repository exceeds 1,000 entry limit");
        if (entry.isSymbolicLink()) throw new Error("symbolic links are not supported");
        if (entry.isDirectory()) walk(resolve(directory, entry.name));
      }
    };
    walk(this.root);
    return count;
  }
  private assertEntryCapacityFor(target: string): void {
    let missing = 0;
    let cursor = target;
    while (cursor !== this.root) {
      if (!existsSync(cursor)) missing++;
      cursor = dirname(cursor);
    }
    if (this.entryCount() + missing > MAX_WORKSPACE_ENTRIES) throw new Error("repository exceeds 1,000 entry limit");
  }
  private resolveDeploymentRef(ref?: string): string | undefined {
    if (!ref || ref === "stable") return this.activeCommit;
    if (ref === "head") return this.head();
    const preview = this.previews.get(ref);
    if (preview) return preview;
    if (!/^[0-9a-f]{7,40}$/.test(ref)) return undefined;
    const resolved = this.git(["rev-parse", "--verify", `${ref}^{commit}`], true);
    return resolved.ok ? resolved.stdout.trim() : undefined;
  }
  private limit(value: string): string { return value.length > 100_000 ? value.slice(0, 100_000) + "\n[truncated]" : value; }
}

function contentRevision(content: Buffer): string {
  return createHash("sha256").update(content).digest("base64url");
}

function runGit(cwd: string | undefined, args: string[], allowFailure = false): { ok: boolean; stdout: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0 && !allowFailure) throw new Error(`git failed: ${(result.stderr || result.stdout).trim()}`);
  return { ok: result.status === 0, stdout: result.stdout ?? "" };
}

function validBranch(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,63}$/.test(value) || value.includes("..") || value.endsWith("/") || value === "stable" || value.toLowerCase() === "head") throw new Error("invalid or reserved branch name");
  return value;
}

function defaultPage(roomName: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${roomName}</title><h1>Hello world</h1>\n`;
}
