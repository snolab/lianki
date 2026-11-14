/** Bodies crossing the Miniflare/workerd ↔ Next dev boundary. */
type FixedStream = new (n: number) => TransformStream;
const fixedStream = () => (globalThis as { FixedLengthStream?: FixedStream }).FixedLengthStream;

/** R2 requires known length. Node/Bun Next dev lacks Workers' FixedLengthStream. */
export async function knownLengthBody(
  stream: ReadableStream<Uint8Array>,
  length: number,
  Fixed: FixedStream | undefined = fixedStream(),
): Promise<ReadableStream<Uint8Array> | ArrayBuffer> {
  return Fixed ? stream.pipeThrough(new Fixed(length)) : new Response(stream).arrayBuffer();
}

export type InboxObject = {
  body: ReadableStream<Uint8Array>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
};

/**
 * Bun cannot transfer Miniflare's workerd ReadableStream through the proxy
 * (DataCloneError: invalid transferList). Invoke the object's own method in
 * workerd instead of consuming that proxy stream. Only dev buffers; Workers
 * keep the original stream and backpressure. Upload size is bounded first.
 */
export async function inboxResponseBody(
  object: InboxObject,
  workers = typeof fixedStream() === "function",
): Promise<ReadableStream<Uint8Array> | ArrayBuffer> {
  return !workers && object.arrayBuffer ? object.arrayBuffer() : object.body;
}
