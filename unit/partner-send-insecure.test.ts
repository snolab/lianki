/**
 * The pill's Li frame on a plain http:// site is not a secure context, so
 * crypto.randomUUID is missing there. The partner client's send() must still
 * mint a line id (uuid.ts, from getRandomValues), and a send that does throw
 * must be logged and shown, never silent.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createPartnerClient } from "@lianki/debug-chat/embed/partner-client";
import { uuidv4 } from "../packages/debug-chat/src/uuid";

class FakeWs {
  static made: FakeWs[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  throwOnSend = false;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor() {
    FakeWs.made.push(this);
  }
  send(d: string) {
    if (this.throwOnSend) throw new Error("socket send failed");
    this.sent.push(JSON.parse(d));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
}

const doc = {
  visibilityState: "visible",
  addEventListener() {},
  removeEventListener() {},
} as unknown as Document;

async function openClient() {
  FakeWs.made = [];
  const errors: unknown[] = [];
  const c = createPartnerClient({
    url: "ws://localhost/api/version/debug",
    ticket: async () => "t1",
    open: () => new FakeWs(),
    label: () => "site-c.test/ Chrome",
    doc,
    onSendError: (e) => errors.push(e),
  });
  await new Promise((r) => setTimeout(r, 0));
  const ws = FakeWs.made[0];
  ws.open();
  return { c, ws, errors };
}

/** As on a plain http:// site: crypto.randomUUID is undefined (shadowed on the instance). */
let hadOwn: PropertyDescriptor | undefined;
beforeEach(() => {
  hadOwn = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
  Object.defineProperty(crypto, "randomUUID", {
    value: undefined,
    configurable: true,
    writable: true,
  });
});
afterEach(() => {
  delete (crypto as unknown as Record<string, unknown>).randomUUID;
  if (hadOwn) Object.defineProperty(crypto, "randomUUID", hadOwn);
});

describe("uuidv4 without crypto.randomUUID", () => {
  it("is a v4 UUID, and a fresh one each time", () => {
    expect(typeof crypto.randomUUID).toBe("undefined");
    const a = uuidv4();
    const b = uuidv4();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });
});

describe("partner client send() on an insecure page", () => {
  it("sends the line with a 12-character id", async () => {
    const { c, ws, errors } = await openClient();
    expect(c.send("hello from an http site")).toBe(true);
    const line = ws.sent.find((m) => m.type === "chat");
    expect(line?.text).toBe("hello from an http site");
    expect(String(line?.id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{3}$/);
    expect(errors).toEqual([]);
    expect(c.get().sendFailed).toBeFalsy();
    c.stop();
  });

  it("a send that throws is logged and shown, then cleared by the next line that goes out", async () => {
    const { c, ws, errors } = await openClient();
    ws.throwOnSend = true;
    expect(c.send("lost")).toBe(false);
    expect(errors.length).toBe(1);
    expect(String((errors[0] as Error).message)).toContain("socket send failed");
    expect(c.get().sendFailed).toBe(true);
    ws.throwOnSend = false;
    expect(c.send("again")).toBe(true);
    expect(c.get().sendFailed).toBe(false);
    c.stop();
  });

  it("logs to the console when no reporter is given", async () => {
    FakeWs.made = [];
    const warned: unknown[][] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => void warned.push(a);
    try {
      const c = createPartnerClient({
        url: "ws://localhost/api/version/debug",
        ticket: async () => "t1",
        open: () => new FakeWs(),
        label: () => "x",
        doc,
      });
      await new Promise((r) => setTimeout(r, 0));
      const ws = FakeWs.made[0];
      ws.open();
      ws.throwOnSend = true;
      expect(c.send("lost")).toBe(false);
      expect(warned.length).toBe(1);
      expect(String(warned[0][0])).toContain("send failed");
      c.stop();
    } finally {
      console.warn = orig;
    }
  });
});
