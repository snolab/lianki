import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { miniAppApiOrigin, miniAppsIn, type MiniAppRef } from "./mini-app-links";
import { miniAppEmbedView, type MiniAppEmbedView, type MiniAppSizing } from "./mini-app-panel";
import { MiniAppPanel, type MiniAppLabels } from "./MiniAppPanel";
export type { MiniAppRef, MiniAppEmbedView, MiniAppSizing, MiniAppLabels };

export type MiniAppCardsProps = {
  text: string;
  apps?: readonly MiniAppRef[];
  origin?: string;
  scope?: string;
  portalRoot?: Element;
  labels: MiniAppLabels;
  sizing: MiniAppSizing;
  renderHost: (view: MiniAppEmbedView) => ReactNode;
};

export function MiniAppCards(props: MiniAppCardsProps) {
  return (
    <>
      {miniAppsIn(props.text, props.apps, props.origin).map((app) => (
        <MiniAppCard key={`${props.scope ?? ""}:${app.slug}`} {...props} slug={app.slug} />
      ))}
    </>
  );
}

/** Metadata can load with the card; untrusted app HTML is handed only to the sandbox host on Open. */
function MiniAppCard({
  slug,
  origin,
  labels,
  sizing,
  renderHost,
  portalRoot,
}: MiniAppCardsProps & { slug: string }) {
  const [view, setView] = useState<MiniAppEmbedView | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setView(null);
    void fetch(
      `${miniAppApiOrigin(origin ?? window.location.origin)}/api/my/mini-apps/${encodeURIComponent(slug)}?embed=1`,
      { signal: controller.signal, credentials: "same-origin", cache: "no-store" },
    )
      .then(async (r) => (r.ok ? r.json() : null))
      .then((data: unknown) => {
        if (!active) return;
        setView(
          miniAppEmbedView(
            data && typeof data === "object" ? (data as { view?: unknown }).view : null,
            slug,
          ),
        );
      })
      .catch(() => {
        if (active) setView(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [slug, origin]);
  return (
    <div
      data-testid="mini-app-card"
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      className="my-1 max-w-full rounded-lg border px-3 py-2"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden>{view?.icon ?? "▦"}</span>
        <span className="min-w-0 flex-1 truncate">{view?.name ?? slug}</span>
        <button
          type="button"
          data-testid="mini-app-open"
          className="rounded border px-3 py-1"
          onClick={() => setOpen(true)}
        >
          {labels.open}
        </button>
      </div>
      {open &&
        createPortal(
          <MiniAppPanel
            title={view?.name ?? slug}
            labels={labels}
            sizing={sizing}
            onClose={() => setOpen(false)}
          >
            {loading ? (
              <p role="status">{labels.loading}</p>
            ) : view ? (
              renderHost(view)
            ) : (
              <p role="status">{labels.unavailable}</p>
            )}
          </MiniAppPanel>,
          portalRoot ?? document.body,
        )}
    </div>
  );
}
