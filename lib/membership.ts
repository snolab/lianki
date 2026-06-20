import { ObjectId } from "mongodb";
import { db } from "@/app/db";
import { dbBackend, getD1 } from "@/lib/d1";
import type { D1Like } from "@/lib/d1/types";
import { MembershipD1Repo } from "@/lib/repos/d1Repos";

export type MembershipTier = "free" | "trial" | "pro";

export interface UserMembership {
  userId: string;
  email: string;
  tier: MembershipTier;
  trialEndsAt?: Date;
  proEndsAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const TRIAL_DAYS = 90;

function trialEnd(from = new Date()): Date {
  const end = new Date(from);
  end.setDate(end.getDate() + TRIAL_DAYS);
  return end;
}

function toDate(v: unknown): Date | undefined {
  if (v == null) return undefined;
  const d = new Date(v as string | number | Date);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Resolve the active membership tier from raw expiry dates. Pro outranks trial. */
export function tierFor(trialEndsAt?: Date, proEndsAt?: Date, now = new Date()): MembershipTier {
  if (proEndsAt && proEndsAt > now) return "pro";
  if (trialEndsAt && trialEndsAt > now) return "trial";
  return "free";
}

/** Backend-neutral view of the membership fields on a user. */
export type MembershipUser = {
  id: string;
  email: string;
  trialEndsAt?: Date;
  proEndsAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
};

/**
 * Storage abstraction so the membership logic (auto-grant, tier resolution) is
 * identical across MongoDB and D1. Inject one in tests; production resolves it
 * from the active DB backend.
 */
export interface MembershipStore {
  get(userId: string): Promise<MembershipUser | null>;
  grantTrial(userId: string, trialEndsAt: Date): Promise<void>;
}

// ── MongoDB store ──────────────────────────────────────────────────────────────

function mongoUserFilter(userId: string) {
  // better-auth's mongodbAdapter may store the id in `id` or `_id` (string or ObjectId).
  const candidates: Record<string, unknown>[] = [{ _id: userId }, { id: userId }];
  try {
    candidates.push({ _id: new ObjectId(userId) });
  } catch {
    // not a valid ObjectId string — skip
  }
  return { $or: candidates };
}

function mongoStore(): MembershipStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Users = db.collection<any>("user");
  return {
    async get(userId) {
      const u = await Users.findOne(mongoUserFilter(userId));
      if (!u) return null;
      return {
        id: u.id,
        email: u.email,
        trialEndsAt: toDate(u.trialEndsAt),
        proEndsAt: toDate(u.proEndsAt),
        createdAt: toDate(u.createdAt),
        updatedAt: toDate(u.updatedAt),
      };
    },
    async grantTrial(userId, trialEndsAt) {
      await Users.updateOne(mongoUserFilter(userId), {
        $set: { trialEndsAt, updatedAt: new Date() },
      });
    },
  };
}

// ── D1 store ────────────────────────────────────────────────────────────────────

/** Build a MembershipStore over a D1 database (exported for tests). */
export function d1MembershipStore(d1: D1Like): MembershipStore {
  const repo = new MembershipD1Repo(d1);
  return {
    async get(userId) {
      const row = await repo.getUser(userId);
      if (!row) return null;
      return {
        id: row.id,
        email: row.email,
        trialEndsAt: toDate(row.trialEndsAt),
        proEndsAt: toDate(row.proEndsAt),
        createdAt: toDate(row.createdAt),
        updatedAt: toDate(row.updatedAt),
      };
    },
    grantTrial: (userId, trialEndsAt) => repo.setTrial(userId, trialEndsAt),
  };
}

/** The store for the active backend. On D1 this is valid only inside a request. */
function currentStore(): MembershipStore {
  return dbBackend() === "d1" ? d1MembershipStore(getD1()) : mongoStore();
}

// ── Public API ───────────────────────────────────────────────────────────────────

/**
 * Get a user's current membership, auto-granting a 90-day trial to users who
 * have neither a trial nor pro on record. `store` is injectable for tests;
 * production uses the active DB backend.
 */
export async function getUserMembership(
  userId: string,
  store: MembershipStore = currentStore(),
): Promise<UserMembership> {
  const user = await store.get(userId);
  if (!user) throw new Error("User not found");

  const now = new Date();

  // Auto-grant a 90-day trial to users who have neither trial nor pro.
  if (!user.trialEndsAt && !user.proEndsAt) {
    const trialEndsAt = trialEnd(now);
    await store.grantTrial(userId, trialEndsAt);
    return {
      userId: user.id,
      email: user.email,
      tier: "trial",
      trialEndsAt,
      proEndsAt: undefined,
      createdAt: user.createdAt ?? now,
      updatedAt: now,
    };
  }

  return {
    userId: user.id,
    email: user.email,
    tier: tierFor(user.trialEndsAt, user.proEndsAt, now),
    trialEndsAt: user.trialEndsAt,
    proEndsAt: user.proEndsAt,
    createdAt: user.createdAt ?? now,
    updatedAt: user.updatedAt ?? now,
  };
}

/** Start (or reset) a 90-day trial for a user. `store` is injectable for tests. */
export async function startTrial(
  userId: string,
  store: MembershipStore = currentStore(),
): Promise<void> {
  await store.grantTrial(userId, trialEnd());
}
