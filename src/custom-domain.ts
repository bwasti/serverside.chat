import { resolveTxt } from "node:dns/promises";
import type { RoomDomain } from "./auth";

export async function readDomainChallenge(domain: Pick<RoomDomain, "challengeName">): Promise<string[]> {
  try {
    const records = await resolveTxt(domain.challengeName);
    return records.map((parts) => parts.join(""));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENODATA" || code === "ENOTFOUND" || code === "NXDOMAIN") return [];
    throw new Error("DNS lookup failed; try again shortly");
  }
}
