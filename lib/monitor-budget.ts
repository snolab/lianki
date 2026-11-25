/** Defaults only; live values come from the existing private config service. */
export const MONITOR_BUDGET_DEFAULTS = {
  pathRateMax: 1500,
  repeat401Max: 300,
  cpuMsMonthAlert: 60000000,
} as const;
