import { isDev } from "@/lib/permissions";

type SessionLike = {
  session?: { expiresAt: Date; createdAt: Date; updatedAt: Date } | null;
  user?: {
    name?: string | null;
    email: string;
    emailVerified?: boolean | null;
    createdAt: Date;
    updatedAt: Date;
    id: string;
  } | null;
} | null;

/**
 * The raw session dump for diagnosing sign-in, on /dev/session. Internals never
 * go in user UI (docs/design-principles.md), so it lives on a /dev page, and it
 * still renders only for accounts with dev access, through the same gate.
 */
export function SessionDetailsCard({
  viewerEmail,
  title,
  session,
}: {
  viewerEmail: string | null | undefined;
  title?: string;
  session: SessionLike;
}) {
  if (!isDev(viewerEmail)) return null;
  return (
    <div
      data-testid="session-details"
      className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 mb-6"
    >
      {title && <h2 className="text-2xl font-semibold mb-4">{title}</h2>}
      <pre className="text-sm overflow-x-auto">
        {JSON.stringify(
          {
            session: session?.session
              ? {
                  expiresAt: session.session.expiresAt,
                  createdAt: session.session.createdAt,
                  updatedAt: session.session.updatedAt,
                  // token and ipAddress intentionally omitted
                }
              : null,
            user: session?.user
              ? {
                  name: session.user.name,
                  email: session.user.email,
                  emailVerified: session.user.emailVerified,
                  createdAt: session.user.createdAt,
                  updatedAt: session.user.updatedAt,
                  id: session.user.id,
                }
              : null,
          },
          null,
          2,
        )}
      </pre>
    </div>
  );
}
