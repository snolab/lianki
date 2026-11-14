# Chat recovery and read watermarks

Each thread reuses its existing Durable Object sequence counter. A stored line
carries one `seq`: its current version. Posting, editing or answering allocates a
new sequence in that thread; an update replaces the previous stored version,
keeping its message ID and logical display time. The recovery protocol also
supports `{id, seq, removed:true}` tombstones within that bounded window;
existing withdrawal operations retain their current row semantics.
The row, counter, superseded key and pruning changes commit atomically before
publication. Unmerge never renumbers another line's sequence.

`at` remains stable on updates. New messages sharing a display timestamp receive
a sub-millisecond logical ordering adjustment, rather than another stored sort
field. Actual speech timing measurements are unchanged. Legacy equal timestamps
use a stable ID tie-break; display order never depends on a mutable version seq.

## Recovering missing state

A page asks its authenticated socket for
`{type:"replay", afterSeq, throughSeq?}`: exclusive lower bound, optional
inclusive upper bound. The `history` response contains current `messages`,
`removed` tombstones, `afterSeq`, covered `throughSeq`, current `headSeq`,
`prunedThroughSeq`, and `skipped` ranges. A reply covers at most config
`chat.replayBatch` sequences (default 100); larger gaps take several batches.

Skipped sequences include merged or suppressed input receipts and superseded
versions. They are covered gaps, not messages waiting to arrive. Pruned history
is explicitly reported rather than retried forever. Live mutation events carry
a full current message, so missing one text edit and receiving a later answer
still restores the whole current state.

The client keeps recovery coverage separately from the durable send-acceptance
cursor. It merges by message ID and latest seq in place, ignores stale versions,
and applies newer tombstones. Reconnection uses known coverage only for the same
account and thread. Old caches without seq remain compatible with an initial
snapshot. This does not reload the page, and receiving or recovering data does
not prove that anybody read it. Retention is finite: pruned messages cannot be
recovered from this hot history protocol.

## Read receipts

Only visible message text inside an open, visible chat advances a page's
`lastReadSeq`. Being in cached history, outside the scroll viewport, in a hidden
page, or merely delivered by a socket does not count. This is a last-read
watermark, not a per-message proof that every earlier word was inspected.

A page sends `{type:"read", lastReadSeq}`. An agent explicitly reports consumed
messages using HTTP `POST /api/version/chat`
`{op:"read-ack", lastReadSeq}` or the token socket's
`{type:"read-ack", lastReadSeq}`. These need `chat:read`; the identity and thread
come from authentication, never the request. The CLI exposes
`lianki chat seen --seq N`, and MCP exposes `lianki_chat_seen`. Passive
`listen`/`chat_wait` and `chat_read` never acknowledge consumption automatically.
For incremental token reads, use `op:"read"` with `afterSeq`/`throughSeq`, or
`lianki chat read --after-seq N --through-seq M --json`.

The hub clamps read positions to the thread's head, never moves them backwards,
and stores one integer per page/token participant. Config
`chat.readReceiptThrottleMs` defaults to 2000 ms and cannot go below it. A burst
coalesces to its greatest observed cursor with one bounded trailing timer;
there is no periodic timer, polling loop, or read-receipt alarm keeping an idle
DO awake. An acknowledgement response reports the cursor actually stored.

Presence carries the current cursors. The page shows small avatar dots beneath
its latest own line only when the hub confirms that the viewer owns this thread.
It excludes this page's own dot and limits the display using `chat.presenceShown`.
There are no numeric badges or protocol fields in the UI. Dots represent
currently listed presence participants; this is not a permanent offline reader
roster. Their cursor survives reconnect, but their avatar follows the existing
presence lifetime. A receipt is not a delivery acknowledgement or a trusted
identity/voiceprint claim.

## Cost and storage

The additional logical state is **one integer per retained line** and **one
integer per participant**, reusing the thread counter and existing presence
metadata. There is no per-message reader array and no additional R2 object.
Supported tombstones fit inside the existing retention window; no second
update journal is stored. DO key and serialized-record overhead still applies.

Work comes from bounded range reads, transactional row replacements, changed
cursor writes and the existing presence broadcasts. Token acknowledgements also
refresh existing token-presence bookkeeping. No unchanged cursor is written on
a periodic loop. While the object is awake, the minimum throttle coalesces a continuously
progressing participant to one cursor commit per two seconds. The throttle
clock is volatile and resets on a cold wake; it is not a durable abuse quota.
Normal activity and no new visible text produce far fewer operations. This is
not a dollar-price estimate: actual cost depends on active participants,
message/update volume, retention reads and the applicable platform plan.

New CLI/MCP client behavior is in the repository; an installed npm CLI needs a
release to receive it. Deploy compatible hub protocol and frontend together.
