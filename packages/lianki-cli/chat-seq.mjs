/** Explicit sequence windows and receipts; receiving a line never marks it read. */
import { CliError, EXIT } from "./api.mjs";
const valid = (seq) => Number.isSafeInteger(seq) && seq >= 0;
export function readAckBody(lastReadSeq) {
  if (!valid(lastReadSeq)) throw new CliError("usage", EXIT.usage, "seq must be a non-negative safe integer");
  return { op: "read-ack", lastReadSeq };
}
export function readWindow(afterSeq, throughSeq) {
  if (afterSeq === undefined && throughSeq === undefined) return {};
  if (!valid(afterSeq) || (throughSeq !== undefined && (!valid(throughSeq) || throughSeq < afterSeq)))
    throw new CliError("usage", EXIT.usage, "afterSeq and throughSeq must name an increasing non-negative sequence range");
  return { afterSeq, ...(throughSeq !== undefined ? { throughSeq } : {}) };
}
/** Preserve the coverage proof when a bounded API read needs another batch. */
export function readCoverage(data) {
  const out = {};
  for (const key of ["afterSeq", "throughSeq", "headSeq", "prunedThroughSeq"])
    if (valid(data?.[key])) out[key] = data[key];
  for (const key of ["skipped", "removed"]) if (Array.isArray(data?.[key])) out[key] = data[key];
  return out;
}
