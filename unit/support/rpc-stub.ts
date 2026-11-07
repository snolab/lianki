/**
 * A stand-in for a Workers service-binding stub to a WorkerEntrypoint, close
 * enough to the real one that the debug hub's calls fail here the way they
 * fail in workerd. On a real stub, every property is another RPC stub: a
 * method taken off it and then `.bind(stub)`-ed, `.call`-ed or `.apply`-ed is
 * sent to the main Worker as a call of a method named "bind" (or "call"…),
 * which it refuses: `TypeError: The RPC receiver does not implement the method
 * "bind".` Reproduced against the real main Worker under `wrangler dev`
 * (2026-11-07); a plain object of async functions hid it from every suite.
 *
 * Arguments cross as structured clones, as they do over RPC. Methods the
 * object does not define stay undefined here (a real stub answers every name
 * and refuses the call), so the suites' "older main Worker" cases still read.
 */
export function rpcStub<T extends object>(methods: T): T {
  const out: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(methods)) {
    if (typeof fn !== "function") continue;
    const call = (...args: unknown[]) =>
      (fn as (...a: unknown[]) => unknown).apply(
        methods,
        args.map((a) => structuredClone(a)),
      );
    out[name] = new Proxy(call, {
      // stub.method.bind / .call / .apply / anything else: a nested RPC path
      // the receiver does not implement. `.bind(stub)(x)` rejects, as in workerd.
      get: (_t, prop) =>
        prop === Symbol.toPrimitive || prop === "toString"
          ? () => `[rpc ${name}]`
          : () => () =>
              Promise.reject(
                new TypeError(`The RPC receiver does not implement the method "${String(prop)}".`),
              ),
    });
  }
  return out as T;
}
