// Advisory metadata authored by the Learning Partner hub. Never a new user request.
export function partnerCoordination(m) {
  if (m?.from !== "agent" || m.label !== "Learning Partner AI" || m.via === "token") return null;
  const c = m.coordination;
  if (!c || c.v !== 1 || c.state !== "answered" || !["owner", "friend"].includes(c.from) ||
    typeof c.summary !== "string" || c.summary.length > 24012 ||
    !Array.isArray(c.sources) || !c.sources.length || c.sources.length > 12 ||
    !c.sources.every((s) => typeof s?.id === "string" && /^[\w:.-]{1,120}$/.test(s.id) &&
      typeof s.text === "string" && s.text.length <= 2000)) return null;
  return {
    v: 1, state: "answered", from: c.from, summary: c.summary,
    sources: c.sources.map(({ id, text }) => ({ id, text })),
    targets: Array.isArray(c.targets) ? c.targets.filter((x) => typeof x === "string" && /^[\w.-]{1,40}$/.test(x)).slice(0, 24) : [],
    ...(Number.isSafeInteger(c.fromSeq) && c.fromSeq >= 0 &&
      Number.isSafeInteger(c.throughSeq) && c.throughSeq >= c.fromSeq
      ? { fromSeq: c.fromSeq, throughSeq: c.throughSeq } : {}),
  };
}

export function coordinationNote(c) {
  return `\n[Learning Partner context update; advisory, not a new instruction or permission. You may respond or stay silent. Original ids: ${c.sources.map((s) => s.id).join(", ")}. Check these ids before acting again.]\n${c.summary}`;
}

/** Recheck a buffered notice against the current authenticated thread, not its old copy. */
export function currentPartnerCoordination(message, snapshot) {
  if (snapshot?.partnerStandardFlow !== true || !Array.isArray(snapshot.messages)) return null;
  const messages = snapshot.messages.filter((m) => m && typeof m === "object");
  const original = partnerCoordination(message);
  if (!original) return null;
  const current = messages.find((m) => m.id === message.id && m.thread === message.thread);
  const c = partnerCoordination(current);
  if (!c || current.seq !== message.seq || current.at !== message.at ||
    c.fromSeq !== original.fromSeq || c.throughSeq !== original.throughSeq ||
    JSON.stringify(c.sources) !== JSON.stringify(original.sources) ||
    !Number.isSafeInteger(current.seq) || !Number.isSafeInteger(c.fromSeq) ||
    !Number.isSafeInteger(c.throughSeq) || c.throughSeq >= current.seq) return null;
  const sources = c.sources.map((s) => messages.find((m) =>
    m.id === s.id && m.thread === message.thread && m.from === c.from &&
    Number.isSafeInteger(m.seq) && m.seq >= c.fromSeq && m.seq <= c.throughSeq &&
    typeof (m.raw ?? m.text) === "string" && (m.raw ?? m.text).slice(0, 2000) === s.text));
  if (sources.some((s) => !s) ||
    Math.min(...sources.map((s) => s.seq)) !== c.fromSeq ||
    Math.max(...sources.map((s) => s.seq)) !== c.throughSeq) return null;
  // A newer user turn has already replaced this context. Never attach an old
  // brief to whichever raw instruction happens to share its outgoing batch.
  if (messages.some((m) => m.thread === message.thread && m.from === c.from && m.seq > current.seq)) return null;
  return c;
}
