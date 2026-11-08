/**
 * The reader's way back to its parent, the list of books on /read. One
 * source of truth for the href and the label: the top of the page (the ←
 * in the toolbar) and the end of the book (after the last paragraph, so he leaves without scrolling up) both
 * render this, so they always point to the same place.
 */
import Link from "next/link";

/** Where the reader goes back to. */
export const READER_PARENT_HREF = "/reader";

export function ReaderBack({
  label,
  variant,
}: {
  /** read-reader `back` ("Back to books"). */
  label: string;
  /** icon: the toolbar's ←; end: the book's last line. */
  variant: "icon" | "end";
}) {
  if (variant === "icon")
    return (
      <Link
        href={READER_PARENT_HREF}
        aria-label={label}
        title={label}
        data-testid="reader-back"
        className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-lg"
      >
        <span aria-hidden>←</span>
      </Link>
    );
  // The end of the book: centred, in the flow (never fixed), so the safe-area
  // inset, the chat pill and the toasts stay clear of it.
  return (
    <div className="flex justify-center px-4 pt-10 pb-6">
      <Link
        href={READER_PARENT_HREF}
        data-testid="reader-back-end"
        className="inline-flex min-h-11 items-center gap-2 rounded-full border border-[oklch(0.85_0.01_260)] bg-[oklch(0.97_0.005_260)] px-5 text-sm font-medium text-[oklch(0.3_0.02_260)] hover:bg-[oklch(0.93_0.008_260)] dark:border-[oklch(0.4_0.01_260)] dark:bg-[oklch(0.25_0.01_260)] dark:text-[oklch(0.92_0.01_260)] dark:hover:bg-[oklch(0.3_0.01_260)]"
      >
        <span aria-hidden>←</span>
        {label}
      </Link>
    </div>
  );
}
