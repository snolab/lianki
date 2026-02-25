import { db } from "@/app/db";
import { authUser } from "@/app/signInEmail";

const Users = db.collection("user");

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

/**
 * Get user's current membership status
 */
export async function getUserMembership(userId: string): Promise<UserMembership> {
  const user = await Users.findOne({ id: userId });

  if (!user) {
    throw new Error("User not found");
  }

  const now = new Date();
  let tier: MembershipTier = "free";

  // Check pro membership
  if (user.proEndsAt && new Date(user.proEndsAt) > now) {
    tier = "pro";
  }
  // Check trial membership
  else if (user.trialEndsAt && new Date(user.trialEndsAt) > now) {
    tier = "trial";
  }

  return {
    userId: user.id,
    email: user.email,
    tier,
    trialEndsAt: user.trialEndsAt ? new Date(user.trialEndsAt) : undefined,
    proEndsAt: user.proEndsAt ? new Date(user.proEndsAt) : undefined,
    createdAt: user.createdAt ? new Date(user.createdAt) : new Date(),
    updatedAt: user.updatedAt ? new Date(user.updatedAt) : new Date(),
  };
}

/**
 * Check if user has access to pro features
 */
export async function hasProAccess(userId: string): Promise<boolean> {
  const membership = await getUserMembership(userId);
  return membership.tier === "pro" || membership.tier === "trial";
}

/**
 * Require pro access, redirect if not authorized
 */
export async function requireProAccess() {
  const user = await authUser();
  const hasAccess = await hasProAccess(user.id);

  if (!hasAccess) {
    throw new Error("Pro membership required");
  }

  return user;
}

/**
 * Start a trial for a user (7 days)
 */
export async function startTrial(userId: string): Promise<void> {
  const trialEndsAt = new Date();
  trialEndsAt.setDate(trialEndsAt.getDate() + 7);

  await Users.updateOne(
    { id: userId },
    {
      $set: {
        trialEndsAt,
        updatedAt: new Date(),
      },
    },
  );
}

/**
 * Grant pro membership to a user
 */
export async function grantProMembership(userId: string, durationDays: number): Promise<void> {
  const proEndsAt = new Date();
  proEndsAt.setDate(proEndsAt.getDate() + durationDays);

  await Users.updateOne(
    { id: userId },
    {
      $set: {
        proEndsAt,
        updatedAt: new Date(),
      },
    },
  );
}
