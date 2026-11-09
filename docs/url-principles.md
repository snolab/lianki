# URL principles

Owner-approved 2026-11-09, after his note: "if we are showing a feature it
should be a 名詞 instead of 動詞". Read this before adding or renaming a route.

1. **Nouns, not verbs.** A URL names a thing the user visits, not an action:
   `/reader`, `/notes`, `/imports`. Not `/read`, `/add-note`, `/import`.
2. **Actions live below the noun.** `/notes/new`, `/notes/<id>/edit`,
   `/imports/new`. The verb is a sub-path or an HTTP method, never the page
   name.
3. **Collections plural, tools singular.** `/books` and `/books/<id>` are
   collections; `/reader`, `/alphabet`, `/lab` are single tools.
4. **Lowercase ASCII, hyphen-separated.** No underscores, camelCase, spaces or
   non-ASCII in paths. Display names are translated; paths are not.
5. **Hierarchy shows ownership and audience.** `/lab/<x>` experiments;
   `/dev/<x>` developer pages, guarded by a permission check; `/api/<x>`
   machine interfaces.
6. **Language never in a feature path.** App routes carry the locale in
   `?lang=` (or the `lang` cookie); only the landing page and the blog keep a
   `/{locale}/` prefix (`lib/app-locale.ts`). Feature names never carry a
   language.
7. **One noun everywhere.** The web route, the extension and userscript links,
   the docs and the chat links use the same noun. An `/api/<x>` path may keep
   its old name while its page moves; rename it in its own change.
8. **Opaque IDs.** `<id>` is a generated id, never user text; no dates or
   counters in paths.
9. **Never break an old URL.** Renaming a route always ships a permanent
   redirect (308) from the old path, subpaths and query kept, kept
   indefinitely (saved links, PWA shortcuts, notifications, the userscript).
   Add a row to `MOVED_ROUTES` in `lib/moved-routes.ts`; `middleware.ts`
   answers the old path, with or without a legacy locale prefix, in one hop.
   Never remove a row.
10. **Gates are permissions, not paths.** Who may open a page is decided by a
    permission check (`isAdmin`, `isDev`, …), never by a hidden or guessable
    URL.

## /my: the user's own data (owner's decision, 2026-11-10 02:08 JST)

`/my` is the user's manager for **all** their Lianki data, one place for
everything that is theirs:

| Path              | Holds                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------- |
| `/my`             | the index: one card per kind of data (profile, preferences, files, cards and sync)    |
| `/my/profile`     | name, picture, email, passkeys, level (was `/profile`)                                 |
| `/my/preferences` | preferences and settings, API tokens (was `/preferences`)                              |
| `/my/files`       | every stored file in folders by origin (inbox_item `source`): Open, delete (docs/import-material.md, "My Files") |

Signed-in only: a guest is sent to sign in (except the guest level card on
`/my/profile`, as before). Never owner-only. A new user-level settings page
goes under `/my/<noun>`, not at the top level; `/dev/<x>` stays separate.
`/profile` and `/preferences` 308 to their `/my/…` pages, subpaths and query
kept (`lib/moved-routes.ts`); the `/api/profile` and `/api/preferences` names
are unchanged (rule 7). The account menu's "My data" (我的数据) opens `/my`.

## A rename, step by step

1. Move the route folder; fix its own links, `generateAppHreflangMetadata`
   paths and `router.push` calls.
2. Add the `MOVED_ROUTES` row, and a case for it in `unit/moved-routes.test.ts`.
3. Update the sidebar (`lib/app-nav.ts`), the search palette
   (`lib/nav/islands/SearchPalette.tsx`), `APP_ROUTES` in `lib/app-locale.ts`
   (the new top segment; drop the old one), `public/manifest.json`, the
   userscript and extension, QA route lists (`scripts/qa`, `tests/`) and docs.
4. `git grep` the old path once more before pushing.

## Candidate renames (to review, not decided)

| Today                                                                             | Noun form                        | Note                               |
| --------------------------------------------------------------------------------- | -------------------------------- | ---------------------------------- |
| `/read`, `/read/<id>`                                                             | `/reader`, `/reader/<id>`        | done 2026-11-09                    |
| `/add-note`                                                                       | `/notes/new`                     | verb → noun + `new`                |
| `/import`                                                                         | `/imports` (`/imports/new`)      | verb → noun                        |
| `/learn`                                                                          | `/learning` or `/courses`        | owner to choose                    |
| `/review`                                                                         | `/reviews` or keep               | "review" is already a noun; decide |
| `/profile`, `/preferences`                                                        | `/my/profile`, `/my/preferences` | done 2026-11-10                    |
| `/ai-vocab`, `/polyglot`                                                          | `/lab/ai-vocab`, `/lab/polyglot` | done 2026-11-09                    |
| `/words`, `/books`, `/sites`, `/alphabet`, `/data`, `/membership`                | keep                             | already nouns                      |
