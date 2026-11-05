/**
 * Which self-intro fields the Learning Partner may still ask about
 * (docs/self-intro-import.md, "Follow-up questions"). Client-safe: the page
 * uses it to know whether to start, the route to bound the model.
 */
import { SELF_INTRO_FIELDS, type SelfIntroField } from "./import-config";

export type FactState = {
  field: SelfIntroField;
  certain: boolean;
  status: "pending" | "kept" | "dropped";
};

/**
 * The fields worth a question, in the interview's order: no fact the user
 * kept and no sure fact still standing (empty, dropped, or only "not sure"),
 * and not asked before.
 */
export function openFields(
  facts: FactState[],
  asked: { field: SelfIntroField }[],
): SelfIntroField[] {
  const done = new Set(asked.map((a) => a.field));
  return SELF_INTRO_FIELDS.filter(
    (k) =>
      !done.has(k) &&
      !facts.some(
        (f) => f.field === k && (f.status === "kept" || (f.status === "pending" && f.certain)),
      ),
  );
}
