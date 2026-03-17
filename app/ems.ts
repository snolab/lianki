import ems from "enhanced-ms";
export { ems };
export function dueMs(due: Date) {
  const ms = +due - +new Date();
  if (ms < 0) return `-${ems(-ms, "short") ?? "0s"}`;
  return ems(ms, "short") ?? "0s";
}
