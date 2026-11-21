// Types for the Bombadil spec (qa/bombadil/spec.ts), for `bun run typecheck` only.
// The bombadil binary bundles its own copy of `@antithesishq/bombadil` and
// resolves these imports itself; the npm package is not a dependency of this
// repo. This is the subset spec.ts uses, copied by hand from the release's
// npm package (v0.7.10, MIT). Upstream: github.com/antithesishq/bombadil.

declare module "@antithesishq/bombadil" {
  export type JSON =
    | string
    | number
    | boolean
    | null
    | JSON[]
    | { [key: string | number | symbol]: JSON }
    | { toJSON(): JSON };
  export interface Cell<T> {
    get current(): T;
  }
  export type TimeUnit = "milliseconds" | "seconds" | "minutes";
  export class Formula {
    not(): Formula;
    and(that: IntoFormula): Formula;
    or(that: IntoFormula): Formula;
    implies(that: IntoFormula): Formula;
  }
  export class Always extends Formula {
    within(n: number, unit: TimeUnit): Formula;
  }
  export class Eventually extends Formula {
    within(n: number, unit: TimeUnit): Formula;
  }
  export type IntoFormula = (() => Formula | boolean) | Formula;
  export function now(x: IntoFormula): Formula;
  export function next(x: IntoFormula): Formula;
  export function always(x: IntoFormula): Always;
  export function eventually(x: IntoFormula): Eventually;
  export function not(x: IntoFormula): Formula;
}

declare module "@antithesishq/bombadil/actions" {
  export type Tree<A> = unknown & { __tree?: A };
  export class ActionGenerator<A> {
    generate: () => Tree<A>;
    map<B>(f: (action: A) => B): ActionGenerator<B>;
    filter(predicate: (action: A) => boolean): ActionGenerator<A>;
    when(condition: boolean | (() => boolean)): ActionGenerator<A>;
  }
}

declare module "@antithesishq/bombadil/browser" {
  import type { Cell, JSON } from "@antithesishq/bombadil";
  import type { ActionGenerator, Tree } from "@antithesishq/bombadil/actions";

  export type Point<N = number> = { x: N; y: N };
  export type Range = number | [number, number];
  export type Fingerprint = {
    testId: string | null;
    id: string | null;
    role: string | null;
    accessibleName: string | null;
    tag: string;
    href: string | null;
    nameAttr: string | null;
    placeholder: string | null;
    inputType: string | null;
    textContent: string | null;
    structuralPath: string | null;
  };
  export type ActionTemplate =
    | "Back"
    | "Forward"
    | "Reload"
    | "Wait"
    | { Click: { fingerprint: Fingerprint; point: Point<Range> } }
    | { DoubleClick: { fingerprint: Fingerprint; point: Point<Range> } }
    | { TypeText: { text: unknown } }
    | { PressKey: { code: number } }
    | { ScrollUp: { origin: Point; distance: Range } }
    | { ScrollDown: { origin: Point; distance: Range } }
    | { Custom: { name: string; args: JSON[] } }
    | Record<string, unknown>;
  export type NavigationEntry = { id: number; title: string; url: string };
  export interface State {
    document: Document;
    window: Window;
    navigationHistory: {
      back: NavigationEntry[];
      current: NavigationEntry;
      forward: NavigationEntry[];
    };
    errors: { uncaughtExceptions: { text: string; url: string | null }[] };
    console: { timestamp: number; level: "warning" | "error"; args: JSON[] }[];
    lastAction: unknown;
  }
  export function extract<T extends JSON>(query: (state: State) => T): Cell<T>;
  export function actions(
    generate: () => Tree<ActionTemplate> | ActionTemplate[],
  ): ActionGenerator<ActionTemplate>;
  export function weighted(
    value: [number, ActionTemplate | ActionGenerator<ActionTemplate>][],
  ): ActionGenerator<ActionTemplate>;
  export function registerCustomAction<Args extends JSON[]>(
    name: string,
    handler: (document: Document, window: Window, ...args: Args) => Promise<void>,
  ): (...args: Args) => ActionTemplate;
}

declare module "@antithesishq/bombadil/browser/defaults/actions" {
  import type { ActionGenerator } from "@antithesishq/bombadil/actions";
  import type { ActionTemplate } from "@antithesishq/bombadil/browser";
  export const clicks: ActionGenerator<ActionTemplate>;
  export const inputs: ActionGenerator<ActionTemplate>;
  export const scroll: ActionGenerator<ActionTemplate>;
  export const forward: ActionGenerator<ActionTemplate>;
  export const reload: ActionGenerator<ActionTemplate>;
  export const waitOnce: ActionGenerator<ActionTemplate>;
}

declare module "@antithesishq/bombadil/browser/defaults/properties" {
  import type { Formula } from "@antithesishq/bombadil";
  export const noUncaughtExceptions: Formula;
  export const noUnhandledPromiseRejections: Formula;
  export const noConsoleErrors: Formula;
}
