# Hot core: hot-swappable headless modules

Status: **design only, nothing built** (2026-10-31). Owner request, Slack
2026-10-30 22:39–22:40 JST: "the core should be hot-replaceable too".

Today only UI islands hot-swap ([dev-hot-islands.md](dev-hot-islands.md)).
The headless parts under them, such as the word-clip pool, the swipe physics
and the speech sequencer, are built in. [swipe-core.md](swipe-core.md) even
says the core is "never hot-swapped". This page changes that. Any part can be
swapped while the page runs, as long as its interface stays compatible. The
parts are versioned **core modules**. They are served by the same dev server
and loader as islands and behind the same gate. They get their services and
resources from a small **kernel**, modelled on cordis. The kernel undoes
everything a module registered when the module is swapped out.

What was already agreed with the owner: split the core into versioned modules
loaded by the island loader. On a swap, migrate the zustand state, switch
atomically and fall back on error. Every module can be disposed, so swapping
never leaks. The cautionary tale is #336, where one `<audio>` element and gain
node per clip stayed in the AudioContext and /words slowed down over a long
study session. A hot swap that skips cleanup would cause the same leak, once
per save.

## 1. Prior art

### cordis (Koishi's kernel)

[cordis](https://github.com/cordiverse/cordis) is the plugin framework under
Koishi. Five ideas from it carry over:

- **A context is a repository of services.** A service claims a key such as
  `ctx.timer` or `ctx.llm`. Consumers find it by that key and never import the
  implementation, so the implementation can be replaced.
- **Dependencies are declared, not sequenced.** A plugin lists what it
  `inject`s and is applied only once those services exist. When a provider
  goes away, its dependents are disposed. When the provider comes back, they
  are applied again.
- **Every registration is a reversible effect.** `ctx.effect(() => {
…; return dispose })`, `ctx.on(event, fn)`, `ctx.provide(name, value)` and
  the timer service's `ctx.timeout` / `ctx.interval` all record a disposer on
  the plugin's fiber. Unloading the plugin runs them in reverse order. Calling
  `ctx.effect` on an inactive context throws (`INACTIVE_EFFECT`). Effects
  carry labels such as `ctx.interval()`, so the live ones can be listed.
- **Typed events with fixed dispatch modes:** `emit`, `waterfall`, `parallel`,
  `serial`, `bail`. The mode is part of the event's contract.
- **HMR in stages** (`@cordisjs/plugin-hmr`). Stage 1 imports every changed
  plugin and checks it before touching anything. Stage 2 calls
  `registry.replace(old, new)` synchronously, which disposes the old fiber
  and applies the new one in place. Stage 3 waits for the new fibers. A
  plugin that fails to _import_ aborts its unit and restores the old module
  cache. A plugin that fails to _apply_ is left failed, with no rollback.

We take the context, the inject/provide model, the auto-disposed effects and
the import-then-check-then-replace order. Two things differ, both because a
phone in the middle of a study session cannot be left with a failed plugin:

- Lianki **keeps the old module running until the new one has applied.**
- Lianki **falls back to the built-in module** if the new one fails later.

cordis also restarts a plugin from its config with no state. Lianki carries
the module's zustand state across the swap and migrates it.

### "The DeepSeek harness kernel": it is cordis

This refers to **DeepSeek Harness** (`dsh`,
[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)).
It is DeepSeek AI's open-source agent harness, released as a developer
preview on 2026-08-13 under the MIT licence, and runs with
`npx @deepseek-ai/dsh web`. Its design rule is "everything is a plugin", and
its kernel **is cordis**. The README says it is "powered by Cordis", and the
docs keep a vendored copy plus a "Cordis primer". The kernel only loads and
unloads plugins and tracks their dependencies. The model adapters, the tool
registry, the session log and the agent loop are all plugins. So the owner's
two references point at the same kernel. dsh is the large production user
that shows the model working. It adds three ideas we use:

- **A seam has three roles:** a service _definition_ (the interface), a
  _provider_ (an implementation) and a _consumer_. A capability is not
  swappable until all three are designed. Here the definition is
  `lib/core/contract.ts`, the providers are the modules, and the consumers are
  islands and app code.
- **"There is no privileged core to patch."** You extend dsh by mounting a
  plugin next to the others, and its registrations are effects that unwind
  when it unloads. The kernel is the only fixed part.
- **"Every registration should have a disposer.** If teardown order matters,
  keep the related work in one effect." We adopt that sentence as a lint
  rule (section 6).

dsh's HMR is the cordis HMR plugin, switched on in its configuration.

## 2. Pieces

| File (to be built)                                                              | Role                                                                                  |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `lib/core/kernel.ts`                                                            | `Context`, effects, services, the facade, `inspect()`. Never swapped                  |
| `lib/core/contract.ts`                                                          | every service interface and its version, every module id; like islands' `contract.ts` |
| `lib/core/semver.ts`                                                            | the version checks of section 4, pure                                                 |
| `lib/core/swap.ts`                                                              | the swap protocol of section 5, every dependency passed in                            |
| `lib/core/useService.ts`                                                        | `useService(name, range)` for React                                                   |
| `lib/core/modules/*.ts`                                                         | the built-in modules: `audio.clips` first                                             |
| `lib/islands/entry.ts`                                                          | also exports `modules`, `moduleManifests`, `CORE_API`                                 |
| `lib/islands/loader.ts`                                                         | also hands `modules` to `swap.ts`                                                     |
| `unit/core-kernel.test.ts`, `unit/core-swap.test.ts`, `unit/core-leaks.test.ts` | section 6                                                                             |

The kernel itself is the one part that cannot be hot-swapped. This mirrors
cordis, where the `Context` and registry are fixed and everything else is a
plugin. Keep it small, about 300 lines.

## 3. The interface contract

A core module is a plain object. Its manifest is static data, so it can be
checked before any of the module's code runs.

```ts
// lib/core/kernel.ts (types)
export type CoreModule<S = unknown> = {
  /** Stable id: "<area>.<name>", e.g. "audio.clips". One module per id at a time. */
  id: ModuleId;
  /** The implementation's own version: semver, bumped on every change of behaviour. */
  version: `${number}.${number}.${number}`;
  /** Services it provides, each at an interface version (semver). */
  provides: { [K in ServiceName]?: `${number}.${number}.${number}` };
  /** Services it needs, each as a range ("^1.2"); `optional` ones may be absent. */
  requires?: { [K in ServiceName]?: string | { range: string; optional: true } };
  /** Its zustand state: version, initial value, how to read an older version. */
  state?: {
    version: number;
    initial: S;
    schema: z.ZodType<S>;
    migrate?: (fromVersion: number, raw: unknown) => unknown;
  };
  /**
   * Set the module up on `ctx`: ctx.provide each service it provides, and
   * register every listener, timer, element and node through ctx. May be
   * async. What it registers is undone when ctx is disposed.
   */
  apply(ctx: Context, state: StateHandle<S>): void | Promise<void>;
};
```

`dispose()` is not something a module writes. **The kernel's `ctx.dispose()`
is every module's `dispose()`.** It runs the module's effects in reverse
order. A module that needs extra teardown registers it as an effect:
`ctx.effect(() => () => { … })`. This is the cordis rule, and it means a
module cannot forget part of its cleanup by writing a `dispose` that misses
something.

Service interfaces live in `lib/core/contract.ts`, the same way islands,
shared keys and actions live in `lib/islands/contract.ts`:

```ts
// lib/core/contract.ts
export interface Services {
  "audio.clips": ClipPool<HTMLAudioElement>; // lib/words/clip-pool.ts's type
  "swipe.physics": SwipePhysics;
}
/** The version of each interface this page was built with. */
export const SERVICE_VERSIONS: { [K in keyof Services]: `${number}.${number}.${number}` } = {
  "audio.clips": "1.0.0",
  "swipe.physics": "1.0.0",
};
/** The modules this page knows, with its built-in implementation of each. */
export const BUILT_IN: Record<ModuleId, () => Promise<CoreModule>> = {
  "audio.clips": () => import("./modules/clip-pool").then((m) => m.clipPoolModule),
};
```

What the dev server's module exports (`lib/islands/entry.ts`), next to
`islands`:

```ts
export const CORE_API = 1; // what the page expects of the export itself
export const modules = { "audio.clips": clipPoolModule } satisfies CoreModulesExport;
```

`satisfies` means a module whose `provides` type does not match `Services`
fails typecheck. The dev server already runs `tsgo` on every build and serves
nothing that fails it. This is the same safety net islands have.

## 4. Version compatibility

There are three versions, and each one decides something different.

| Version                          | Bump when                                                                                            | Decides                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| interface (`provides`, semver)   | major: a method removed or its meaning changed; minor: a method or optional field added; patch: docs | whether consumers can use the new module                                |
| module (`version`, semver)       | any change to the implementation                                                                     | nothing by itself: shown in status and the devLog, and tells revs apart |
| state (`state.version`, integer) | the stored shape changes                                                                             | whether `migrate` runs on swap                                          |

Rules, each one pure and unit-tested in `lib/core/semver.ts`:

1. **A provider satisfies a range** when the majors are equal and the
   provider's minor.patch is at least what the range asks for. `^1.2` accepts
   `1.2.0` and `1.9.3`. It rejects `1.1.9` and `2.0.0`. A `0.x` major means
   unstable: it needs an exact minor match, as npm does it.
2. **A new module may replace the current one** only if, for every service
   it provides, its interface version satisfies every live consumer's range
   for that service. Live consumers are the page's built-in code
   (`SERVICE_VERSIONS`), plus every module and island that is mounted now and
   declared a range for it. It must provide at least the services the module
   it replaces provided. Dropping a service is a major change.
3. **Its `requires` must be satisfiable** by the providers that will be live
   after the switch, which includes the new module itself.
4. **A higher major is never accepted** on a page that was built with a
   lower one, and neither is a lower major. To ship an incompatible
   interface, deploy. This matches islands: "New islands, keys, actions or
   contract versions need a deploy."
5. **State:** `migrate` handles only a _lower_ stored version. A higher
   version, which means swapping back to an older build, falls back to
   `initial`, just like `decodeShared`. A migrate that throws, or a result
   that fails the schema, also gives `initial`. Either way the event is
   logged, the module still loads, and nothing is thrown into it.
6. **`CORE_API`** works like `ISLANDS_API`. If it differs, the whole modules
   export is ignored and every module stays as it is.

A consumer always names a range: `ctx.inject("audio.clips", "^1")` and
`useService("audio.clips", "^1")`. This is how `useSwipeRow(1)` names
`SWIPE_CORE_IFACE` today, but as a range instead of an exact number. A minor
addition then does not lock out older islands.

## 5. The context and effect API

Each module gets its own `Context`, a child of the kernel's root. Every method
that acquires something records the matching release on the context.
`ctx.dispose()` releases all of them in reverse order. Each call also returns
its own disposer, for releasing early.

```ts
interface Context {
  readonly id: ModuleId;
  readonly active: boolean;

  // ── generic ───────────────────────────────────────────────────────────
  /** Run `setup`, keep the cleanup it returns. Throws on an inactive ctx. */
  effect(setup: () => (() => void) | void, label?: string): () => void;

  // ── DOM and timers ────────────────────────────────────────────────────
  on<K extends keyof WindowEventMap>(
    target: EventTarget,
    type: K | string,
    fn: (e: Event) => void,
    opts?: AddEventListenerOptions,
  ): () => void;
  timeout(fn: () => void, ms: number): () => void; // cleared on dispose
  interval(fn: () => void, ms: number): () => void; // rarely: no polling (memory rule)
  frame(fn: (t: number) => void): () => void; // one rAF, cancelled on dispose
  /** A thing with its own release: an <audio>, a GainNode, a blob URL, a store subscription. */
  own<T>(value: T, release: (v: T) => void, label?: string): T;

  // ── services ──────────────────────────────────────────────────────────
  provide<K extends ServiceName>(name: K, impl: Services[K]): void;
  /** The live provider, through a stable facade (below). Throws if none satisfies `range`. */
  inject<K extends ServiceName>(name: K, range: string): Services[K];
  /** For an optional service: null while absent. */
  get<K extends ServiceName>(name: K, range: string): Services[K] | null;

  // ── events between modules (typed in contract.ts, cordis-style modes) ──
  emit<E extends EventName>(name: E, payload: Events[E]): void;
  listen<E extends EventName>(name: E, fn: (p: Events[E]) => void): () => void;

  /** The devLog, tagged with the module id and version. */
  log(event: Record<string, unknown>): void;
}
```

How it behaves:

- **Order.** Disposers run last in, first out. One effect that does several
  things undoes them in its own order. This is the dsh rule: "keep the
  related work in one effect".
- **No work after disposal.** After `dispose()`, `active` is false, and
  `effect`, `on`, `timeout`, `own` and `provide` throw. A callback that was
  already queued (a late `onended`, a timer that fired during disposal)
  checks `ctx.active`, because the kernel wraps every callback it registers
  so that it does nothing on an inactive ctx. A stale clip finishing after
  the swap therefore cannot reach the new module.
- **A disposer that throws** is logged, and the rest still run. Disposal
  never throws to its caller.
- **The facade.** `inject` returns a stable object that forwards each call to
  the current provider. It does not return the provider itself. Consumers
  such as WordsClient's `clipPool()` and the swipe core's frame loop keep the
  facade across swaps, so no reference to a disposed implementation
  survives. The facade checks the interface range once, at `inject`. A
  method missing on the provider throws `CoreServiceMissing`, which only
  happens if a module lies about its version. Typecheck makes that hard.
- **Handles.** A value that a service hands out, such as a `Clip` from
  `take()`, belongs to the module that made it. After a swap, a method called
  with an old handle is a no-op and never throws. The interface documents
  this per method. For the clip pool, `fadeOut(oldClip)` does nothing,
  because the old pool already paused it.
- **`inspect()`** returns, per module: id, version, rev, state version, and
  its live effects by label with counts (`on:pointerup ×2`, `own:audio ×4`,
  `timeout ×1`). The tuner and the debug chat can show it. The leak tests
  read it (section 7).
- **React.** `useService(name, range)` reads the facade, and re-renders on a
  swap through `useSyncExternalStore` on the kernel's revision counter. A
  component that only calls methods never needs to re-render. One that shows
  the module's state uses `useCoreState(id, selector)`, which is the module's
  zustand store through `useUi`'s pattern.

**Module state.** The kernel owns one zustand vanilla store per module id.
The module does not own it. `apply` receives a `StateHandle<S>`
(`get`/`set`/`subscribe`; `subscribe` is recorded as an effect). The store
outlives the module, so a swap keeps the state and only reshapes it. The
store is in memory by default. A module whose state is also a UI preference
can persist it with `@lianki/ui-state`. One rule applies there:
`createUiStore` throws when the version changes. So the kernel, not the
module, creates the persisted store, and creates it at the version the
migration produced. Business data stays out, as [ui-state.md](ui-state.md)
says: a queue module holds pointers and logic, never the cards.

## 6. The swap protocol

`swap.ts` runs this for each module in a `slot-reload` whose `names` include
a module id. The SSE event and `?v=<rev>` import are the ones the islands
already use. Modules are swapped one at a time, in dependency order
(providers first).

```
0. gate         same three gates as islands: live eval grant, lk:slots-src, allowed origin
1. import       import(islands.js?v=rev); read `modules[id]`          nothing touched yet
2. check        CORE_API; id known (BUILT_IN); manifest shape (zod);
                rules 2–3 of section 4 against the live graph          → refuse: keep current
3. stage        child ctx C' (inactive provisions: provide() records but
                does not publish); state' = migrate(store snapshot);
                await apply(C', handle(state')) under a time limit   → throw/timeout:
                                                                       C'.dispose(), keep current
4. switch       synchronously, in one task:
                  store.setState(state', replace)
                  registry[service] = C'.provisions    (facades now forward to the new module)
                  revision++  → useService subscribers re-render
5. retire       C_old.dispose(): its listeners, timers, elements, nodes, provisions;
                every dependent module whose `requires` named a service of C_old
                is re-applied against the new provider (cordis does the same)
6. probation    for 10 s, an error thrown through a facade method of C', or by a
                callback the kernel wrapped for C', counts against it
                → fall back (below)
7. report       core.status shared key: {id, version, rev, state v, note};
                devLog {ev: "core-swapped" | "core-refused" | "core-fallback", …}
```

Why this order:

- **Nothing changes before step 4.** Import, checks and `apply` all happen
  while the old module keeps serving. This is cordis's "check validity where
  the only mutated state is the module cache", extended to cover `apply` too.
- **Step 4 has no `await`,** so no frame, event or React render can see half
  of the old module and half of the new one. The swipe core's rAF loop calls
  `physics.springStep` through the facade. One frame gets the old function and
  the next frame gets the new one. A settle already in flight continues on
  the trajectory the old module computed, because that is a value, not a
  module reference.
- **Two instances briefly coexist** (steps 3–5). A module must therefore
  allow a second copy of itself while the first is alive. The clip pool
  does: two pools, each with at most `max` elements, for the length of the
  swap. A module that takes something exclusive (a mic stream, a wake lock)
  sets `exclusive: true`. Its old instance is then retired _before_ step 3,
  and on failure the built-in module is applied in its place.

**Fallback.** If staging fails, the current module stays and nothing else
happens. If the probation in step 6 fails, the kernel swaps to the
**built-in** module (`BUILT_IN[id]`) using the same protocol, starting at
step 2. It does not swap to the previous hot one, which may be the cause.
The state goes through the built-in module's `migrate`, or falls back to
`initial` under rule 5. A built-in module that fails to apply is a real bug.
It is logged, and the service stays absent. A consumer that used `inject` for
it then throws into its island's error boundary, which shows the built-in
island. Withdrawing the grant (`islandStore.setGrant(null)`) swaps every hot
module back to built-in. This is the same `stop()` path that puts islands
back.

**Production.** Production pages apply the built-in modules once at start and
never swap. The kernel and the facades cost one indirection per call. The
swap code (`swap.ts`) loads only behind the three gates, as `loader.ts` does.

## 7. Leak tests

Every module that hot-swaps must pass all three before it can be swapped.

1. **Unit, with fakes** (`unit/core-leaks.test.ts`). Use a fake window
   (counting `add/removeEventListener`), fake timers, a fake AudioContext
   (counting created and connected nodes) and fake elements. Then:
   - apply the module, use it, swap it 100 times (each swap's `apply` is
     the same module with a fresh rev);
   - after each swap, `inspect()` lists effects only for the live context;
   - at the end, live listeners, timers, rAFs, connected nodes and owned
     elements are back to the baseline plus one module's worth;
   - every disposer ran exactly once, and none ran early;
   - an old handle passed to the new module is a no-op;
   - a module whose `apply` throws halfway leaves nothing behind, because
     what it had registered is disposed in step 3.
2. **The kernel's own tests** (`unit/core-kernel.test.ts`). Effects run last
   in, first out. A throwing disposer does not stop the others. An inactive
   ctx refuses new effects. Wrapped callbacks are silent after disposal. Test
   the semver rules from section 4 as a table, and the facade forwarding
   across a swap.
3. **In the browser.** Extend `scripts/qa/words-soak.mjs` with
   `SOAK_SWAP=N`, which swaps `audio.clips` N times during the soak through a
   dev-only `__lkCoreSwap(id)`. The hook re-applies the built-in module as if
   it were hot, compiled out of production, like `__lkIslandsGrant`. Pass if:
   `Runtime.queryObjects` for `HTMLAudioElement`, `GainNode` and
   `MediaElementAudioSourceNode` stays at or under `max` plus the baseline,
   `JSEventListeners` is flat, and the one-row scroll cost does not grow.
   This is the soak that found #336, now run against swaps.

**Lint.** In `lib/core/modules/**`, oxlint's `no-restricted-globals` and
`no-restricted-syntax` forbid `addEventListener`, `setTimeout`,
`setInterval`, `requestAnimationFrame`, `new Audio`, `URL.createObjectURL` and
`AudioContext#create*` when called directly. The module must go through
`ctx.on` / `ctx.timeout` / `ctx.frame` / `ctx.own`. That makes "every
registration has a disposer" something the build checks, not something we
remember.

## 8. The first module: the word-clip pool

Convert `audio.clips` (`lib/words/clip-pool.ts`) first. The other option, the
swipe physics, comes second.

- **It is where the leak was.** It holds the resources that matter: elements,
  `MediaElementAudioSourceNode`s, gain nodes and fade timers. It also holds
  the one-way trap. An element can be passed to `createMediaElementSource`
  only once, and its node stays in the graph until it is disconnected. Pure
  physics would prove the protocol and never exercise `dispose`.
- **It is already injectable.** `createClipPool(deps)` takes the browser as
  arguments and is unit-tested with fakes. Its interface (`take`, `fadeOut`,
  `size`) is small, and it has exactly one consumer
  (`WordsClient.tsx`'s module-level `clipPool()`).

What changes:

1. **Add disposal, still without a kernel (step 0).** `make()` keeps the
   `MediaElementAudioSourceNode` it creates. Today it is thrown away, so it
   cannot be disconnected. `dispose()` then stops every clip: it clears the
   fade timer, removes the handlers and pauses. Then it disconnects
   `source → gain → destination`, sets `el.removeAttribute("src")` and calls
   `el.load()` so the element frees its media. After disposal, `take`
   returns a silent dummy clip and `fadeOut` is a no-op. Add unit tests for
   both, and a soak check that elements and nodes are collected after a
   dispose. Whether Chromium and WebKit collect an element that was once
   given to `createMediaElementSource` is the open question this step
   answers. If they do not, the module keeps its elements on the kernel's
   root across swaps, as a pool that outlives the module, and only the
   policy is swapped.
2. **Make it a module.** Add `lib/core/modules/clip-pool.ts`:
   ```ts
   export const clipPoolModule: CoreModule = {
     id: "audio.clips",
     version: "1.0.0",
     provides: { "audio.clips": "1.0.0" },
     requires: { "audio.context": { range: "^1", optional: true } },
     apply(ctx) {
       const pool = createClipPool({
         element: () => ctx.own(new Audio(), releaseElement, "audio"),
         ctx: () => ctx.get("audio.context", "^1")?.current() ?? null,
         setTimeout: (fn, ms) => ctx.timeout(fn, ms),
         clearTimeout: (cancel) => cancel(),
       });
       ctx.effect(() => () => pool.dispose(), "clip-pool");
       ctx.provide("audio.clips", pool);
     },
   };
   ```
   The page's one AudioContext becomes a tiny built-in `audio.context`
   service (`sharedAudioContext()` behind it). It is never swapped, because
   iOS allows only a few AudioContexts and unlocks one per gesture.
3. **The consumer.** In `WordsClient.tsx`, `clipPool()` becomes
   `core.inject("audio.clips", "^1")`, the facade. `audio.current` keeps its
   `Clip` handle, which is valid until a swap, after which it is a no-op.
4. **Wire it up and run the soak** (sections 6–7). Then tuning `max`, the
   fade curve or the "take the oldest" policy is a save on the Mac and a
   swap on the phone, in the middle of a study session.

After that, in order:

- `swipe.physics`: `springStep`, `followSwipe`, `releaseTrajectory`,
  `trajectoryEasing`. These are pure functions, called through the facade
  from the swipe core's frame loop. It has no state and no resources. It
  shows atomic switching mid-gesture.
- `speech.sequencer` (`lib/words/sequence.ts`), which has timers.
- `audio.priority` (`lib/words/audio-priority.ts`), which is pure.
- The swipe machine (`swipe-machine.ts`), which holds gesture state. Its
  migration matters, so it comes after the protocol is proven.

## 9. Limits

- **The kernel, the contract and anything server-side** cannot be swapped.
  The page's own `lib/core/contract.ts` decides which ids, services and
  majors exist. A new service, or a new major, needs a deploy.
- **A swap resets in-flight work** that the module did not put in its state:
  a clip that is playing, a pending fade, a timer. That is the price of
  disposing. Put anything that must survive into `state`.
- **Same gate, same power.** A hot module runs only where hot islands run.
  It has no more power than the eval grant already gives.
- **Shared modules still apply.** A module that imports a stateful app file
  gets its own copy, unless that file is in `SHARED_MODULES`. Modules should
  take what they need from services instead.

## 10. Estimates (agent hours)

| Step                                                                                                     | Agent hours |
| -------------------------------------------------------------------------------------------------------- | ----------- |
| 0. `clip-pool.ts`: keep source nodes, `dispose()`, unit tests, soak dispose check                        | 1.5         |
| 1. `lib/core/kernel.ts` + `semver.ts`: context, effects, provide/inject, facade, `inspect()`, unit tests | 4           |
| 2. `swap.ts` + loader/entry wiring, `core.status`, fallback, probation, unit tests                       | 4           |
| 3. `audio.clips` as a module, `audio.context` service, WordsClient on the facade                         | 2           |
| 4. Leak tests: `core-leaks.test.ts` and `SOAK_SWAP` in the words soak                                    | 3           |
| 5. oxlint restrictions for `lib/core/modules/**`                                                         | 1           |
| 6. Docs: this page to "built", swipe-core.md and dev-hot-islands.md updated                              | 0.5         |
| **First module live and leak-tested (0–6)**                                                              | **16**      |
| 7. `swipe.physics` module, swipe core on the facade, mid-gesture swap test                               | 3           |
| 8. Each further pure or timer-only module (`speech.sequencer`, `audio.priority`)                         | 1.5–2 each  |

Step 0 ships on its own. It is a plain fix: a pool with disposal is worth
having even with no kernel.
