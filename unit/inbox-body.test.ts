import { describe, expect, it } from "bun:test";
import { inboxResponseBody, knownLengthBody } from "@/lib/inbox/body";
const bytes = new Uint8Array([1, 2, 3]);
const stream = () => new Response(bytes).body!;
describe("R2 body runtime boundaries", () => {
  it("dev uploads have a known-length buffer even without FixedLengthStream", async () => {
    const body = await knownLengthBody(stream(), 3);
    expect(body).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(body as ArrayBuffer)]).toEqual([1, 2, 3]);
  });
  it("Workers keep the fixed-length upload stream", async () => {
    let length = 0;
    class Fixed extends TransformStream {
      constructor(n: number) {
        super();
        length = n;
      }
    }
    const body = await knownLengthBody(stream(), 3, Fixed);
    expect(body).toBeInstanceOf(ReadableStream);
    expect(length).toBe(3);
    expect([...new Uint8Array(await new Response(body).arrayBuffer())]).toEqual([1, 2, 3]);
  });
  it("dev invokes arrayBuffer on the R2 object instead of its non-transferable body", async () => {
    let reads = 0;
    const object = {
      get body(): ReadableStream<Uint8Array> {
        throw new DOMException("invalid transferList", "DataCloneError");
      },
      async arrayBuffer() {
        reads++;
        return bytes.slice().buffer;
      },
    };
    expect([...new Uint8Array((await inboxResponseBody(object, false)) as ArrayBuffer)]).toEqual([
      1, 2, 3,
    ]);
    expect(reads).toBe(1);
  });
  it("Workers preserve streaming and test buckets without arrayBuffer still work", async () => {
    const body = stream();
    const object = {
      body,
      arrayBuffer: async () => {
        throw Error("must not buffer in Worker");
      },
    };
    expect(await inboxResponseBody(object, true)).toBe(body);
    expect(await inboxResponseBody({ body }, false)).toBe(body);
    expect(await inboxResponseBody({ body })).toBe(body);
  });
  it("read failures stay rejected for the handler to report", async () => {
    await expect(
      inboxResponseBody(
        {
          body: stream(),
          arrayBuffer: async () => {
            throw Error("missing");
          },
        },
        false,
      ),
    ).rejects.toThrow("missing");
  });
});
