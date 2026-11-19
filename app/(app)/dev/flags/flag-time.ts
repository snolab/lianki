/** Historical imports used millisecond epoch strings; current writes use ISO. */
export function flagTime(at: string | number): number | null {
  const value = typeof at === "string" ? at.trim() : at;
  if (value === "") return null;
  const epoch = typeof value === "string" && /^-?\d{11,16}$/.test(value) ? Number(value) : value;
  const time = new Date(epoch).getTime();
  return Number.isFinite(time) ? time : null;
}
