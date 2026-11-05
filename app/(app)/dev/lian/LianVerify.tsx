"use client";

import { useEffect, useState } from "react";
import { type ChainCheck, studyDayLeaf, verifyChain, verifyProof } from "@lianki/lian";
import type { AnchorRow, LianProof } from "@/lib/lian/anchor";

type Mine = Record<string, "checking" | "ok" | "bad">;

/** Recheck the chain, then each of my own leaves, with packages/lian in the browser. */
export function LianVerify({
  anchors,
  stamps,
}: {
  anchors: AnchorRow[];
  stamps: Record<string, string>;
}) {
  const [chain, setChain] = useState<ChainCheck | null>(null);
  const [mine, setMine] = useState<Mine>({});

  useEffect(() => {
    void verifyChain(anchors).then(setChain);
  }, [anchors]);

  useEffect(() => {
    const roots = new Map(anchors.map((a) => [a.day, a]));
    void (async () => {
      const res = await fetch("/api/lian/proof");
      if (!res.ok) return;
      const { days } = (await res.json()) as { days: string[] };
      for (const day of days) {
        setMine((m) => ({ ...m, [day]: "checking" }));
        const p = (await (await fetch(`/api/lian/proof?day=${day}`)).json()) as LianProof;
        const leaf = await studyDayLeaf(p.preimage);
        const a = roots.get(day);
        const ok =
          !!a &&
          leaf === p.leafHash &&
          a.merkleRoot === p.merkleRoot &&
          a.chainHash === p.chainHash &&
          (await verifyProof(leaf, p.proof, a.merkleRoot));
        setMine((m) => ({ ...m, [day]: ok ? "ok" : "bad" }));
      }
    })();
  }, [anchors]);

  return (
    <>
      <p className="text-sm" data-testid="lian-chain">
        {!chain
          ? "Checking the chain…"
          : chain.ok
            ? `Chain ok: ${chain.days} day(s), head ${chain.head.slice(0, 16)}…`
            : `Chain broken at ${chain.day} (${chain.reason})`}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="text-left opacity-60">
              <th className="py-1 pr-3">day</th>
              <th className="pr-3">leaves</th>
              <th className="pr-3">root</th>
              <th className="pr-3">chain</th>
              <th className="pr-3">mine</th>
              <th>timestamp</th>
            </tr>
          </thead>
          <tbody>
            {[...anchors].reverse().map((a) => (
              <tr key={a.day} className="border-t border-gray-300 dark:border-gray-700">
                <td className="py-1 pr-3">{a.day}</td>
                <td className="pr-3">{a.leafCount}</td>
                <td className="pr-3" title={a.merkleRoot}>
                  {a.merkleRoot.slice(0, 12)}
                </td>
                <td className="pr-3" title={a.chainHash}>
                  {a.chainHash.slice(0, 12)}
                </td>
                <td className="pr-3">
                  {mine[a.day] === "ok" ? "✓" : mine[a.day] === "bad" ? "✗" : (mine[a.day] ?? "")}
                </td>
                <td>{stamps[a.day] ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!anchors.length && <p className="text-sm opacity-70">No anchors yet.</p>}
    </>
  );
}
