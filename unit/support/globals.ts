// Stubbing a global (document, localStorage, fetch, WebSocketPair…) for one
// test, and putting back EXACTLY what was there. The whole unit suite runs in
// one process, so `g.x = had` with `had === undefined` leaves an own property
// `x: undefined` behind, `Object.defineProperty(g, x, { value })` leaves a
// read-only one, and a stub that is never put back is seen by every file that
// runs later — which on Linux (a different file order than this Mac) is a
// different set of files. unit/support/globals-guard.ts fails the run when a
// file leaves any of that behind.

type G = Record<string, unknown>;

/** The own descriptor of a global, or undefined when it does not exist. */
export function globalDescriptor(name: string): PropertyDescriptor | undefined {
  return Object.getOwnPropertyDescriptor(globalThis, name);
}

/** Put a global back to `desc`: that descriptor, or nothing when it did not exist. */
export function restoreGlobal(name: string, desc: PropertyDescriptor | undefined): void {
  if (!desc) {
    delete (globalThis as G)[name];
    return;
  }
  const now = globalDescriptor(name);
  // A non-configurable data property cannot be redefined, only assigned.
  if (now && now.configurable === false && "value" in desc && now.writable) {
    (globalThis as G)[name] = desc.value;
    return;
  }
  Object.defineProperty(globalThis, name, desc);
}

/**
 * Set each global in `patch` (a plain writable, configurable, enumerable
 * property — what `globalThis.x = v` makes) and return the function that puts
 * every one of them back as it was. Use it in try/finally, or beforeEach +
 * afterEach.
 */
export function stubGlobals(patch: Record<string, unknown>): () => void {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(patch)) {
    saved.set(name, globalDescriptor(name));
    setGlobal(name, value);
  }
  return () => {
    for (const [name, desc] of saved) restoreGlobal(name, desc);
  };
}

/** `globalThis[name] = value` that also works over a read-only or accessor property. */
export function setGlobal(name: string, value: unknown): void {
  const now = globalDescriptor(name);
  if (now && now.configurable === false) {
    (globalThis as G)[name] = value;
    return;
  }
  Object.defineProperty(globalThis, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}
