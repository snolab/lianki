/** Isolate-local diagnostics, with no polling, timers, user IDs or message text. */
export class HubWork {
  readonly startedAt: number;
  private lastActiveAt: number | null = null;
  private pending = new Map<number, { method: string; since: number }>();
  private next = 0;
  constructor(private now = Date.now) {
    this.startedAt = now();
  }
  touch() {
    this.lastActiveAt = this.now();
  }
  async run<T>(method: string, work: () => Promise<T>): Promise<T> {
    const id = ++this.next;
    this.touch();
    this.pending.set(id, { method, since: this.now() });
    try {
      return await work();
    } finally {
      this.pending.delete(id);
      this.touch();
    }
  }
  snapshot() {
    return {
      startedAt: this.startedAt,
      lastActiveAt: this.lastActiveAt,
      observedAt: this.now(),
      pendingRpc: this.pending.size,
      calls: [...this.pending.values()].map(({ method, since }) => ({ method, since })),
    };
  }
}
export type HubWorkSnapshot = ReturnType<HubWork["snapshot"]>;
