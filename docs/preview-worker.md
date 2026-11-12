# Local Preview Worker deployments

`bun scripts/dev/deploy-preview.ts` builds and deploys `lianki-preview`, then invokes
`bun scripts/dev/broadcast-version.ts --build <id>`. This integration script
must be installed before deploying; a missing script fails before the build.
`--dry-run` prints the plan without running commands or sending a broadcast.
A full OpenNext build is still required; this does not promise a subsecond build.

The preview uses a separate D1 database, R2 bucket and deployment of
lianki-push's VersionHub (`lianki-push-preview`). It has no zone routes, cron,
production service binding or monitor consumer. Version sockets are forwarded
by `worker.preview.ts` to the preview hub. Production configuration is untouched.

## One-time setup

Creating resources and deploying requires the usual approval. Provision an
empty D1 database named `lianki-preview` and an R2 bucket named
`lianki-preview-blobs`. Apply `db/migrations` to **that preview database**;
the deploy command never runs migrations or copies production data.
Configure preview-only auth secrets on `lianki-preview`. No production secrets
are copied. OAuth providers need the preview callback URL registered separately.

Set these variables locally (never commit their values):

- `PREVIEW_ORIGIN=https://lianki-preview.<subdomain>.workers.dev`
- `PREVIEW_D1_DATABASE_ID`: the UUID of the separate preview D1 database
- `PREVIEW_PUBLISH_TOKEN`: a random secret of at least 32 characters
- Cloudflare credentials with access to those resources

Install the same publish token using the interactive secret prompt:

```sh
bunx wrangler secret put PREVIEW_PUBLISH_TOKEN --config workers/push/wrangler.preview.json
```

The push service accepts external `POST /internal/publish` only with this
bearer token. Service binding announcements still use the internal hostname.
Only version sockets and publication are implemented on this push deployment;
remote debug, progress and chat hubs are intentionally unavailable.

## Run

```sh
bun scripts/dev/deploy-preview.ts --dry-run
bun scripts/dev/deploy-preview.ts
```

The script generates `.wrangler/preview/wrangler.json` from
`wrangler.preview.json`, setting the isolated database UUID and auth origin.
The checked-in template is deliberately undeployable until that UUID is set.
Each invocation gets a fresh 20-character build ID even for uncommitted edits.
The same ID enters the Next build and its route fingerprints. The pipeline
builds the embed, runs OpenNext, generates fingerprints, checks public assets,
deploys preview push, deploys the app, and calls the broadcast integration.
Failures stop immediately. If broadcasting fails after deployment, the command
reports that partial success and exits nonzero; it never redeploys automatically.

The broadcast integration must send the bare build ID and the URL-encoded
fingerprints in `x-lk-fingerprints` to the preview push URL (derived from
`PREVIEW_ORIGIN`), with the bearer token. It must not default to production.
The existing hub computes `VersionNews` for each socket's previous build.

Local checks: `bun test unit/deploy-preview.test.ts` and `bun run typecheck`.
Cloud deployment and live WebSocket delivery require configured preview resources.
