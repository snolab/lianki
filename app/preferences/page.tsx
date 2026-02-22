"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function PreferencesPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [mobileExcludeDomains, setMobileExcludeDomains] = useState<string[]>([]);
  const [reviewPriorities, setReviewPriorities] = useState<
    Array<{ pattern: string; priority: number }>
  >([]);
  const [newDomain, setNewDomain] = useState("");
  const [newPattern, setNewPattern] = useState("");
  const [newPriority, setNewPriority] = useState(0);

  useEffect(() => {
    fetchPreferences();
  }, []);

  async function fetchPreferences() {
    try {
      const res = await fetch("/api/preferences");
      if (!res.ok) throw new Error("Failed to fetch preferences");
      const data = await res.json();
      setMobileExcludeDomains(data.mobileExcludeDomains || []);
      setReviewPriorities(data.reviewPriorities || []);
    } catch (error) {
      console.error("Error fetching preferences:", error);
      alert("Failed to load preferences");
    } finally {
      setLoading(false);
    }
  }

  async function savePreferences() {
    setSaving(true);
    try {
      const res = await fetch("/api/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mobileExcludeDomains,
          reviewPriorities,
        }),
      });
      if (!res.ok) throw new Error("Failed to save preferences");
      alert("Preferences saved successfully!");
    } catch (error) {
      console.error("Error saving preferences:", error);
      alert("Failed to save preferences");
    } finally {
      setSaving(false);
    }
  }

  function addDomain() {
    if (!newDomain.trim()) return;
    if (mobileExcludeDomains.includes(newDomain.trim())) {
      alert("Domain already exists");
      return;
    }
    setMobileExcludeDomains([...mobileExcludeDomains, newDomain.trim()]);
    setNewDomain("");
  }

  function removeDomain(domain: string) {
    setMobileExcludeDomains(mobileExcludeDomains.filter((d) => d !== domain));
  }

  function addPriority() {
    if (!newPattern.trim()) return;
    if (reviewPriorities.some((p) => p.pattern === newPattern.trim())) {
      alert("Pattern already exists");
      return;
    }
    setReviewPriorities([
      ...reviewPriorities,
      { pattern: newPattern.trim(), priority: newPriority },
    ]);
    setNewPattern("");
    setNewPriority(0);
  }

  function removePriority(pattern: string) {
    setReviewPriorities(reviewPriorities.filter((p) => p.pattern !== pattern));
  }

  if (loading) {
    return <div className="p-8">Loading preferences...</div>;
  }

  return (
    <div className="max-w-4xl mx-auto p-8">
      <div className="mb-6">
        <button
          onClick={() => router.push("/list")}
          className="text-blue-500 hover:text-blue-600"
        >
          ← Back to Home
        </button>
      </div>

      <h1 className="text-3xl font-bold mb-8">Preferences</h1>

      {/* Mobile Exclude Domains */}
      <section className="mb-10">
        <h2 className="text-2xl font-semibold mb-4">Mobile App Domain Filters</h2>
        <p className="text-gray-400 mb-4">
          Domains to exclude from review queue on mobile devices (prevents app hijacking).
        </p>

        <div className="bg-gray-800 rounded-lg p-6 mb-4">
          <h3 className="text-lg font-medium mb-3">Current Filters</h3>
          {mobileExcludeDomains.length === 0 ? (
            <p className="text-gray-500">No domains filtered</p>
          ) : (
            <ul className="space-y-2">
              {mobileExcludeDomains.map((domain) => (
                <li
                  key={domain}
                  className="flex items-center justify-between bg-gray-700 rounded px-4 py-2"
                >
                  <span className="font-mono">{domain}</span>
                  <button
                    onClick={() => removeDomain(domain)}
                    className="text-red-400 hover:text-red-500"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex gap-2">
          <input
            type="text"
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addDomain()}
            placeholder="example.com"
            className="flex-1 bg-gray-800 border border-gray-700 rounded px-4 py-2"
          />
          <button
            onClick={addDomain}
            className="bg-blue-600 hover:bg-blue-700 px-6 py-2 rounded font-medium"
          >
            Add Domain
          </button>
        </div>
      </section>

      {/* Review Priorities */}
      <section className="mb-10">
        <h2 className="text-2xl font-semibold mb-4">Review Priorities</h2>
        <p className="text-gray-400 mb-4">
          URL patterns to prioritize in review queue. Higher priority = shown first.
        </p>

        <div className="bg-gray-800 rounded-lg p-6 mb-4">
          <h3 className="text-lg font-medium mb-3">Current Priorities</h3>
          {reviewPriorities.length === 0 ? (
            <p className="text-gray-500">No priority rules set</p>
          ) : (
            <ul className="space-y-2">
              {reviewPriorities
                .sort((a, b) => b.priority - a.priority)
                .map((item) => (
                  <li
                    key={item.pattern}
                    className="flex items-center justify-between bg-gray-700 rounded px-4 py-2"
                  >
                    <div>
                      <span className="font-mono text-sm">{item.pattern}</span>
                      <span className="ml-4 text-gray-400">
                        Priority: {item.priority}
                      </span>
                    </div>
                    <button
                      onClick={() => removePriority(item.pattern)}
                      className="text-red-400 hover:text-red-500"
                    >
                      Remove
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </div>

        <div className="flex gap-2">
          <input
            type="text"
            value={newPattern}
            onChange={(e) => setNewPattern(e.target.value)}
            placeholder="URL pattern (regex)"
            className="flex-1 bg-gray-800 border border-gray-700 rounded px-4 py-2"
          />
          <input
            type="number"
            value={newPriority}
            onChange={(e) => setNewPriority(Number(e.target.value))}
            placeholder="Priority"
            className="w-32 bg-gray-800 border border-gray-700 rounded px-4 py-2"
          />
          <button
            onClick={addPriority}
            className="bg-blue-600 hover:bg-blue-700 px-6 py-2 rounded font-medium"
          >
            Add Rule
          </button>
        </div>
      </section>

      {/* Save Button */}
      <div className="flex gap-4">
        <button
          onClick={savePreferences}
          disabled={saving}
          className="bg-green-600 hover:bg-green-700 disabled:bg-gray-600 px-8 py-3 rounded font-semibold text-lg"
        >
          {saving ? "Saving..." : "Save Preferences"}
        </button>
        <button
          onClick={() => router.push("/profile")}
          className="bg-gray-700 hover:bg-gray-600 px-8 py-3 rounded font-semibold text-lg"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
