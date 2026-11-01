"use client";

/**
 * <Island> — a hot-swappable smart component (docs/dev-hot-islands.md).
 *
 *   <Island name="header.brand" component={BrandName} props={{ appName }} />
 *   const BrandIsland = island("header.brand", BrandName);   // the same, as a component
 *
 * It renders the built-in component. Only on a device where `lk:slots-src`
 * was set when the page loaded does it also watch the override store, and
 * then only an island the loader has installed (owner, live code-run grant,
 * allowed origin) renders the hot-loaded version — behind an error boundary
 * that falls back to the built-in one.
 *
 * Islands take no live props: only the static ones their contract lists
 * (contract.ts). Everything else they share goes through useSharedState and
 * the action bus.
 */
import { Component, type ComponentType, type ReactNode, useSyncExternalStore } from "react";
import { devLog } from "@/lib/debug-client";
import type { IslandName, IslandProps } from "./contract";
import { liveWanted } from "@/lib/live-view/client";
import { ISLANDS_SRC_KEY, errLine } from "./rules";
import { type IslandStore, islandStore } from "./store";

/** An island without static props takes `props={{}}`. */
export type IslandElementProps<N extends IslandName> = {
  name: N;
  component: ComponentType<IslandProps[N]>;
  props: IslandProps[N];
};

type BoundaryProps = {
  name: string;
  fallback: ReactNode;
  onError: (name: string, e: unknown) => void;
  children: ReactNode;
};

/** A hot-loaded island that throws while rendering shows the built-in one instead. */
export class IslandBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(e: unknown) {
    this.props.onError(this.props.name, e);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export const reportError = (name: string, e: unknown) => {
  console.warn(`[islands] ${name} threw; showing the built-in one`, e);
  devLog({ ev: "island-error", name, error: errLine(e) });
};

/** No override possible on this device: the built-in component, nothing else. */
function PlainIsland<N extends IslandName>({ component: Builtin, props }: IslandElementProps<N>) {
  return <Builtin {...props} />;
}

/** The built-in component, or the override `store` holds for `name`. */
export function HotIsland<N extends IslandName>({
  name,
  component: Builtin,
  props,
  store = islandStore,
}: IslandElementProps<N> & { store?: IslandStore }) {
  // The store is empty on the server (only the browser loader fills it), so
  // one snapshot serves both.
  const snap = () => store.get(name);
  const o = useSyncExternalStore(store.subscribe, snap, snap);
  const p = props;
  if (!o) return <Builtin {...p} />;
  const Remote = o.C as unknown as ComponentType<IslandProps[N]>;
  return (
    <IslandBoundary key={o.rev} name={name} fallback={<Builtin {...p} />} onError={reportError}>
      <Remote {...p} />
    </IslandBoundary>
  );
}

/**
 * Read once per page load: only a device with the key set, or with the live
 * view switch on (docs/live-view.md), ever subscribes.
 */
function overridesPossible(): boolean {
  try {
    if (typeof window === "undefined") return false;
    return liveWanted() || !!localStorage.getItem(ISLANDS_SRC_KEY);
  } catch {
    return false;
  }
}

export const Island = (overridesPossible() ? HotIsland : PlainIsland) as <N extends IslandName>(
  p: IslandElementProps<N>,
) => ReactNode;

/** `island(name, Builtin)`: a component that renders <Island name component={Builtin} />. */
export function island<N extends IslandName>(name: N, Builtin: ComponentType<IslandProps[N]>) {
  function NamedIsland(props: IslandProps[N]) {
    return <Island name={name} component={Builtin} props={props} />;
  }
  NamedIsland.displayName = `Island(${name})`;
  return NamedIsland;
}
