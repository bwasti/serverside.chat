# Droplet deployment

The production-shaped deployment runs as the unprivileged `serverside-chat` user under systemd. Versioned application files live under `/opt/serverside-chat/releases/<commit>`, `/opt/serverside-chat/current` selects the active release, and persistent room state lives in `/var/lib/serverside-chat`. Deployments never overwrite room repositories, databases, chat history, SSH host identity, or account records.

Caddy terminates public HTTP/TLS on ports 80 and 443 using [`deploy/Caddyfile`](../deploy/Caddyfile), automatically redirects HTTP to HTTPS, and proxies HTTP and WebSocket traffic to the application on `127.0.0.1:3000`. The TUI's SSH protocol remains directly exposed on port 2222; it does not pass through the HTTP reverse proxy.

The systemd unit is [`deploy/serverside-chat.service`](../deploy/serverside-chat.service). Its host-specific, root-readable environment file is `/etc/serverside-chat/environment`:

```dotenv
FIREWORKS_API_KEY=...
WEB_BASE_URL=https://your-host
ROOM_OWNER=your-handle
SSH_BOOTSTRAP_KEYS=/etc/serverside-chat/owner.pub
```

Only the public half of the owner's SSH key is installed at `owner.pub`. The private key stays on the user's device. The server verifies public-key signatures and enrolls that public key to the initial owner account.

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
