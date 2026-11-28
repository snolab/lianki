import { chatExtra, chatLocale } from "./chat-ui-locales";

export type ModelDownloadKind = "wake" | "stt";

type FocusableLike = { focus?: () => void; isConnected?: boolean };

const MODAL_STYLE = `
[data-testid="model-download-modal"] {
  padding: 16px;
  padding-top: max(16px, env(safe-area-inset-top));
  padding-right: max(16px, env(safe-area-inset-right));
  padding-bottom: max(16px, env(safe-area-inset-bottom));
  padding-left: max(16px, env(safe-area-inset-left));
  background: oklch(0.1 0 0 / 0.45);
}
[data-testid="model-download-panel"] {
  background: var(--background, oklch(0.98 0.005 85));
  background: oklch(from var(--background, oklch(0.98 0.005 85)) l c h / 0.88);
  border: 1px solid oklch(0.2 0.01 80 / 0.14);
  border: 1px solid oklch(from var(--foreground, oklch(0.2 0.01 80)) l c h / 0.14);
  /* Never taller than the viewport (short screens, large text): the copy scrolls, the buttons stay. */
  max-height: calc(100vh - 32px);
  max-height: min(100%, calc(100dvh - 32px));
  overflow-y: auto;
  overscroll-behavior: contain;
}
[data-testid="model-download-scroll"] {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
[data-testid="model-download-cancel"] {
  background: oklch(0.5 0.01 80 / 0.12);
  background: oklch(from var(--foreground, oklch(0.2 0.01 80)) l c h / 0.08);
}
[data-testid="model-download-cancel"]:focus-visible,
[data-testid="model-download-allow"]:focus-visible {
  outline: 2px solid var(--primary, var(--lk-primary, oklch(0.53 0.207 22.3)));
  outline-offset: 2px;
}
@media (prefers-reduced-transparency: reduce) {
  [data-testid="model-download-modal"] {
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }
  [data-testid="model-download-panel"] {
    background: var(--background, oklch(0.98 0.005 85)) !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }
}
`;

let modalSeq = 0;
let modalQueue: Promise<void> = Promise.resolve();

function canMount(signal?: AbortSignal): boolean {
  const doc = globalThis.document;
  return (
    !signal?.aborted &&
    doc?.visibilityState === "visible" &&
    Boolean(doc.body) &&
    typeof doc.createElement === "function"
  );
}

function openGlassConfirmModal(
  estimatedMb: number,
  kind: ModelDownloadKind,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!canMount(signal)) return Promise.resolve(false);

  const doc = globalThis.document;
  const win = globalThis.window;
  const locale = chatLocale();
  const strings = chatExtra();
  const formattedMb = new Intl.NumberFormat(locale).format(estimatedMb);
  const titleText = kind === "stt" ? strings.modelDownloadTitleStt : strings.modelDownloadTitleWake;
  const bodyTemplate =
    kind === "stt" ? strings.modelDownloadSttConfirm : strings.modelDownloadConfirm;
  const bodyText = bodyTemplate.replace("{mb}", formattedMb);

  const seq = ++modalSeq;
  const titleId = `lk-model-download-title-${seq}`;
  const bodyId = `lk-model-download-body-${seq}`;
  const priorFocus = doc.activeElement as FocusableLike | null;

  const backdrop = doc.createElement("div");
  backdrop.setAttribute("data-testid", "model-download-modal");
  backdrop.style.cssText = [
    "position: fixed",
    "inset: 0",
    "z-index: var(--lk-z-chat-modal, 90)",
    "display: flex",
    "align-items: center",
    "justify-content: center",
    "box-sizing: border-box",
    "padding-top: max(16px, env(safe-area-inset-top))",
    "padding-right: max(16px, env(safe-area-inset-right))",
    "padding-bottom: max(16px, env(safe-area-inset-bottom))",
    "padding-left: max(16px, env(safe-area-inset-left))",
    "background: oklch(0.1 0 0 / 0.45)",
    "backdrop-filter: blur(6px)",
    "-webkit-backdrop-filter: blur(6px)",
  ].join("; ");

  const styleEl = doc.createElement("style");
  styleEl.textContent = MODAL_STYLE;
  backdrop.appendChild(styleEl);

  const panel = doc.createElement("div");
  panel.setAttribute("role", "alertdialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", titleId);
  panel.setAttribute("aria-describedby", bodyId);
  panel.setAttribute("data-testid", "model-download-panel");
  panel.style.cssText = [
    "box-sizing: border-box",
    "width: 100%",
    "max-width: min(26rem, 100%)",
    "border-radius: 16px",
    "padding: 20px",
    "display: flex",
    "flex-direction: column",
    "gap: 14px",
    "min-height: 0",
    "overflow-y: auto",
    "background: oklch(from var(--background, oklch(0.98 0.005 85)) l c h / 0.88)",
    "backdrop-filter: blur(16px) saturate(1.4)",
    "-webkit-backdrop-filter: blur(16px) saturate(1.4)",
    "border: 1px solid oklch(from var(--foreground, oklch(0.2 0.01 80)) l c h / 0.14)",
    "color: var(--foreground, oklch(0.2 0.01 80))",
    "box-shadow: 0 20px 50px oklch(0.12 0.01 65 / 0.32)",
    "font-family: var(--font-sans, ui-sans-serif, system-ui, sans-serif)",
  ].join("; ");

  const heading = doc.createElement("h2");
  heading.id = titleId;
  heading.setAttribute("data-testid", "model-download-title");
  heading.textContent = titleText;
  heading.style.cssText = [
    "margin: 0",
    "font-size: 1.0625rem",
    "line-height: 1.35",
    "font-weight: 600",
  ].join("; ");

  const body = doc.createElement("p");
  body.id = bodyId;
  body.setAttribute("data-testid", "model-download-body");
  body.textContent = bodyText;
  body.style.cssText = [
    "margin: 0",
    "font-size: 0.9375rem",
    "line-height: 1.5",
    "opacity: 0.92",
  ].join("; ");

  const scroll = doc.createElement("div");
  scroll.setAttribute("data-testid", "model-download-scroll");
  scroll.style.cssText = [
    "display: flex",
    "flex-direction: column",
    "gap: 14px",
    "flex: 1 1 auto",
    "min-height: 0",
    "overflow-y: auto",
  ].join("; ");

  const actions = doc.createElement("div");
  actions.setAttribute("data-testid", "model-download-actions");
  actions.style.cssText = [
    "flex: 0 0 auto",
    "display: flex",
    "flex-wrap: wrap",
    "justify-content: flex-end",
    "gap: 10px",
    "margin-top: 4px",
  ].join("; ");

  const cancelBtn = doc.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.setAttribute("data-testid", "model-download-cancel");
  cancelBtn.textContent = strings.modelDownloadCancel;
  cancelBtn.style.cssText = [
    "min-height: 44px",
    "padding: 0 16px",
    "border-radius: 10px",
    "border: 0",
    "cursor: pointer",
    "font: inherit",
    "font-size: 0.9375rem",
    "font-weight: 500",
    "background: oklch(from var(--foreground, oklch(0.2 0.01 80)) l c h / 0.08)",
    "color: inherit",
  ].join("; ");

  const allowBtn = doc.createElement("button");
  allowBtn.type = "button";
  allowBtn.setAttribute("data-testid", "model-download-allow");
  allowBtn.textContent = strings.modelDownloadAllow;
  allowBtn.style.cssText = [
    "min-height: 44px",
    "padding: 0 18px",
    "border-radius: 10px",
    "border: 0",
    "cursor: pointer",
    "font: inherit",
    "font-size: 0.9375rem",
    "font-weight: 600",
    "background: var(--primary, var(--lk-primary, oklch(0.53 0.207 22.3)))",
    "color: var(--on-primary, var(--lk-on-primary, oklch(0.99 0 0)))",
  ].join("; ");

  actions.appendChild(cancelBtn);
  actions.appendChild(allowBtn);
  scroll.appendChild(heading);
  scroll.appendChild(body);
  panel.appendChild(scroll);
  panel.appendChild(actions);
  backdrop.appendChild(panel);
  doc.body.appendChild(backdrop);

  return new Promise<boolean>((resolve) => {
    let settled = false;

    const finish = (allowed: boolean) => {
      if (settled) return;
      settled = true;
      allowBtn.removeEventListener("click", onAllow);
      cancelBtn.removeEventListener("click", onCancel);
      backdrop.removeEventListener("click", onBackdropClick);
      doc.removeEventListener("keydown", onKeyDown);
      doc.removeEventListener("visibilitychange", onVisibilityChange);
      win?.removeEventListener?.("pagehide", onCancel);
      signal?.removeEventListener("abort", onCancel);
      backdrop.remove();
      if (priorFocus && priorFocus.isConnected !== false && typeof priorFocus.focus === "function") {
        try {
          priorFocus.focus();
        } catch {}
      }
      resolve(allowed);
    };

    const onAllow = () => finish(true);
    const onCancel = () => finish(false);
    const onBackdropClick = (e: Event) => {
      if (e.target === backdrop) finish(false);
    };
    const onVisibilityChange = () => {
      if (doc.visibilityState !== "visible") finish(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const active = doc.activeElement;
        if (active === cancelBtn) allowBtn.focus();
        else if (active === allowBtn) cancelBtn.focus();
        else (e.shiftKey ? allowBtn : cancelBtn).focus();
      }
    };

    allowBtn.addEventListener("click", onAllow);
    cancelBtn.addEventListener("click", onCancel);
    backdrop.addEventListener("click", onBackdropClick);
    doc.addEventListener("keydown", onKeyDown);
    doc.addEventListener("visibilitychange", onVisibilityChange);
    win?.addEventListener?.("pagehide", onCancel);
    signal?.addEventListener("abort", onCancel, { once: true });

    cancelBtn.focus();
  });
}

/** Non-blocking in-app glass confirmation; refusal, hidden pages or abort keep ordinary STT active. */
export async function confirmBrowserModelDownload({
  estimatedMb,
  kind = "wake",
  signal,
}: {
  estimatedMb: number;
  kind?: ModelDownloadKind;
  signal?: AbortSignal;
}): Promise<boolean> {
  if (!canMount(signal)) return false;

  const prev = modalQueue;
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  modalQueue = prev.then(() => next);

  try {
    if (signal) {
      let onAbort: (() => void) | undefined;
      await Promise.race([
        prev,
        new Promise<void>((resolve) => {
          onAbort = () => resolve();
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    } else {
      await prev;
    }
    return await openGlassConfirmModal(estimatedMb, kind, signal);
  } finally {
    release();
  }
}
