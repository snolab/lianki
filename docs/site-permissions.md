# Website permissions: initial page.read boundary

This change is under development, not an available execution or private-data capability.

`/chat/sites` manages the signed-in account's exact HTTPS origins. Every origin starts with `page.read` off. Adding an origin creates a disabled record; the normal first-party seal switch explicitly enables or revokes it. A domain's subdomains and similar spellings do not inherit permission. URL parameters preselect an origin only; they never authorize it.

## First-party management versus browser bridge

`POST /api/chat/site-permissions` accepts only `list`, `inspect`, and `set`, using the first-party session, JSON/Origin/Sec-Fetch-Site protection, and no Authorization header. The separate cookie-only GM bridge at `/api/chat/site-page-read` accepts only an exact-origin `status` request or a bounded `consume` of selected text. It cannot set or list permissions.

The GM origin is a grant selector, not independent server attestation of the host page. This initial scope therefore processes only caller-supplied selected-page text. It returns no private account data, executes no code and cannot pair devices, mint tokens, change settings, record, delete or pay. Those capabilities must not reuse this origin assertion as authority.

`src/site-page-read.ts` performs no network or selection access on construction. Its explicit `readSelection()` callback checks the current site's grant before calling `document.getSelection()`. It strips query/fragment identifiers, sends bounded selected text rather than the page body, and returns a result for the composer; it never posts a chat message. The status response includes a non-authorizing account/site binding, which must still match at consumption, so a pending read cannot cross a login-account switch.

The main chat UI callback adapts this result to `onShareSelection(): Promise<{ok:true;text:string}|{ok:false;manageUrl:string}>`. Integration waits for the shared main-chat component change; no replacement chat UI is introduced here.

## Private authority

The main Worker signs a 60-second, one-use capability for `lianki-site-action-v1`, including account, exact origin, operation mode, grant revision, action digest and random receipt identity. List operations have no origin; status inspection cannot be repurposed into a grant. Selected text is signed by digest, not persisted in the permission authority. This scope has no chat-thread write target.

The capability stays inside the private `PUSH` binding. The existing DebugHub holds the authoritative permission records, using a serialized queue and one atomic storage write that includes both revision changes and consumed receipts. No new Durable Object binding or database migration is needed. Responses rebuild an allowlist of public fields and never include signed capabilities or account identifiers.

Every explicit set, including off-to-off, advances the revision. A revoked or replaced revision cannot consume a pending read. A successful revoke response follows persistence; subsequent old-revision operations fail. Page reads are individual bounded actions with no persistent stream. Future streaming/execution would need separate cancellation and origin-attestation design. Already completed actions are not reversed by revocation.

Storage failure rejects the operation and does not leave a grant cached as enabled. Grant records and live replay receipts are bounded; capacity pressure rejects operations rather than evicting live receipts or silently granting access. Existing disabled origins remain revocable at capacity.

## Verification

Use synthetic accounts, exact/similar/subdomain origins and synthetic signing keys. Cover default-off, management-CSRF and bearer rejection, cross-account binding, wrong audience/digest/revision, expiry/replay, atomic concurrent revoke/read, bounded storage and failed writes. Browser proof should exercise the first-party management UI and only explicit selection sharing on an authorized site. Do not start real devices or infer permission for execution or private-data scopes.
