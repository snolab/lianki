---
title: "Lianki's Architecture: Next.js 16 + MongoDB"
date: 2025-02-01
tags: [architecture, nextjs, mongodb, typescript]
summary: "A walkthrough of the tech stack, data model, and key design decisions in Lianki."
---

# Lianki's Architecture: Next.js 16 + MongoDB

This post walks through how Lianki is built: the stack choices, data model, API design, and a few implementation patterns that turned out to be useful.

## Stack Overview

| Layer           | Technology              |
| --------------- | ----------------------- |
| Framework       | Next.js 16 (App Router) |
| Language        | TypeScript 5            |
| Runtime         | Node.js 20 / Bun        |
| Database        | MongoDB                 |
| Auth            | NextAuth.js v5          |
| Styling         | Tailwind CSS            |
| Package manager | Bun                     |
| Deploy          | Vercel                  |

Next.js 16 with App Router was chosen because it collapses frontend and API into one project, Vercel deployment is frictionless, and React Server Components reduce client bundle size for a mostly-read UI.

MongoDB was chosen over a relational database because the primary document — an FSRS card — is a rich nested object that changes shape as the FSRS algorithm evolves. Fitting it into a rigid schema would mean repeated migrations. MongoDB lets the card object be stored as-is.

## Data Model

Each user's cards live in a MongoDB collection named `FSRSNotes@{email}`. Per-user collections instead of a shared collection with a user ID field keeps queries simple (no `userId` filter needed) and makes data isolation explicit.

A single document looks like:

```typescript
type FSRSNote = {
  url: string; // Normalized URL — the unique key
  title?: string; // Page title at time of saving
  card: Card; // Full FSRS card state
  log?: CardLogItem[]; // Review history (pushed on each review)
};
```

The `Card` type comes directly from `ts-fsrs` and contains: `due`, `stability`, `difficulty`, `elapsed_days`, `scheduled_days`, `reps`, `lapses`, `state`, and `last_review`.

There's no separate `users` table for card data — identity comes from the email used to derive the collection name. The NextAuth collections (`users`, `accounts`, `sessions`, `verificationTokens`) live separately in the same MongoDB database and are managed by `@auth/mongodb-adapter`.

## URL Normalization

Before any card is saved, its URL goes through normalization:

```typescript
function normalizeUrl(raw: string): string {
  const url = new URL(raw);

  // YouTube: youtu.be/ID → youtube.com/watch?v=ID
  if (url.hostname === "youtu.be") {
    return `https://www.youtube.com/watch?v=${url.pathname.slice(1)}`;
  }

  // Mobile subdomains: m.example.com → www.example.com
  if (url.hostname.startsWith("m.")) {
    url.hostname = "www." + url.hostname.slice(2);
  }

  // Strip tracking params
  const trackingParams = ["utm_source", "utm_medium", "utm_campaign",
    "utm_content", "utm_term", "fbclid", "gclid", "ref", ...];
  trackingParams.forEach(p => url.searchParams.delete(p));

  return url.toString();
}
```

This runs on both the server (in `/api/fsrs/add`) and the client (in the userscript). The result: you never accidentally create duplicate cards for the same content.

## API Routes

All card operations live under `/api/fsrs/`:

```
GET  /api/fsrs/add?url=...&title=...   Add a card
GET  /api/fsrs/options?id=...          Get review options (shows due dates per rating)
GET  /api/fsrs/review/:rating?id=...   Submit review
GET  /api/fsrs/next-url               Get URL of next due card
GET  /api/fsrs/delete?id=...          Delete a card
GET  /api/fsrs/next                   Redirect to next due card's review page
GET  /api/fsrs/all                    Open all due cards
GET  /api/fsrs/                       List all due cards
```

Most routes use GET even for mutations. This is a pragmatic choice — the userscript and browser-based flows make GET easier to work with (no CORS preflight, bookmarkable). It's not REST-pure but it works.

Authentication is checked on every route via NextAuth's `auth()` helper. Unauthenticated requests get a 401.

## Streaming with sflow

Card queries use the `sflow` library for streaming instead of loading all documents into memory at once:

```typescript
import { sflow } from "sflow";

const notes = await sflow(collection.find({ "card.due": { $lte: now } }).sort({ "card.due": 1 }))
  .take(50)
  .toArray();
```

`sflow` wraps MongoDB cursors in an async iterable pipeline. For users with large collections this avoids loading thousands of documents just to show the top 10 due cards.

## Auth Setup

NextAuth v5 is configured in `auth.ts` with three providers:

```typescript
export const { auth, handlers, signIn, signOut } = NextAuth({
  adapter: MongoDBAdapter(clientPromise),
  session: { strategy: "jwt" },
  providers: [
    Nodemailer({ server: process.env.EMAIL_SERVER, from: process.env.EMAIL_FROM }),
    GitHub({ clientId: process.env.AUTH_GITHUB_ID, clientSecret: process.env.AUTH_GITHUB_SECRET }),
    Google({ clientId: process.env.AUTH_GOOGLE_ID, clientSecret: process.env.AUTH_GOOGLE_SECRET }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) token.id = user.id;
      return token;
    },
    session({ session, token }) {
      session.user.id = token.id as string;
      return session;
    },
  },
});
```

GitHub and Google are conditional — if the environment variables aren't set, the providers aren't registered. This makes local development easier: you can run with just email auth and a local MongoDB.

## Tooling Choices

**Bun** is used as the package manager and runtime. Install times are significantly faster than npm/yarn and Bun's built-in TypeScript support means no ts-node needed for scripts.

**oxlint** handles linting. It's faster than ESLint and catches the things that matter (unused variables, wrong hook usage, etc.) without the ecosystem overhead. The `packages/` directory (git submodules) is excluded via `--ignore-pattern 'packages/**'`.

**oxfmt** handles formatting. It's a fast Prettier-compatible formatter. Pre-commit hooks run `bun fix` (lint + format) and `tsgo --noEmit` (TypeScript type check via `@typescript/native-preview`) on every commit.

## Environment Variables

Minimum required to run:

```env
MONGODB_URI=mongodb+srv://...
AUTH_SECRET=<random string>
```

Add email auth:

```env
EMAIL_SERVER=smtp://user:pass@host:port
EMAIL_FROM=noreply@yourdomain.com
```

Add OAuth:

```env
AUTH_GITHUB_ID=...
AUTH_GITHUB_SECRET=...
AUTH_GOOGLE_ID=...
AUTH_GOOGLE_SECRET=...
```

The Google OAuth credentials are shared between `fsrsnext.snomiao.com` (old domain) and `lianki.com`. Both callback URLs need to be registered in the Google Cloud Console.
