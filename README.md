# [serverside.chat](https://serverside.chat)

Every room gets a server and a clanker. Have fun!

<img width="1238" height="757" alt="Screenshot 2026-09-14 at 2 42 30 PM" src="https://github.com/user-attachments/assets/2ea3887c-8385-4190-8616-9da5a1bbe885" />

serverside.chat is a shared terminal-style chat for building small websites together. A room contains the conversation, a live website, its source history, and a quiet clanker that can make changes when useful.  This is all backed by wasm (non-POSIX) VMs to be lightweight and fairly constrained.

Use it over SSH:

```sh
ssh -p 2222 serverside.chat
```

## Stuff to know

The interface is keyboard-first. Press `Tab` to open the room bar, use the arrow keys to move, and press `Enter` to select. Type `/` in chat to see the available commands.

Useful commands:

```text
/invite              create a contributor invite link
/mount               show local filesystem mounting instructions
/shell               show SSH shell instructions
/domain              register and verify a custom site domain
/edit <path>         edit a room file
/permissions         inspect the room policy
/clanker <request>   explicitly ask the clanker (this is required to ship commits to main)
```

Each signed-in person can create up to five rooms for now. Rooms may be public or private, and contributions may be limited to invited members, room admins, nobody, or—dangerously—any signed-in viewer.

## Editing outside chat

The room has a shell but cannot run arbitrary programs. It exposes only bounded room files and predefined version-control operations:

```sh
ssh -t -p 2222 serverside.chat shell hello-world
sftp -P 2222 serverside.chat
sshfs -p 2222 serverside.chat:/hello-world ./hello-world
```

Inside a room, `/mount` also explains Finder's built-in WebDAV flow. Run `ssh -p 2222 serverside.chat account` to connect an SSH key to a canonical Google or GitHub account.

External coding agents can start from any development-chat URL. Its response advertises a room-specific Markdown guide, and `https://serverside.chat/llms.txt` indexes all hosted documentation. Once an SSH key is linked, agents can use SFTP plus the non-interactive capability API:

```sh
ssh -p 2222 serverside.chat "api hello-world status"
ssh -p 2222 serverside.chat "api hello-world diff"
ssh -p 2222 serverside.chat "api hello-world commit Describe the change"
```

Each command returns one JSON object. No command is passed to a host shell.

## Run locally

You need [Bun](https://bun.sh/) and `ssh-keygen`.

```sh
bun install
bun run start
```

Then connect:

```sh
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null localhost -p 2222
```

The browser interface is available on port `3000` by default. Set `FIREWORKS_API_KEY` to enable the clankers; without it, chat and room services still run.

---

## For clankers and operators

This section is the compact implementation map. Detailed contracts live in:

- [Guest service API](docs/service-api.md)
- [Capability shell, editor, SFTP, and WebDAV](docs/capability-shell.md)
- [Accounts and room policies](docs/accounts.md)
- [Custom domains](docs/custom-domains.md)
- [Security model](docs/security-model.md)
- [Rate limits](docs/rate-limits.md)
- [Deployment procedure](docs/deployment.md)
- [Pentest disposition](docs/pentest-review.md)

### Core invariants

- A room owns one chat, one complete Git repository, one canonical service, room-scoped SQLite and scratch storage, telemetry, and temporary previews.
- `https://<room>.serverside.chat` is the guest site. `https://serverside.chat/room/<room>` is its trusted development chat.
- Owners can bind up to five custom hostnames with `/domain add <hostname>` and a DNS TXT ownership challenge; only verified bindings are eligible for routing and automatic HTTPS.
- Every path below a room origin belongs to its generic guest handler. The host reserves only `__ref` for deployment selection.
- Guest `worker.js` runs in a fresh QuickJS WebAssembly isolate per request. It never binds a socket or receives Node.js, Bun, a shell, environment variables, host paths, raw SQLite paths, or arbitrary network access.
- The supported guest surface is bounded `request`, `Response`, `env.assets`, `env.db`, `env.fs`, `env.log`, and `env.realtime`.
- Host-owned authorization, routing, telemetry, limits, and deployment state are not controllable by room code.

### Source and deployments

Room repositories live below `.data/rooms/<room>/repo`. Working-tree files are capped at 512 KiB each and 5 MiB total. SQLite and runtime scratch storage are independently capped at 5 MiB each.

History is linear and rebase-only. `stable` identifies the canonical commit; `head` identifies repository HEAD. Any valid commit is lazily servable with `?__ref=<commit>`. Registered previews add a durable description and HUD entry. Publishing must fast-forward `stable`, contain no merge commits, and requires explicit owner authority.

New rooms include [`serverside.css`](prompts/clanker/references/serverside.css), a flat Zenburn, information-first design baseline. Clankers receive the rules in [`prompts/clanker/design.md`](prompts/clanker/design.md) and may read the exact stylesheet through a host-owned tool. Explicit human art direction wins, and established room designs are not silently replaced.

### Clanker behavior

The normal prompt is assembled from [`prompts/clanker/`](prompts/clanker/). The lobby guide and anonymous moderation prompts are separate and have fewer capabilities.

Clankers are quiet engineering utilities:

- Social chatter is ignored.
- Completed work becomes a commit and preview; the host posts the formatted status instead of prose.
- Clarifying questions are rare and reserved for consequential ambiguity or permission boundaries.
- Direct technical answers must be terse and deterministically grounded in code or deployment state.
- File and Git access is available only through predefined, room-scoped tools. There is no shell tool.
- Telemetry must remain intact unless an authenticated human explicitly requests its removal and acknowledges the visibility loss.

Provider calls are serialized per room. Normal runs have a 15-minute total deadline, five-minute provider waits, a two-minute finalization reserve, and a 256-turn ceiling. The primary spend boundary is a durable rolling output-token quota: 1M per room per hour and 8M globally per hour by default. Input tokens do not count toward these quotas.

### Identity and permissions

The internal user ID is canonical. Google/GitHub identities, browser cookies, and SSH public keys are credentials that resolve to it; handles are display labels, not authority.

Public rooms permit anonymous reading. Anonymous writing is allowed only in the lobby after bounded, fail-closed model moderation. The `authenticated` contribution policy deliberately permits any signed-in account that can view a room to chat, edit source, and invoke its configured clanker; it does not grant membership, moderation, invitations, publishing, or admin authority.

Canonical promotion is owner-only and is exposed to the clanker only during an explicit owner `/clanker` request. Passive transcript text cannot grant authority.

### Configuration

Important environment variables:

```dotenv
HOST=0.0.0.0
PORT=2222
WEB_HOST=127.0.0.1
WEB_PORT=3000
DATA_DIR=.data
WEB_BASE_URL=https://serverside.chat
ROOM_SITE_DOMAIN=serverside.chat
ROOM_OWNER=your-handle
SSH_BOOTSTRAP_KEYS=/path/to/owner.pub

FIREWORKS_API_KEY=...
FIREWORKS_MODEL=accounts/fireworks/models/deepseek-v4p1-flash
FIREWORKS_CLASSIFIER_MODEL=accounts/fireworks/models/glm-5p3-flash
CLANKER_ROOM_TOKENS_PER_HOUR=1000000
CLANKER_GLOBAL_TOKENS_PER_HOUR=8000000

GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
DEVELOPMENT_AUTH=false
```

Production runs as an unprivileged systemd service behind Caddy. Releases are immutable commit-named directories under `/opt/serverside-chat/releases`; persistent room data lives under `/var/lib/serverside-chat`. Follow the [deployment procedure](docs/deployment.md) rather than copying a working tree or local secrets.
