import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { authUserOrNull } from "@/app/signInEmail";
import { isOwner } from "@/lib/owner";
import { dbBackend, getD1 } from "@/lib/d1";
import { swipeAbStats } from "@/lib/repos/swipeAbD1";

// Owner-only, like /dev/roadmap: anyone else gets a plain 404.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Swipe A/B — Lianki dev",
  robots: { index: false, follow: false, nocache: true },
};

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export default async function DevSwipeAbPage() {
  const user = await authUserOrNull();
  if (!isOwner(user?.email)) notFound();
  if (dbBackend() !== "d1") return <main className="p-8">D1 only.</main>;
  const { stats, first, last } = await swipeAbStats(getD1());
  const rows: [string, (s: (typeof stats)[number]) => React.ReactNode][] = [
    ["滑动次数", (s) => s.swipes],
    ["账号", (s) => s.users],
    ["设备", (s) => s.devices],
    ["Again (1)", (s) => s.grades[0]],
    ["Hard (2)", (s) => s.grades[1]],
    ["Good (3)", (s) => s.grades[2]],
    ["Easy (4)", (s) => s.grades[3]],
    ["取消（滑了没打分）", (s) => `${s.cancels} · ${pct(s.cancelRate)}`],
    ["5 秒内撤销", (s) => `${s.undos} · ${pct(s.undoRate)}`],
    ["手指位移中位数", (s) => (s.medianTravel == null ? "–" : `${Math.round(s.medianTravel)} px`)],
  ];
  return (
    <main lang="zh" className="max-w-3xl mx-auto px-4 py-8 space-y-6">
      <header className="space-y-1">
        <h1 className="font-brush text-4xl">滑动 A/B</h1>
        <p className="text-sm opacity-60">
          只有你能看到这页。A = js（指针事件 + JS 档位），B = native（每条竹简一个横向滚动容器 +
          scroll-snap）。默认都是 A，在 /words → Settings → Experimental 打开「New swipe」就是 B。B
          的手指位移取自 touchstart/touchend，没有松手速度。
        </p>
        <p className="text-xs opacity-50 tabular-nums" data-swipe-ab-range>
          {first ? `${first.slice(0, 10)} — ${last!.slice(0, 10)}` : "还没有数据"}
        </p>
      </header>
      <table className="w-full text-sm tabular-nums" data-swipe-ab-table>
        <thead>
          <tr className="text-left opacity-60">
            <th className="py-1 font-normal" />
            <th className="py-1 font-normal">A · js</th>
            <th className="py-1 font-normal">B · native</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, cell]) => (
            <tr key={label} className="border-t border-black/10 dark:border-white/10">
              <td className="py-1 opacity-70">{label}</td>
              {stats.map((s) => (
                <td key={s.variant} className="py-1" data-variant={s.variant}>
                  {cell(s)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
