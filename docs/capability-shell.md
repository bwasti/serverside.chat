# Room capability shell and filesystem

The room shell is not an operating-system shell. It is an SSH terminal adapter over host-owned filesystem and version-control capabilities. User text is parsed as data and is never passed to `/bin/sh`, `eval`, `spawn`, or the Git command line. The host selects the authenticated principal and room before constructing a capability session.

```sh
ssh -t -p 2222 serverside.chat shell mine
```

The first implementation is TypeScript running in the existing server process. Its capability boundary is intentionally independent of the terminal frontend so a small Wasm command interpreter can replace the parser later without receiving filesystem paths, Git metadata, credentials, or ambient host functions.

## Commands

The shell supports cursor movement, command history, `Ctrl-A`, `Ctrl-E`, `Ctrl-B`, `Ctrl-F`, `Ctrl-U`, `Ctrl-K`, `Ctrl-W`, `Ctrl-C`, and `Ctrl-D`.

```text
files [path]                 list one virtual directory
cat <path>                   read a bounded text file
write <path>                 replace text; finish with .save or .abort
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

## Protected version backend

Git remains the current host implementation, but clients receive a product-level version API rather than Git execution. Commits, rebases, preview registration, immutable commit URLs, and fast-forward-only publication call predefined `RoomWorkspace` methods. The host constructs every Git argument array itself; no client string becomes an option or program.

Version mutations are audited. Human commits appear as formatted commit events in room chat, and canonical publication appears as a trunk event. Only a room owner can publish. Promotion continues to reject non-fast-forward history and merge commits.

The current prototype uses one shared room working tree, matching the collaborative-room model. File handles have optimistic conflict protection, but a future persistent per-user editing overlay is still needed for robust multi-file isolation and atomic commit creation during heavy concurrent editing. The public capability interface is designed so that change does not affect SSH/SFTP clients and so Git could later be replaced by Sapling.

## Capability separation

The source capability is never installed in the deployed website worker. The worker retains only immutable deployment assets plus its separate runtime database, scratch storage, logging, and realtime APIs. Human sessions receive source capabilities according to membership. The room agent receives its predefined source/version tools. Canonical publication remains a distinct owner capability.
