# Monitoring and alerts

`lianki-monitor` (`workers/monitor`) watches the `lianki` Worker and posts to
Slack #lianki. Deployed by `deploy-worker.yml` before the main Worker, which
names it as its tail consumer.

**Event-driven only — no cron, no polling** (an owner rule for the whole
system). It acts on the tail event of every real request: wall/CPU time,
status and outcome go to Analytics Engine, and it alerts on ≥3 errors or ≥5
requests over 5 s within 10 minutes. On a later request, once 10 minutes have
passed with none, it says the burst is over. The flip side: with no traffic
there are no events, so a site nobody is visiting raises nothing.

Thresholds live in `workers/monitor/src/rules.ts` (unit-tested). An alert
repeats at most every 30 minutes (KV `lianki-monitor-state`).

**Slack.** Set one secret on `lianki-monitor` (dashboard → Workers →
lianki-monitor → Settings → Variables and secrets, or `wrangler secret put
-c workers/monitor/wrangler.jsonc`): `SLACK_WEBHOOK_URL` (an incoming webhook
for #lianki), or `SLACK_BOT_TOKEN` (the bot must be in #lianki). Without one,
alerts are only logged (`monitor.alert` in the Worker's logs).

**Metrics.** Analytics Engine dataset `lianki_metrics`: `index1` is `req`; blobs are kind, path, status, outcome/error, method; doubles are
wall ms and CPU ms. Query with the SQL API, e.g.

```sql
SELECT blob2 AS path, quantileWeighted(0.95)(double1, _sample_interval) AS p95_ms, count() AS n
FROM lianki_metrics WHERE index1 = 'req' AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY path ORDER BY n DESC
```
