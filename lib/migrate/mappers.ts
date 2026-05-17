// MongoDB document -> D1 row mappers for the migration.
// Pure functions, unit tested. Mongo dates arrive as JS Date objects.

type Doc = Record<string, unknown>;

/** Stringify a Mongo `id`/`_id` (ObjectId or string) to a plain string. */
export function idOf(doc: Doc): string {
  if (doc.id != null) return String(doc.id);
  if (doc._id != null) return String(doc._id);
  throw new Error("document has neither id nor _id");
}

/** Coerce a Date | ISO string to an ISO string, or null. */
export function asIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value) return value;
  return null;
}

function isoOrNow(value: unknown): string {
  return asIso(value) ?? new Date().toISOString();
}

// ── better-auth tables ───────────────────────────────────────────────────────

export function userRow(doc: Doc): Record<string, unknown> {
  return {
    id: idOf(doc),
    name: doc.name ?? null,
    email: doc.email,
    emailVerified: doc.emailVerified ? 1 : 0,
    image: doc.image ?? null,
    createdAt: isoOrNow(doc.createdAt),
    updatedAt: isoOrNow(doc.updatedAt),
    trialEndsAt: asIso(doc.trialEndsAt),
    proEndsAt: asIso(doc.proEndsAt),
  };
}

export function sessionRow(doc: Doc): Record<string, unknown> {
  return {
    id: idOf(doc),
    userId: String(doc.userId),
    token: doc.token,
    expiresAt: isoOrNow(doc.expiresAt),
    ipAddress: doc.ipAddress ?? null,
    userAgent: doc.userAgent ?? null,
    createdAt: isoOrNow(doc.createdAt),
    updatedAt: isoOrNow(doc.updatedAt),
  };
}

export function accountRow(doc: Doc): Record<string, unknown> {
  return {
    id: idOf(doc),
    userId: String(doc.userId),
    accountId: doc.accountId,
    providerId: doc.providerId,
    accessToken: doc.accessToken ?? null,
    refreshToken: doc.refreshToken ?? null,
    idToken: doc.idToken ?? null,
    accessTokenExpiresAt: asIso(doc.accessTokenExpiresAt),
    refreshTokenExpiresAt: asIso(doc.refreshTokenExpiresAt),
    scope: doc.scope ?? null,
    password: doc.password ?? null,
    createdAt: isoOrNow(doc.createdAt),
    updatedAt: isoOrNow(doc.updatedAt),
  };
}

export function verificationRow(doc: Doc): Record<string, unknown> {
  return {
    id: idOf(doc),
    identifier: doc.identifier,
    value: doc.value,
    expiresAt: isoOrNow(doc.expiresAt),
    createdAt: asIso(doc.createdAt),
    updatedAt: asIso(doc.updatedAt),
  };
}

// ── app tables ───────────────────────────────────────────────────────────────

export function fsrsNoteRow(userId: string, doc: Doc): Record<string, unknown> {
  const card = (doc.card ?? {}) as Doc;
  return {
    user_id: userId,
    url: doc.url,
    title: doc.title ?? null,
    card: doc.card ?? {},
    log: doc.log ?? [],
    notes: doc.notes ?? null,
    speed_markers: doc.speedMarkers ?? null,
    hlc: doc.hlc ?? null,
    device_id: doc.deviceId ?? null,
    card_due: isoOrNow(card.due),
  };
}

export function roadmapGoalRow(userId: string, doc: Doc): Record<string, unknown> {
  return {
    id: idOf(doc),
    user_id: userId,
    topic: doc.topic,
    nodes: doc.nodes ?? [],
    created_at: isoOrNow(doc.createdAt),
    updated_at: isoOrNow(doc.updatedAt),
  };
}

export function preferenceRow(doc: Doc): Record<string, unknown> {
  return {
    user_id: String(doc.userId),
    mobile_exclude_patterns: doc.mobileExcludePatterns ?? [],
    updated_at: isoOrNow(doc.updatedAt),
  };
}

export function apiTokenRow(doc: Doc): Record<string, unknown> {
  return {
    token_hash: doc.tokenHash,
    email: doc.email,
    name: doc.name ?? "",
    created_at: isoOrNow(doc.createdAt),
  };
}
