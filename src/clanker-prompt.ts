import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PROMPT_FILES = [
  "system.md",
  "context.md",
  "project.md",
  "design.md",
] as const;

function promptFile(name: string): string {
  return fileURLToPath(new URL(`../prompts/clanker/${name}`, import.meta.url));
}

export function readCanonicalSiteCss(): string {
  return readFileSync(promptFile("references/serverside.css"), "utf8").trim();
}

export function loadRoomClankerPrompt(): string {
  return PROMPT_FILES.map((name) => readFileSync(promptFile(name), "utf8").trim()).join("\n\n");
}
