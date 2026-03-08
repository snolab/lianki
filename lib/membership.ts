import type { Document, Filter } from "mongodb";
import { db } from "@/app/db";

// better-auth stores users with _id as a string (not ObjectId)
const Users = db.collection<Document & { _id: string }>("user");

function userFilter(userId: string): Filter<Document & { _id: string }> {
  return { $or: [{ _id: userId }, { id: userId }] } as Filter<Document & { _id: string }>;
}

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
 * Automatically grants 90-day trial to new users
 */
export async function getUserMembership(userId: string): Promise<UserMembership> {
  // better-auth mongodbAdapter stores users with _id as the document ID
  const user = await Users.findOne(userFilter(userId));

  if (!user) {
    throw new Error("User not found");
  }

  // Auto-grant 90-day trial to users who don't have one
  if (!user.trialEndsAt && !user.proEndsAt) {
    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + 90);

    await Users.updateOne(userFilter(userId), {
      $set: {
        trialEndsAt,
        updatedAt: new Date(),
      },
    });

    // Return the newly granted trial
    return {
      userId: user.id,
      email: user.email,
      tier: "trial",
      trialEndsAt,
      proEndsAt: undefined,
      createdAt: user.createdAt ? new Date(user.createdAt) : new Date(),
      updatedAt: new Date(),
    };
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
 * Start a trial for a user (90 days)
 */
export async function startTrial(userId: string): Promise<void> {
  const trialEndsAt = new Date();
  trialEndsAt.setDate(trialEndsAt.getDate() + 90);

  await Users.updateOne(
    { $or: [{ _id: userId }, { id: userId }] },
    {
      $set: {
        trialEndsAt,
        updatedAt: new Date(),
      },
    },
  );
}
