/**
 * Transient, text-only routing state for DebugHub. All methods are synchronous:
 * the authenticated caller runs them inside SitePermissionAuthority.withGrant.
 * No caller-selected origin, browser id or focus event grants authority here.
 */
import type {
  DictationFinal,
  DictationHubMessage,
  DictationRange,
  DictationRoute,
  DictationSelector,
  DictationTarget,
  DictationReturnReason,
} from "../packages/debug-chat/src/dictation-wire";

export type DictationPolicy = {
  leaseMs: number;
  pendingMs: number;
  maxQueued: number;
  maxRoutes: number;
  maxReceipts: number;
};
export type DictationPermit = { origin: string; revision: number };
type Source = { id: string; sgen: number };
type Receipt = {
  finalId: string;
  source: string;
  sgen: number;
  gen: number;
  routeId: string;
  seq: number;
  at: number;
  acceptedAt: number;
  text?: string;
  state: "queued" | "delivered" | "acked" | "returned" | "unconfirmed";
  why?: DictationReturnReason;
};
type Target = DictationTarget & {
  revision: number;
  expires: number;
  nextSeq: number;
  delivered: number;
  receipts: Receipt[];
};
type Session = {
  account: string;
  bid: string;
  source?: Source;
  target?: Target;
  receipts: Map<string, Receipt>;
};
export type DictationRouteResult =
  | { ok: true; kind: "route"; state: "listening" | "no-source" | "off"; gen: number }
  | { ok: false; error: "busy" | "stale" | "invalid" };

export class SharedDictationRouter {
  private sessions = new Map<string, Session>();
  constructor(
    private d: {
      now(): number;
      policy(): DictationPolicy;
      /** Authenticated source-page id, not a public broadcast or a host page DOM event. */
      send(account: string, bid: string, source: string, event: DictationHubMessage): void;
      wake(account: string, origin: string): void;
    },
  ) {}
  private key(account: string, bid: string) {
    return account + ":" + bid;
  }
  private session(account: string, bid: string): Session | undefined {
    return this.sessions.get(this.key(account, bid));
  }
  private ensure(account: string, bid: string): Session | undefined {
    const key = this.key(account, bid);
    let session = this.sessions.get(key);
    if (!session && this.sessions.size < this.d.policy().maxRoutes) {
      session = { account, bid, receipts: new Map() };
      this.sessions.set(key, session);
    }
    return session;
  }
  private send(session: Session, source: string, event: DictationHubMessage) {
    try {
      this.d.send(session.account, session.bid, source, event);
    } catch {
      /* The source retains its account-bound outbox. */
    }
  }
  private targetEvent(session: Session) {
    if (!session.source) return;
    const target = session.target;
    this.send(session, session.source.id, {
      type: "dictation-target",
      bid: session.bid,
      target: target ? { origin: target.origin, routeId: target.routeId, gen: target.gen } : null,
    });
  }
  private settle(
    session: Session,
    receipt: Receipt,
    state: "acked" | "returned" | "unconfirmed",
    why?: DictationReturnReason,
  ) {
    receipt.state = state;
    receipt.why = why;
    delete receipt.text;
    this.sendReceipt(session, receipt, receipt.source);
  }
  private sendReceipt(session: Session, receipt: Receipt, destination: string) {
    if (receipt.state === "acked")
      this.send(session, destination, { type: "dictation-acked", finalIds: [receipt.finalId] });
    else if (receipt.state === "returned")
      this.send(session, destination, {
        type: "dictation-returned",
        finalIds: [receipt.finalId],
        why: receipt.why ?? "rejected",
      });
    else if (receipt.state === "unconfirmed")
      this.send(session, destination, {
        type: "dictation-unconfirmed",
        finalIds: [receipt.finalId],
        why: receipt.why as "gone",
      });
  }
  private clear(session: Session, why: Exclude<DictationReturnReason, "rejected" | "full">) {
    const target = session.target;
    if (!target) return;
    delete session.target;
    for (const receipt of target.receipts) {
      if (receipt.state === "queued") this.settle(session, receipt, "returned", why);
      else if (receipt.state === "delivered") this.settle(session, receipt, "unconfirmed", why);
    }
    this.targetEvent(session);
    this.d.wake(session.account, target.origin);
  }
  /** Call from the hub alarm as well as before each operation. */
  sweep() {
    const now = this.d.now(),
      policy = this.d.policy();
    for (const session of this.sessions.values()) {
      if (session.target && session.target.expires <= now) this.clear(session, "expired");
      const target = session.target;
      if (target) {
        for (const receipt of target.receipts) {
          if (receipt.acceptedAt + policy.pendingMs > now) continue;
          if (receipt.state === "queued") this.settle(session, receipt, "returned", "expired");
          else if (receipt.state === "delivered")
            this.settle(session, receipt, "unconfirmed", "expired");
        }
        target.receipts = target.receipts.filter(
          (r) => r.state === "queued" || r.state === "delivered",
        );
      }
      for (const [id, receipt] of session.receipts)
        if (
          receipt.gen !== session.target?.gen &&
          receipt.acceptedAt + policy.pendingMs <= now &&
          receipt.state !== "queued" &&
          receipt.state !== "delivered"
        )
          session.receipts.delete(id);
      if (!session.target && !session.source && !session.receipts.size)
        this.sessions.delete(this.key(session.account, session.bid));
    }
  }
  nextExpiry(): number | null {
    let next = Infinity;
    for (const session of this.sessions.values()) {
      if (session.target) next = Math.min(next, session.target.expires);
      for (const r of session.target?.receipts ?? [])
        next = Math.min(next, r.acceptedAt + this.d.policy().pendingMs);
    }
    return Number.isFinite(next) ? next : null;
  }
  target(account: string, bid: string): (DictationTarget & { revision: number }) | null {
    this.sweep();
    const t = this.session(account, bid)?.target;
    return t ? { origin: t.origin, routeId: t.routeId, gen: t.gen, revision: t.revision } : null;
  }
  source(account: string, bid: string): Source | null {
    const s = this.session(account, bid)?.source;
    return s ? { ...s } : null;
  }
  /** Epoch is allocated by the hub's persisted, serialized generation counter. */
  sourceOn(account: string, bid: string, source: string, sgen: number): boolean {
    this.sweep();
    const session = this.ensure(account, bid);
    if (session?.source?.id === source) {
      this.send(session, source, {
        type: "dictation-source-ok",
        bid,
        sgen: session.source.sgen,
        principal: account,
      });
      this.targetEvent(session);
      return true;
    }
    if (!session || (session.source && session.source.sgen >= sgen)) return false;
    if (session.source) {
      const old = session.source;
      this.send(session, old.id, { type: "dictation-target", bid, target: null });
      this.dropQueued(session, old.id);
    }
    session.source = { id: source, sgen };
    this.send(session, source, { type: "dictation-source-ok", bid, sgen, principal: account });
    this.targetEvent(session);
    return true;
  }
  private dropQueued(session: Session, source: string) {
    const target = session.target;
    if (!target) return;
    for (const r of target.receipts)
      if (r.source === source && r.state === "queued") this.settle(session, r, "returned", "gone");
    target.receipts = target.receipts.filter(
      (r) => r.state === "queued" || r.state === "delivered",
    );
  }
  sourceOff(account: string, source: string, bid?: string) {
    this.sweep();
    for (const session of this.sessions.values()) {
      if (
        session.account !== account ||
        (bid !== undefined && session.bid !== bid) ||
        session.source?.id !== source
      )
        continue;
      this.dropQueued(session, source);
      this.send(session, source, { type: "dictation-target", bid: session.bid, target: null });
      delete session.source;
    }
  }
  route(
    account: string,
    origin: string,
    action: DictationRoute,
    permit: DictationPermit,
    epoch?: number,
  ): DictationRouteResult {
    this.sweep();
    if (permit.origin !== origin) return { ok: false, error: "invalid" };
    const session = this.ensure(account, action.bid);
    if (!session) return { ok: false, error: "busy" };
    if (action.state === "on") {
      if (!Number.isSafeInteger(epoch) || Number(epoch) < 1) return { ok: false, error: "invalid" };
      if (session.target && Number(epoch) <= session.target.gen)
        return { ok: false, error: "stale" };
      this.clear(session, "target-changed");
      session.target = {
        origin,
        routeId: action.routeId,
        gen: epoch!,
        revision: permit.revision,
        expires: this.d.now() + this.d.policy().leaseMs,
        nextSeq: 0,
        delivered: 0,
        receipts: [],
      };
      this.targetEvent(session);
    } else {
      const target = session.target;
      if (
        !target ||
        target.origin !== origin ||
        target.routeId !== action.routeId ||
        target.gen !== action.gen
      )
        return { ok: true, kind: "route", state: "off", gen: action.gen };
      if (target.revision !== permit.revision) {
        this.clear(session, "revoked");
        return { ok: true, kind: "route", state: "off", gen: action.gen };
      }
      if (action.state === "off") {
        this.clear(session, "gone");
        return { ok: true, kind: "route", state: "off", gen: action.gen };
      }
      target.expires = this.d.now() + this.d.policy().leaseMs;
    }
    return {
      ok: true,
      kind: "route",
      state: session.source ? "listening" : "no-source",
      gen: session.target!.gen,
    };
  }
  read(
    account: string,
    origin: string,
    selector: DictationSelector,
    permit: DictationPermit,
  ): { ok: true; range: DictationRange } | { ok: false; error: "stale" | "invalid" } {
    this.sweep();
    const session = this.session(account, selector.bid),
      target = session?.target;
    if (
      !session ||
      !target ||
      target.origin !== origin ||
      permit.origin !== origin ||
      target.revision !== permit.revision ||
      target.routeId !== selector.routeId ||
      target.gen !== selector.gen
    )
      return { ok: false, error: "stale" };
    const ack = selector.afterSeq ?? 0;
    if (ack > target.delivered) return { ok: false, error: "invalid" };
    for (const r of target.receipts)
      if (r.state === "delivered" && r.seq <= ack) this.settle(session, r, "acked");
    target.receipts = target.receipts.filter(
      (r) => r.state === "queued" || r.state === "delivered",
    );
    const items: DictationRange["items"] = [];
    for (const r of target.receipts) {
      if (items.length >= this.d.policy().maxQueued) break;
      r.state = "delivered";
      target.delivered = Math.max(target.delivered, r.seq);
      items.push({ seq: r.seq, finalId: r.finalId, text: r.text!, at: r.at });
    }
    return {
      ok: true,
      range: { routeId: target.routeId, gen: target.gen, throughSeq: target.delivered, items },
    };
  }
  final(account: string, source: string, message: DictationFinal, permit: DictationPermit | null) {
    this.sweep();
    const session = this.session(account, message.bid);
    const fail = (uncertain: boolean, why: DictationReturnReason) => {
      const event: DictationHubMessage = uncertain
        ? { type: "dictation-unconfirmed", finalIds: [message.finalId], why: why as "gone" }
        : { type: "dictation-returned", finalIds: [message.finalId], why };
      try {
        if (!session?.source || session.source.id !== source)
          this.d.send(account, message.bid, source, {
            type: "dictation-target",
            bid: message.bid,
            target: null,
          });
        this.d.send(account, message.bid, source, event);
      } catch {}
    };
    if (!session) {
      fail(true, "gone");
      return;
    }
    const key = message.sgen + ":" + message.gen + ":" + message.finalId;
    const old = session.receipts.get(key);
    if (old) {
      this.sendReceipt(session, old, source);
      return;
    }
    const target = session.target;
    if (!session.source || session.source.id !== source || session.source.sgen !== message.sgen) {
      fail(true, "gone");
      return;
    }
    if (!target || target.routeId !== message.routeId || target.gen !== message.gen) {
      fail(true, "target-changed");
      return;
    }
    if (!permit || permit.origin !== target.origin || permit.revision !== target.revision) {
      fail(false, "rejected");
      return;
    }
    // A final id is also unique within its route lease, across a source reconnect.
    const sameId = [...session.receipts.values()].find(
      (r) => r.gen === message.gen && r.finalId === message.finalId,
    );
    if (sameId) {
      this.sendReceipt(session, sameId, source);
      return;
    }
    if (session.receipts.size >= this.d.policy().maxReceipts) {
      // Do not evict live replay receipts to accept new text. End this lease so
      // a late retry can never become a new append after receipt eviction.
      this.clear(session, "gone");
      delete session.source;
      fail(false, "full");
      return;
    }
    if (target.receipts.length >= this.d.policy().maxQueued) {
      const rejected: Receipt = {
        finalId: message.finalId,
        source,
        sgen: message.sgen,
        gen: message.gen,
        routeId: message.routeId,
        seq: 0,
        at: message.at,
        acceptedAt: this.d.now(),
        state: "returned",
        why: "full",
      };
      session.receipts.set(key, rejected);
      this.sendReceipt(session, rejected, source);
      return;
    }
    const receipt: Receipt = {
      finalId: message.finalId,
      source,
      sgen: message.sgen,
      gen: message.gen,
      routeId: message.routeId,
      seq: ++target.nextSeq,
      at: message.at,
      acceptedAt: this.d.now(),
      text: message.text,
      state: "queued",
    };
    session.receipts.set(key, receipt);
    target.receipts.push(receipt);
    this.d.wake(account, target.origin);
  }
  stop(account: string, bid: string, source: string) {
    const session = this.session(account, bid);
    if (session?.source?.id === source) this.clear(session, "gone");
  }
  revoke(account: string, origin?: string) {
    for (const session of this.sessions.values())
      if (session.account === account && (!origin || session.target?.origin === origin))
        this.clear(session, "revoked");
  }
  /** A flag transition retires source and target leases, retaining only replay receipts. */
  disable(account?: string) {
    for (const session of this.sessions.values()) {
      if (account !== undefined && session.account !== account) continue;
      this.clear(session, "revoked");
      if (session.source) {
        this.send(session, session.source.id, {
          type: "dictation-target",
          bid: session.bid,
          target: null,
        });
        delete session.source;
      }
    }
  }
}
