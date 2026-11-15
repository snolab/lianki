import { describe, expect, test } from "bun:test";
import { createPendingFiles, type ChatFiles } from "../packages/debug-chat/src/files";
import { planPendingSend } from "../packages/debug-chat/src/pending-bubble";
import type { AttachmentRef } from "../packages/debug-chat/src/wire";

function fixture() {
  const calls: {
    file: File;
    progress: (n: number, total: number) => void;
    signal: AbortSignal;
    resolve: (ref: AttachmentRef) => void;
    reject: (error: unknown) => void;
  }[] = [];
  let host: ChatFiles | undefined = {
    scope: "a",
    url: () => "",
    upload: (file, progress, signal) =>
      new Promise((resolve, reject) => calls.push({ file, progress, signal, resolve, reject })),
  };
  const revoked: string[] = [];
  let urls = 0;
  const p = createPendingFiles({
    files: () => host,
    objectUrl: { create: () => `blob:${++urls}`, revoke: (url) => revoked.push(url) },
  });
  return {
    p,
    calls,
    revoked,
    host: (next: ChatFiles | undefined) => {
      host = next;
    },
  };
}
const ref = (id: string, file: File): AttachmentRef => ({
  id,
  name: file.name,
  type: file.type,
  size: file.size,
});
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("pending upload retry uses the existing host pipeline", () => {
  test("a synchronous cancel/account reset during notification cannot start a removed upload", () => {
    const f = fixture();
    const off = f.p.subscribe(() => {
      if (f.p.get().length) f.p.take();
    });
    f.p.add([new File(["private"], "private.txt")]);
    expect(f.calls).toEqual([]);
    expect(f.p.get()).toEqual([]);
    off();
  });
  test("multiple files retain order/progress and a partial failure retries only the failed file before one send", async () => {
    const f = fixture();
    const files = [
      new File(["1234"], "first.png", { type: "image/png" }),
      new File(["123456"], "second.png", { type: "image/png" }),
    ];
    f.p.add(files);
    const keys = f.p.get().map((file) => file.key);
    f.calls[0]!.progress(2, 4);
    f.calls[1]!.progress(3, 6);
    expect(f.p.get().map((file) => file.sent)).toEqual([2, 3]);
    f.calls[1]!.reject(Error("network"));
    f.calls[0]!.resolve(ref("first", files[0]!));
    await settle();
    expect(f.p.ready()).toBe(false);
    expect(planPendingSend({ text: "", files: f.p.get() })).toBeNull();
    expect(f.p.get().map((file) => file.state)).toEqual(["done", "failed"]);
    expect(f.p.retry(keys[0]!)).toBe(false);
    expect(f.p.retry(keys[1]!)).toBe(true);
    expect(f.calls).toHaveLength(3);
    expect(f.calls[2]!.file).toBe(files[1]);
    expect(f.p.get().map((file) => file.key)).toEqual(keys);
    expect(f.p.get().map((file) => file.thumb)).toEqual(["blob:1", "blob:2"]);
    expect(f.p.retry(keys[1]!)).toBe(false);
    f.calls[1]!.progress(6, 6); // stale attempt must not overwrite the retry's progress
    expect(f.p.get()[1]!.sent).toBe(0);
    f.calls[2]!.progress(4, 6);
    f.calls[2]!.resolve(ref("second", files[1]!));
    await settle();
    expect(f.p.ready()).toBe(true);
    const sent = planPendingSend({ text: "", files: f.p.get() })!;
    expect(sent.attachments.map((item) => item.id)).toEqual(["first", "second"]);
    f.p.take();
    expect(planPendingSend({ text: "", files: f.p.get() })).toBeNull();
    expect(f.p.ready()).toBe(false);
    expect(f.revoked).toEqual(["blob:1", "blob:2"]);
  });

  test("cancellation/account reset aborts in-flight work and ignores all stale callbacks", async () => {
    const f = fixture();
    const file = new File(["123"], "private.png", { type: "image/png" });
    f.p.add([file]);
    const key = f.p.get()[0]!.key;
    f.p.remove(key);
    expect(f.calls[0]!.signal.aborted).toBe(true);
    f.calls[0]!.progress(3, 3);
    f.calls[0]!.resolve(ref("stale", file));
    await settle();
    expect(f.p.get()).toEqual([]);
    expect(f.p.retry(key)).toBe(false);
    f.p.add([file]);
    f.p.take(); // the existing account-switch path
    expect(f.calls[1]!.signal.aborted).toBe(true);
    f.calls[1]!.reject(Error("late old account rejection"));
    await settle();
    expect(f.p.get()).toEqual([]);
    expect(f.revoked).toEqual(["blob:1", "blob:2"]);
  });

  test("retry cannot cross an account boundary or retry oversized/unavailable files", async () => {
    const f = fixture();
    const file = new File(["123"], "file.txt");
    f.p.add([file]);
    f.calls[0]!.reject(Error("failed"));
    await settle();
    const key = f.p.get()[0]!.key;
    f.host({ scope: "b", url: () => "", upload: async () => ref("wrong-account", file) });
    expect(f.p.retry(key)).toBe(false);
    f.host(undefined);
    expect(f.p.retry(key)).toBe(false);
    f.p.take();
    f.host({ scope: "a", maxBytes: 1, url: () => "", upload: async () => ref("too-big", file) });
    f.p.add([file]);
    expect(f.p.get()[0]!.state).toBe("too-big");
    expect(f.p.retry(f.p.get()[0]!.key)).toBe(false);
    expect(f.p.ready()).toBe(false);
  });

  test("snapshots are immutable, progress is bounded, and synchronous host failures remain retryable", async () => {
    const f = fixture();
    const file = new File(["123"], "file.txt");
    f.p.add([file]);
    f.calls[0]!.progress(10, 3);
    f.calls[0]!.progress(-1, 3);
    expect(f.p.get()[0]!.sent).toBe(3);
    const snap = f.p.get();
    expect(f.p.get()).toBe(snap);
    expect(() => {
      snap[0]!.name = "mutated";
    }).toThrow();
    expect(() => snap.pop()).toThrow();
    expect(f.p.get()[0]!.name).toBe("file.txt");
    const stored = ref("ready", file);
    f.calls[0]!.resolve(stored);
    await settle();
    stored.name = "host mutation";
    const completed = f.p.get();
    expect(completed).not.toBe(snap);
    expect(() => {
      completed[0]!.ref!.name = "render mutation";
    }).toThrow();
    expect(f.p.get()[0]!.ref!.name).toBe("file.txt");
    f.p.take();
    f.host({
      scope: "a",
      url: () => "",
      upload: () => {
        throw Error("synchronous upload failure");
      },
    });
    expect(() => f.p.add([file])).not.toThrow();
    expect(f.p.get()[0]!.state).toBe("failed");
  });
});
