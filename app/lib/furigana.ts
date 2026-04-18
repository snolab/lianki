import furiganaSewer from "furigana-sewer";

/**
 * Generate HTML with ruby annotations for Japanese text.
 * Falls back to plain escaped text if no reading is provided.
 */
export function renderFurigana(sentence: string, reading?: string): string {
  if (!reading) return escapeHtml(sentence);
  try {
    return furiganaSewer(reading, sentence);
  } catch {
    return escapeHtml(sentence);
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
