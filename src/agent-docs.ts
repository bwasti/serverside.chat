import { readFileSync } from "node:fs";
import type { Room } from "./room";

const DOCUMENTS = [
  "accounts.md",
  "capability-shell.md",
  "custom-domains.md",
  "deployment.md",
  "pentest-review.md",
  "rate-limits.md",
  "security-model.md",
  "service-api.md",
] as const;

export function hostedDocument(name: string): string | undefined {
  if (name === "README.md") return readFileSync("README.md", "utf8");
  if (!(DOCUMENTS as readonly string[]).includes(name)) return undefined;
  return readFileSync(`docs/${name}`, "utf8");
}

export function documentationIndex(origin: string): string {
  return `# serverside.chat documentation

> Human- and agent-readable documentation for building bounded room websites.

- [Project overview](${origin}/docs/README.md)
${DOCUMENTS.map((name) => `- [${name.replace(/\.md$/, "").replaceAll("-", " ")}](${origin}/docs/${name})`).join("\n")}
`;
}

export function llmsText(origin: string): string {
  return `# serverside.chat

> Collaborative chat rooms paired with constrained website servers, source history, and clankers.

When given a room URL such as ${origin}/room/example, open that room's Markdown guide at ${origin}/room/example/llms.txt before attempting development. Development uses a linked SSH key, SFTP for bounded file transfer, and the non-interactive SSH room API for source and version operations. It never grants a host shell.

## Documentation

- [External agent workflow](${origin}/docs/capability-shell.md): Authentication, bounded files, and version operations.
- [Guest service API](${origin}/docs/service-api.md): JavaScript APIs available inside the Wasm service.
- [Security model](${origin}/docs/security-model.md): Trust boundaries and authority.
- [Accounts and permissions](${origin}/docs/accounts.md): Canonical identities and room roles.
- [All documentation](${origin}/docs/): Hosted Markdown index.
`;
}

export function llmsFullText(origin: string): string {
  return `${llmsText(origin)}\n${["README.md", ...DOCUMENTS].map((name) => `\n---\n\n${hostedDocument(name)}`).join("\n")}`;
}

export function roomAgentGuide(room: Room, controlOrigin: string): string {
  const roomPath = `${controlOrigin}/room/${encodeURIComponent(room.name)}`;
  const sshHost = new URL(controlOrigin).hostname;
  return `# serverside.chat room: ${room.name}

> Development guide for ${roomPath}. The live website is ${room.pageUrl}.

This room contains a shared bounded working tree and linear Git history. Access is authorized by the canonical serverside.chat account associated with your SSH public key. If the key is not linked yet, run:

\`\`\`sh
ssh -p 2222 ${sshHost} account
\`\`\`

Open the returned HTTPS URL, sign in, and attach the key. You still need a room invitation or a room policy that permits your account to contribute.

## Machine interface

The non-interactive SSH API returns one JSON object and never invokes a system shell:

\`\`\`sh
ssh -p 2222 ${sshHost} "api ${room.name} status"
ssh -p 2222 ${sshHost} "api ${room.name} diff"
ssh -p 2222 ${sshHost} "api ${room.name} files"
ssh -p 2222 ${sshHost} "api ${room.name} cat worker.js"
ssh -p 2222 ${sshHost} "api ${room.name} log"
ssh -p 2222 ${sshHost} "api ${room.name} versions"
\`\`\`

Use SFTP to download or upload files. Paths remain inside this room and normal contribution permissions apply:

\`\`\`sh
sftp -P 2222 ${sshHost}:/${room.name}
\`\`\`

After editing, inspect and record the change:

\`\`\`sh
ssh -p 2222 ${sshHost} "api ${room.name} diff"
ssh -p 2222 ${sshHost} "api ${room.name} commit Describe the change"
ssh -p 2222 ${sshHost} "api ${room.name} preview Describe the preview"
\`\`\`

Only the room owner can publish a preview to the canonical site:

\`\`\`sh
ssh -p 2222 ${sshHost} "api ${room.name} publish PREVIEW_ID"
\`\`\`

History is rebase-only and must remain linear. Use \`api ${room.name} rebase\`, resolve reported conflicts through SFTP, then use \`rebase-continue\`. Do not attempt host paths, \`.git\`, arbitrary commands, or direct process execution; those capabilities intentionally do not exist.

## References

- [Machine-readable API manifest](${roomPath}/api.json)
- [Capability shell and version operations](${controlOrigin}/docs/capability-shell.md)
- [Guest Wasm service API](${controlOrigin}/docs/service-api.md)
- [Security and authority model](${controlOrigin}/docs/security-model.md)
`;
}

export function roomApiManifest(room: Room, controlOrigin: string): object {
  const host = new URL(controlOrigin).hostname;
  return {
    version: 1,
    room: room.name,
    chat_url: `${controlOrigin}/room/${room.name}`,
    site_url: room.pageUrl,
    authentication: { canonical: "oauth-account", transport: "linked-ssh-public-key", link_command: `ssh -p 2222 ${host} account` },
    transports: {
      command: { protocol: "ssh", template: `ssh -p 2222 ${host} \"api ${room.name} {command}\"`, response: "application/json" },
      files: { protocol: "sftp", command: `sftp -P 2222 ${host}:/${room.name}` },
    },
    commands: {
      read: ["whoami", "limits", "files [path]", "ls [-la] [path]", "tree [path]", "cat <path>", "head [-n N] <path>", "tail [-n N] <path>", "wc <path>", "stat <path>", "status", "diff", "log", "versions"],
      write: ["mkdir <path>", "rm <path>", "rmdir <path>", "mv <old> <new>", "touch <path>", "cp <source> <destination>", "commit <title>", "preview <description>", "archive <preview-id>", "rebase", "rebase-continue", "rebase-abort"],
      owner_only: ["publish <preview-id>"],
    },
    constraints: { host_shell: false, git_directory_access: false, history: "linear-rebase-only", file_transfer: "SFTP" },
    documentation: `${controlOrigin}/room/${room.name}/llms.txt`,
  };
}
