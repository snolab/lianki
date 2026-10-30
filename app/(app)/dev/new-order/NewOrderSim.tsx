"use client";

/**
 * /dev/new-order: try the new-word order (docs/new-word-scheduler.md) on a
 * sample tree or on the owner's real one. Everything lives in this page's
 * memory: nothing is saved, and the study view does not use any of it.
 */
import { useMemo, useState } from "react";
import { useIntlayer, useLocale } from "next-intlayer";
import { longDate } from "@/lib/dates";
import { daysToPass } from "@/lib/words/gate-eta";
import {
  activeChildren,
  bucketByLanguage,
  GROUP_MODE,
  leavesOf,
  type NodeOrder,
  type OrderNode,
  planNew,
  progressOf,
  resolveOrders,
  seenOf,
  tally,
  totals,
} from "@/lib/words/new-order";
import {
  leafColor,
  NewOrderPreview,
  NewOrderSettings,
  useModeName,
} from "@/app/(app)/words/NewOrderControls";
import type { RealData } from "./real";

const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

type Source = "full" | "ja" | "flat" | "mine";

const L = (id: string, name: string, lang: string, size: number, seen = 0, progress = 0) =>
  ({ id, name, lang, size, seen: Math.round(seen * size), score: progress * size }) as OrderNode;
const japanese = () => [
  L("n5", "N5", "ja", 710, 0.5, 0.2),
  L("n4", "N4", "ja", 666),
  L("n3", "N3", "ja", 2103),
  L("n2", "N2", "ja", 1802),
  L("n1", "N1", "ja", 2685),
];
const french = () => [
  L("fr500", "FR 1–500", "fr", 500, 0.3, 0.1),
  L("fr1000", "FR 501–1000", "fr", 500),
  L("fr5000", "FR 1001–5000", "fr", 4000),
];

function preset(source: Exclude<Source, "mine">, allLists: string): OrderNode {
  const root = (children: OrderNode[]): OrderNode => ({ id: "root", name: allLists, children });
  if (source === "ja")
    return root([{ id: "ja", name: "日本語", lang: "ja", children: japanese() }]);
  if (source === "flat") return bucketByLanguage(root([...japanese(), ...french()]));
  return root([
    { id: "ja", name: "日本語", lang: "ja", children: japanese() },
    { id: "fr", name: "Français", lang: "fr", children: french() },
  ]);
}

const update = (n: OrderNode, id: string, fn: (n: OrderNode) => OrderNode): OrderNode =>
  n.id === id
    ? fn(n)
    : n.children
      ? { ...n, children: n.children.map((c) => update(c, id, fn)) }
      : n;

const move = (n: OrderNode, id: string, by: -1 | 1): OrderNode => {
  if (!n.children) return n;
  const i = n.children.findIndex((c) => c.id === id);
  if (i >= 0) {
    const j = i + by;
    if (j < 0 || j >= n.children.length) return n;
    const kids = [...n.children];
    [kids[i], kids[j]] = [kids[j], kids[i]];
    return { ...n, children: kids };
  }
  return { ...n, children: n.children.map((c) => move(c, id, by)) };
};

const pctOf = (x: number) => Math.floor(x * 100 + 1e-9);

export function NewOrderSim({
  real,
  realError,
}: {
  real: RealData | null;
  realError: string | null;
}) {
  const text = useIntlayer("new-order");
  const { locale } = useLocale();
  const modeName = useModeName();
  const [source, setSource] = useState<Source>(real ? "mine" : "full");
  const fresh = (s: Source): OrderNode =>
    s === "mine" && real
      ? { ...real.tree, name: text.allLists.value }
      : preset(s === "mine" ? "full" : s, text.allLists.value);
  const [tree, setTree] = useState<OrderNode>(() => fresh(source));
  const [openIds, setOpen] = useState<Set<string>>(new Set(["root"]));
  const [n, setN] = useState(100);

  const leaves = useMemo(() => leavesOf(tree), [tree]);
  // Colours and names follow the list, not its place, so reordering keeps them.
  const colors = useMemo(
    () => new Map(leavesOf(fresh(source)).map((l, i) => [l.id, leafColor(i)])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [source],
  );
  const names = useMemo(() => new Map(leaves.map((l) => [l.id, l.name ?? l.id])), [leaves]);
  const orders = useMemo(() => resolveOrders(tree), [tree]);
  const plan = useMemo(
    () => planNew(tree, Math.max(n, 1000), undefined, orders),
    [tree, n, orders],
  );
  const seen = useMemo(() => seenOf(tree), [tree]);
  const pick = (next: Source) => {
    setSource(next);
    setTree(fresh(next));
    setOpen(new Set(["root"]));
  };
  const setOrder = (id: string, order: NodeOrder) =>
    setTree((t) => update(t, id, (x) => ({ ...x, order })));
  const setWeight = (id: string, weight: number) =>
    setTree((t) => update(t, id, (x) => ({ ...x, weight })));
  const setLeaf = (id: string, patch: Partial<OrderNode>) =>
    setTree((t) => update(t, id, (x) => ({ ...x, ...patch })));

  const hasBuckets = (tree.children ?? []).some((c) => c.id.startsWith("lang:"));

  const row = (node: OrderNode, depth: number, parent: OrderNode | null): React.ReactNode => {
    const t = totals(node, { seen });
    const progress = progressOf(t);
    const r = orders.get(node.id);
    const name = node.name ?? node.id;
    const isParent = !!node.children?.length;
    const passAt = parent ? orders.get(parent.id)!.passAt : 0.6;
    const tag =
      progress >= 1 ? text.mastered.value : parent && progress >= passAt ? text.passed.value : null;
    const parentOrder = parent ? orders.get(parent.id)! : null;
    const isOpen =
      !parent ||
      activeChildren(parent, parentOrder!, { seen }).some((a) => a.child.id === node.id) ||
      t.seen >= t.size;
    return (
      <div key={node.id} style={{ marginInlineStart: depth ? 12 : 0 }} className="space-y-2">
        <div
          className={`rounded-lg px-3 py-2 space-y-1 ${isParent ? "bg-black/[0.07] dark:bg-white/[0.08]" : "bg-black/5 dark:bg-white/5"} ${isOpen ? "" : "opacity-50"}`}
        >
          <div className="flex items-center gap-2">
            {!isParent && (
              <span
                className="inline-block w-3 h-3 rounded-sm shrink-0"
                style={{ background: colors.get(node.id) }}
              />
            )}
            <span className="flex-1 min-w-0 truncate font-medium">
              {name}
              {isParent && r && (
                <span className="ms-2 text-xs opacity-60 font-normal">{modeName(r.mode)}</span>
              )}
              {tag && (
                <span
                  className="ms-2 text-xs font-normal"
                  style={{ color: "oklch(0.65 0.15 150)" }}
                >
                  {tag}
                </span>
              )}
            </span>
            {parent && (
              <>
                <button
                  className="tap-40 px-2 opacity-60"
                  aria-label={fill(text.moveUp.value, { name })}
                  onClick={() => setTree((x) => move(x, node.id, -1))}
                >
                  ↑
                </button>
                <button
                  className="tap-40 px-2 opacity-60"
                  aria-label={fill(text.moveDown.value, { name })}
                  onClick={() => setTree((x) => move(x, node.id, 1))}
                >
                  ↓
                </button>
              </>
            )}
            {isParent && (
              <button
                className="tap-40 px-2"
                aria-label={fill(text.menu.value, { name })}
                aria-expanded={openIds.has(node.id)}
                onClick={() =>
                  setOpen((s) => {
                    const next = new Set(s);
                    if (next.has(node.id)) next.delete(node.id);
                    else next.add(node.id);
                    return next;
                  })
                }
              >
                ⋯
              </button>
            )}
          </div>
          <div className="text-xs opacity-60 tabular-nums">
            {fill(text.stats.value, { seen: t.seen, size: t.size, pct: pctOf(progress) })}
          </div>
          {!isParent && (node.size ?? 0) > 0 && (
            <div className="grid grid-cols-2 gap-3">
              <input
                type="range"
                min={0}
                max={node.size}
                value={t.seen}
                aria-label={fill(text.seenOf.value, { name })}
                onChange={(e) => {
                  const s = Number(e.target.value);
                  setLeaf(node.id, { seen: s, score: Math.min(node.score ?? 0, s) });
                }}
              />
              <input
                type="range"
                min={0}
                max={100}
                value={pctOf(progress)}
                aria-label={fill(text.progressOf.value, { name })}
                onChange={(e) => {
                  const score = (Number(e.target.value) / 100) * node.size!;
                  setLeaf(node.id, { score, seen: Math.max(t.seen, Math.ceil(score)) });
                }}
              />
            </div>
          )}
        </div>
        {isParent && openIds.has(node.id) && r && (
          <NewOrderSettings
            node={node}
            resolved={r}
            inherited={
              parent ? (parent.id === "root" ? GROUP_MODE : orders.get(parent.id)!.mode) : null
            }
            isRoot={!parent}
            onOrder={(o) => setOrder(node.id, o)}
            onWeight={setWeight}
          >
            <NewOrderPreview root={node} n={10} names={names} colors={colors} orders={orders} />
          </NewOrderSettings>
        )}
        {node.children?.map((c) => row(c, depth + 1, node))}
      </div>
    );
  };

  const shareTable = (k: number) => {
    const counts = new Map(tally(plan.slice(0, k)));
    const total = Math.min(k, plan.length);
    return (
      <div className="space-y-1">
        <h3 className="text-sm font-medium">{fill(text.sharesOver.value, { n: k })}</h3>
        <table className="w-full text-sm tabular-nums">
          <tbody>
            {leaves
              .filter((l) => counts.get(l.id))
              .map((l) => (
                <tr key={l.id} className="border-t border-black/10 dark:border-white/10">
                  <td className="py-1">
                    <span
                      className="inline-block w-2.5 h-2.5 rounded-sm me-2"
                      style={{ background: colors.get(l.id) }}
                    />
                    {l.name}
                  </td>
                  <td className="py-1 text-end">{counts.get(l.id)}</td>
                  <td className="py-1 text-end opacity-60 w-14">
                    {Math.round(((counts.get(l.id) ?? 0) / total) * 100)}%
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    );
  };

  // When each closed next level opens: its predecessor's projected progress
  // reaching the parent's pass mark. Real data only; information, not a choice.
  const etas = useMemo(() => {
    if (source !== "mine" || !real) return [];
    const out: { key: string; line: string; pace?: string }[] = [];
    const walk = (p: OrderNode) => {
      const r = orders.get(p.id);
      if (!r || !p.children) return;
      if (r.mode === "seq" || r.mode === "stagger")
        for (let i = 1; i < p.children.length; i++) {
          const prev = p.children[i - 1];
          const next = p.children[i];
          const nextName = next.name ?? next.id;
          const ls = leavesOf(prev);
          const size = ls.reduce((a, l) => a + (l.size ?? 0), 0);
          const curve = { seen: [] as number[], score: [] as number[] };
          const len = Math.max(0, ...ls.map((l) => real.curves[l.id]?.length ?? 0));
          for (let d = 0; d < len; d++) {
            curve.seen.push(0);
            curve.score.push(
              ls.reduce(
                (a, l) =>
                  a + (real.curves[l.id]?.[Math.min(d, (real.curves[l.id]?.length ?? 1) - 1)] ?? 0),
                0,
              ),
            );
          }
          const days = daysToPass(curve, size, r.passAt);
          const date = new Date(`${real.today}T00:00:00`);
          if (days != null) date.setDate(date.getDate() + days);
          const line =
            days === 0
              ? fill(text.etaOpen.value, { next: nextName })
              : days == null
                ? fill(text.etaNever.value, { next: nextName })
                : fill(text.etaAround.value, {
                    next: nextName,
                    date: longDate(date, locale),
                    days,
                  });
          const pace = ls.length === 1 ? real.pace[ls[0].id] : undefined;
          out.push({
            key: `${p.id}:${next.id}`,
            line: `${prev.name ?? prev.id} → ${line}`,
            pace: pace && fill(text.pace.value, { n: pace.n.toFixed(1), r: pace.r.toFixed(0) }),
          });
          if (days !== 0) break; // the levels after it wait for this one
        }
      p.children.forEach(walk);
    };
    walk(tree);
    return out;
  }, [source, real, orders, tree, text, locale]);

  return (
    <div className="space-y-6" data-new-order-sim>
      <header className="space-y-1">
        <h1 className="font-brush text-4xl">{text.title}</h1>
        <p className="text-sm opacity-60">{text.intro}</p>
      </header>
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm opacity-70" htmlFor="new-order-source">
          {text.treeLabel}
        </label>
        <select
          id="new-order-source"
          value={source}
          onChange={(e) => pick(e.target.value as Source)}
          className="flex-1 min-w-0 rounded px-2 py-1.5 bg-black/10 dark:bg-white/10"
        >
          {real && <option value="mine">{text.myLists}</option>}
          <option value="full">{text.presetFull}</option>
          <option value="ja">{text.presetJa}</option>
          <option value="flat">{text.presetFlat}</option>
        </select>
        <button
          className="px-3 py-1.5 rounded bg-black/10 dark:bg-white/10"
          onClick={() => pick(source)}
        >
          {text.reset}
        </button>
      </div>
      {realError && <p className="text-xs opacity-60">{realError}</p>}

      {etas.length > 0 && (
        <section className="space-y-1 rounded-lg p-3 bg-black/5 dark:bg-white/5" data-new-order-eta>
          <h2 className="font-medium">{text.etaHeading}</h2>
          {etas.map((e) => (
            <div key={e.key} className="text-sm">
              {e.line}
              {e.pace && <div className="text-xs opacity-60 tabular-nums">{e.pace}</div>}
            </div>
          ))}
          <p className="text-xs opacity-60">{text.etaNote}</p>
        </section>
      )}

      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <h2 className="font-medium flex-1">{fill(text.sequence.value, { n })}</h2>
          {[100, 300, 1000].map((k) => (
            <button
              key={k}
              onClick={() => setN(k)}
              className={`px-2 py-1 rounded text-sm tabular-nums ${n === k ? "bg-black/15 dark:bg-white/20" : "bg-black/5 dark:bg-white/5"}`}
            >
              {k}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-px" aria-hidden data-new-order-strip>
          {plan.slice(0, n).map((id, i) => (
            <span
              key={i}
              className={n > 300 ? "w-1.5 h-2.5" : "w-2.5 h-4"}
              style={{ background: colors.get(id) }}
              title={names.get(id)}
            />
          ))}
        </div>
        {!plan.length && <p className="text-sm opacity-70">{text.noneLeft}</p>}
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        {shareTable(300)}
        {shareTable(1000)}
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">{text.treeLabel}</h2>
        {hasBuckets && <p className="text-xs opacity-60">{text.bucketNote}</p>}
        {row(tree, 0, null)}
      </section>
    </div>
  );
}
