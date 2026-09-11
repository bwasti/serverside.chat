# Droplet deployment

The production-shaped deployment runs as the unprivileged `serverside-chat` user under systemd. Versioned application files live under `/opt/serverside-chat/releases/<commit>`, `/opt/serverside-chat/current` selects the active release, and persistent room state lives in `/var/lib/serverside-chat`. Deployments never overwrite room repositories, databases, chat history, SSH host identity, or account records.

Caddy terminates public HTTP/TLS on ports 80 and 443 using [`deploy/Caddyfile`](../deploy/Caddyfile), automatically redirects HTTP to HTTPS, and proxies HTTP, WebSocket, and `/_dav/<room>/` WebDAV traffic to the application on `127.0.0.1:3000`. The TUI's SSH and SFTP protocols remain directly exposed on port 2222; they do not pass through the HTTP reverse proxy.

SSH clients may open the default TUI, select an authorized room with `ssh -t -p 2222 serverside.chat room <name>`, enter its constrained editing environment with `ssh -t -p 2222 serverside.chat shell <name>`, or redeem a one-use invitation with `ssh -t -p 2222 serverside.chat invite '<token>'`. The server also offers a virtual SFTP subsystem for authenticated accounts. Remote commands are parsed as data by a strict allowlist and never passed to a system shell; SFTP paths are resolved through room capability checks and never reveal host paths or Git metadata.

The host firewall defaults to denying incoming traffic and permits only TCP 22 for management, TCP 2222 for chat SSH, TCP 80/443 for HTTP, HTTPS, and ACME, and UDP 443 for HTTP/3. Port 3000 is both loopback-bound and absent from the firewall allowlist.

The systemd unit is [`deploy/serverside-chat.service`](../deploy/serverside-chat.service). Its host-specific, root-readable environment file is `/etc/serverside-chat/environment`:

```dotenv
FIREWORKS_API_KEY=...
FIREWORKS_MODEL=accounts/fireworks/models/deepseek-v4p1-flash
FIREWORKS_CLASSIFIER_MODEL=accounts/fireworks/models/qwen3p8-flash-next-nvfp4
WEB_BASE_URL=https://your-host
ROOM_OWNER=your-handle
SSH_BOOTSTRAP_KEYS=/etc/serverside-chat/owner.pub
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
DEVELOPMENT_AUTH=false
```

Google's registered redirect URI must be `https://serverside.chat/_auth/google/callback`; GitHub's must be `https://serverside.chat/_auth/github/callback`, with wildcard callback matching disabled. Provider secrets are read only from the root-owned environment file and are never sent to the browser. Enable `DEVELOPMENT_AUTH` only while exercising the pre-OAuth account flow.

Only the public half of the owner's SSH key is installed at `owner.pub`. The private key stays on the user's device. The server verifies public-key signatures and enrolls that public key to the initial owner account as a migration/bootstrap path; normal users establish a canonical OAuth account before attaching one or more SSH keys.

## Release procedure

1. Commit and push a clean `main` branch.
2. Create an archive from the exact Git commit; do not copy `.env`, `.data`, or a developer working tree.
3. Extract it into a new commit-named release directory.
4. Run `bun install --frozen-lockfile --production` as the service user.
5. Atomically point `current` at the new release.
6. Restart the unit and verify `systemctl is-active serverside-chat`.
7. Validate and reload Caddy, then verify the public HTTPS page, WebSocket upgrade, private-room 404 boundary, and SSH public-key login.

Rollback only changes the `current` symlink to a prior release and restarts the unit. Persistent state is shared across releases, so schema changes must remain backward-compatible or include an explicit migration strategy.

The application port must remain loopback-only; public web access belongs on Caddy's ports 80/443. Before treating the service as Internet-production, wire authenticated browser sessions, configure a cloud firewall, and add backups for `/var/lib/serverside-chat`.
