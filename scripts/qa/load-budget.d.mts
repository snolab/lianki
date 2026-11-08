export declare const MAX_FACTOR: number;
export declare function loadFactor(
  env?: Record<string, string | undefined>,
  load?: number,
  cores?: number,
): number;
export declare function budget(ms: number, factor?: number): number;
