# Room capability shell and filesystem

The room shell is not an operating-system shell. It is an SSH terminal adapter over host-owned filesystem and version-control capabilities. User text is parsed as data and is never passed to `/bin/sh`, `eval`, `spawn`, or the Git command line. The host selects the authenticated principal and room before constructing a capability session.

```sh
ssh -t -p 2222 serverside.chat shell mine
```

The command interpreter is TypeScript running in the existing server process. Its capability boundary is intentionally independent of the terminal frontend so it can later move into Wasm without receiving filesystem paths, Git metadata, credentials, or ambient host functions. The reusable editor already uses a tiny import-free Wasm core for its document buffer and mutations.

## Commands

The shell supports cursor movement, command history, `Ctrl-A`, `Ctrl-E`, `Ctrl-B`, `Ctrl-F`, `Ctrl-U`, `Ctrl-K`, `Ctrl-W`, `Ctrl-C`, and `Ctrl-D`.

```text
pwd
cd [path]
ls [-la] [path]
ll [path]
files [path]                 list one virtual directory
tree [path]
cat <path>                   read a bounded text file
head [-n count] <path>
tail [-n count] <path>
wc <path>
stat <path>
edit <path>                  open the Wasm editor
write <path>                 replace text; finish with .save or .abort
touch <path>
cp <source> <destination>
mkdir <path>
rm <path>
rmdir <empty-directory>
mv <old-path> <new-path>

status
diff
history
versions
commit <title>
preview <description>
archive <preview-id>
rebase
rebase-continue
rebase-abort
publish <preview-id>         room owner only

whoami
limits
clear
exit
```

There are no executable programs, environment variables, globbing, command substitution, redirection, pipes, sockets, devices, or host absolute paths. Quoting only groups arguments. For example, `$(whoami)` is inert text and `sh` is an unknown command.

Files are capped at 512 KiB, the source tree at 5 MiB, commands at 2 KiB, open SFTP handles at 16 per session, and aggregate open-file buffers at 2 MiB per session. Symlinks and special files are rejected. Writes use a sibling temporary file followed by atomic rename. A long-lived editor handle records the original content revision and rejects its close if another participant changed that file in the meantime.

## Reusable Wasm editor

Run `edit <path>` in the capability shell, or `/edit <path>` from an authenticated contributor's main chat composer. Because the browser and SSH chat frontends both drive `TuiSession`, the same full-screen editor works in either interface.

The editor's fixed 512 KiB UTF-8 buffer, cursor, insertion, deletion, and code-point movement live in [`editor-core.wasm`](../src/editor-core.wasm), built from the checked-in [`editor-core.wat`](../src/editor-core.wat). The module imports nothing. The host adapter provides terminal rendering and lightweight syntax coloring for JavaScript, TypeScript, JSON, HTML, CSS, and Markdown; it alone holds the authorized save and version capabilities.

```text
Arrow keys     move
Home/End       line start/end
Page Up/Down   move by a screen
Ctrl-A/E/B/F   familiar cursor movement
Ctrl-S         atomically save the working file
Ctrl-P         save, commit, and create an immutable preview
Ctrl-Q         close; press twice to discard unsaved changes
```

`Ctrl-P` creates the normal formatted room commit event and preview URL. It does not publish canonical; owner-only promotion remains separate. In the current shared-worktree prototype it may include other pending room changes, so per-user overlays remain the next concurrency hardening step.

## SFTP and local editors

The same SSH endpoint implements a virtual SFTP root. It contains only rooms visible to the authenticated account:

```sh
sftp -P 2222 serverside.chat
sftp> ls
sftp> cd mine
```

With an SSHFS client installed, a room can be mounted and edited using normal laptop tools:

```sh
mkdir -p ./mine
sshfs -p 2222 serverside.chat:/mine ./mine
```

The requested SSH username is cosmetic; the verified SSH key resolves to the canonical OAuth-backed account. Viewer access is read-only. Owner, admin, and contributor writes additionally follow the room's contribution policy. Host-managed system rooms such as `lobby` are always read-only through this interface. Unknown keys cannot open SFTP or the capability shell and must first use the chat TUI's browser sign-in/key-link flow.

The virtual server implements bounded file reads and writes, directory listing and mutation, rename, stat, and normalized metadata. It deliberately rejects symlinks, readlink, arbitrary extensions, ownership changes, and executable modes. `.git` is unaddressable at every directory level.

## Finder and WebDAV

Enter `/mount` in a normal room's browser or SSH chat. It opens a local-only, scrollable instruction screen with ready-to-use SFTP and SSHFS commands plus a newly rotated Finder credential. Press `Command-K` in Finder and enter the displayed URL, normally:

```text
https://serverside.chat/_dav/<room>/
```

The username identifies a random mount credential; the password is a separately random 256-bit secret displayed only when created. Only its SHA-256 hash is stored. The credential expires after 90 days, is scoped to one room, and resolves to the same canonical account as OAuth and linked SSH keys. Running `/mount` again rotates it; `/mount revoke` invalidates it immediately. SFTP and SSHFS continue to authenticate with the linked SSH key and do not use this password.

The WebDAV adapter supports bounded discovery, reads, writes, directory creation and removal, copy, move, and five-minute exclusive write locks. Finder receives Class 2 WebDAV discovery and can store the credential in Keychain. Every request rechecks current room visibility and contribution policy, so a credential cannot preserve write authority after policy or membership changes. All mutations use the same protected `RoomWorkspace` operations, quotas, path checks, normalized metadata, and audit log as SFTP. Cross-room moves, symlinks, `.git`, unbounded request bodies, and infinite-depth traversal are rejected.

## Protected version backend

Git remains the current host implementation, but clients receive a product-level version API rather than Git execution. Commits, rebases, preview registration, immutable commit URLs, and fast-forward-only publication call predefined `RoomWorkspace` methods. The host constructs every Git argument array itself; no client string becomes an option or program.

Version mutations are audited. Human commits appear as formatted commit events in room chat, and canonical publication appears as a trunk event. Only a room owner can publish. Promotion continues to reject non-fast-forward history and merge commits.

The current prototype uses one shared room working tree, matching the collaborative-room model. File handles have optimistic conflict protection, but a future persistent per-user editing overlay is still needed for robust multi-file isolation and atomic commit creation during heavy concurrent editing. The public capability interface is designed so that change does not affect SSH/SFTP clients and so Git could later be replaced by Sapling.

## Capability separation

The source capability is never installed in the deployed website worker. The worker retains only immutable deployment assets plus its separate runtime database, scratch storage, logging, and realtime APIs. Human sessions receive source capabilities according to membership. The room agent receives its predefined source/version tools. Canonical publication remains a distinct owner capability.
