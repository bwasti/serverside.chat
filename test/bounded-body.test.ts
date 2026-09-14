import { expect, test } from "bun:test";
import { readBoundedText, RequestBodyLimitError } from "../src/bounded-body";

test("streamed request bodies stop at the byte ceiling without trusting content-length", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(6));
      controller.enqueue(new Uint8Array(6));
    },
    cancel() { cancelled = true; },
  });
  const request = new Request("https://example.test", { method: "POST", body: stream });
  await expect(readBoundedText(request, 10)).rejects.toBeInstanceOf(RequestBodyLimitError);
  expect(cancelled).toBe(true);
});

test("bounded request bodies preserve UTF-8 text", async () => {
  expect(await readBoundedText(new Request("https://example.test", { method: "POST", body: "你好" }), 6)).toBe("你好");
});
