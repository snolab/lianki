import type { ReadMaterial } from "../ReadListClient";

/** Where /read keeps a signed-out reader's materials (ReadListClient writes it). */
const STORAGE_KEY = "lianki-read-materials";

/** A signed-out reader's material from this device, or null. */
export function getLocalMaterial(id: string): ReadMaterial | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    const materials: ReadMaterial[] = JSON.parse(stored);
    return materials.find((m) => m.id === id) || null;
  } catch {
    return null;
  }
}
