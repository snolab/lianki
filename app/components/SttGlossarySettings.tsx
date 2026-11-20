"use client";
import { useEffect, useRef, useState } from "react";
import { PREF_APPLIED_EVENT } from "@lianki/ui-state/account";
import { startPrefSync } from "@/lib/prefs/client";
import { readSttGlossary, writeSttGlossary } from "@/lib/stt-glossary-client";
import type { Correction } from "@/vendor/otoji/packages/transcript-glossary/src/index";

export type SttGlossaryLabels = {
  heading: string;
  help: string;
  words: string;
  corrections: string;
  save: string;
  saved: string;
  error: string;
};
export function SttGlossarySettings({
  userId,
  labels: c,
}: {
  userId: string;
  labels: SttGlossaryLabels;
}) {
  const [words, setWords] = useState("");
  const [pairs, setPairs] = useState("");
  const [prior, setPrior] = useState<Correction[]>([]);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const dirty = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    dirty.current = false;
    setWords("");
    setPairs("");
    setPrior([]);
    setMessage("");
    setSaving(false);
    setReady(false);
    let active = true;
    const reload = () => {
      if (!active) return;
      const current = readSttGlossary(userId);
      setReady(!!current);
      if (current && dirty.current) return;
      setWords(current?.hotwords.join("\n") ?? "");
      setPairs(current?.corrections.map((x) => `${x.heard} => ${x.corrected}`).join("\n") ?? "");
      setPrior(current?.corrections ?? []);
      setMessage("");
    };
    reload();
    void startPrefSync()?.pull().then(reload);
    window.addEventListener(PREF_APPLIED_EVENT, reload);
    window.addEventListener("storage", reload);
    return () => {
      active = false;
      generation.current++;
      window.removeEventListener(PREF_APPLIED_EVENT, reload);
      window.removeEventListener("storage", reload);
    };
  }, [userId]);
  const save = async () => {
    const run = generation.current;
    setSaving(true);
    setMessage("");
    const hotwords = words
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
    const now = Date.now();
    const corrections = pairs
      .split("\n")
      .filter((x) => x.trim())
      .map((line) => {
        const parts = line.split("=>");
        const heard = parts[0]?.trim() ?? "";
        const corrected = parts.length === 2 ? parts[1]!.trim() : "";
        return {
          heard,
          corrected,
          at: prior.find((x) => x.heard === heard && x.corrected === corrected)?.at ?? now,
        };
      });
    const ok = await writeSttGlossary(userId, hotwords, corrections);
    if (run !== generation.current) return;
    if (ok) dirty.current = false;
    setMessage(ok ? c.saved : c.error);
    setSaving(false);
  };
  return (
    <section id="stt-glossary" data-section="stt-glossary" className="mb-10 max-w-xl scroll-mt-6">
      <h2 className="mb-2 text-2xl font-semibold">{c.heading}</h2>
      <p className="mb-4 text-sm opacity-80">{c.help}</p>
      <label className="mb-4 block">
        {c.words}
        <textarea
          rows={5}
          value={words}
          disabled={!ready || saving}
          onInput={(e) => {
            dirty.current = true;
            setWords(e.currentTarget.value);
          }}
          className="mt-1 block w-full rounded-lg border p-3"
        />
      </label>
      <label className="mb-4 block">
        {c.corrections}
        <textarea
          rows={5}
          value={pairs}
          disabled={!ready || saving}
          onInput={(e) => {
            dirty.current = true;
            setPairs(e.currentTarget.value);
          }}
          className="mt-1 block w-full rounded-lg border p-3"
        />
      </label>
      <button
        type="button"
        disabled={!ready || saving}
        onClick={() => void save()}
        className="min-h-11 rounded-full border px-5 disabled:opacity-50"
      >
        {c.save}
      </button>
      <p role="status" className="mt-2 text-sm">
        {message}
      </p>
    </section>
  );
}
