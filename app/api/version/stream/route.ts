/**
 * New-version notice (app/components/NewVersionNotice.tsx): a Server-Sent
 * Events stream that says which build is serving, once, on connect.
 *
 * Nothing has to be pushed at deploy time. A deploy ends the streams held by
 * the old Worker; the browser reconnects (EventSource does that on its own)
 * to the new one, hears a build id unlike its page's, and offers a refresh.
 * Each stream also ends after STREAM_MS, so a connection that somehow
 * outlives a deploy still catches up within minutes.
 *
 * Cheap on Workers: an open stream costs no CPU between keep-alive pings,
 * and the page holds one only while it is visible and focused.
 */
export const dynamic = "force-dynamic";

const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID ?? "dev";
const STREAM_MS = 5 * 60_000;
const PING_MS = 25_000;

export function GET(req: Request) {
  const enc = new TextEncoder();
  let ping: ReturnType<typeof setInterval> | undefined;
  let end: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    clearInterval(ping);
    clearTimeout(end);
  };
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      const close = () => {
        stop();
        try {
          c.close();
        } catch {}
      };
      c.enqueue(enc.encode(`retry: 5000\nevent: version\ndata: ${BUILD_ID}\n\n`));
      ping = setInterval(() => {
        try {
          c.enqueue(enc.encode(": ping\n\n"));
        } catch {
          stop();
        }
      }, PING_MS);
      end = setTimeout(close, STREAM_MS);
      req.signal.addEventListener("abort", close);
    },
    cancel: stop,
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}
