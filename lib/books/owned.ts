// The catalogue books a user has already imported: "<lang>/<slug>" → their
// read_material id, so /books can say "in my reading" and open it. D1 only;
// one query, scoped to the user.

import { getD1 } from "@/lib/d1";

export async function ownedPresets(userId: string): Promise<Record<string, string>> {
  const { results } = await getD1()
    .prepare(
      `SELECT id, source_key FROM read_materials
       WHERE user_id = ? AND source_key LIKE 'preset:%'
       ORDER BY created_at ASC`,
    )
    .bind(userId)
    .all<{ id: string; source_key: string }>();
  const out: Record<string, string> = {};
  for (const r of results ?? []) out[r.source_key.slice("preset:".length)] = r.id;
  return out;
}
