export class RequestBodyLimitError extends Error {
  constructor(readonly limit: number) {
    super(`request body exceeds ${limit} byte limit`);
    this.name = "RequestBodyLimitError";
  }
}

export async function readBoundedText(request: Request, limit: number): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > limit) throw new RequestBodyLimitError(limit);
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new RequestBodyLimitError(limit);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes).toString("utf8");
}
