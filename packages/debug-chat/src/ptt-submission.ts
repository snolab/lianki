/** One held input, including a whole-recording result that local durable enqueue refused. */
export type PttPreview = {
  key: number;
  text: string;
  state: "speaking" | "sending" | "unsent";
  start: number;
  end?: number;
  reason?: string;
};

export function createPttSubmission<T extends { text: string }>(d: {
  scope: () => string | null | undefined;
  show: (preview: PttPreview | null) => void;
  send: (line: T) => boolean;
}) {
  let next = 0;
  let active: {
    scope: string | null | undefined;
    preview: PttPreview;
    held: boolean;
    line?: T;
  } | null = null;
  const current = (key: number) => active?.preview.key === key && active.scope === d.scope();
  const show = () => d.show(active?.held ? { ...active.preview } : null);
  const retry = () => {
    if (!active?.line || !current(active.preview.key)) return false;
    let accepted = false;
    try {
      accepted = d.send(structuredClone(active.line));
    } catch {}
    if (!accepted) {
      active.preview.state = "unsent";
      show();
      return false;
    }
    active = null;
    show();
    return true;
  };
  return {
    begin(start: number) {
      if (
        active &&
        current(active.preview.key) &&
        (active.line || active.preview.state !== "unsent")
      )
        return null;
      active = {
        scope: d.scope(),
        preview: { key: ++next, text: "", state: "speaking", start },
        held: false,
      };
      return next;
    },
    hold(key: number) {
      if (current(key)) {
        active!.held = true;
        show();
      }
    },
    partial(key: number, text: string) {
      if (current(key) && !active!.line) {
        active!.preview.text = text;
        show();
      }
    },
    release(key: number, end: number) {
      if (!current(key)) return;
      active!.preview = { ...active!.preview, end, state: "sending" };
      show();
    },
    complete(key: number, line: T) {
      if (!current(key)) return false;
      if (!line.text.trim()) {
        active = null;
        show();
        return false;
      }
      active!.line = structuredClone(line);
      active!.preview.text = line.text;
      return retry();
    },
    failed(key: number, reason?: string) {
      if (current(key)) {
        active!.preview.state = "unsent";
        active!.preview.reason = reason;
        show();
      }
    },
    ready: () => !!active?.line,
    retry,
    current,
    busy: () =>
      !!active &&
      current(active.preview.key) &&
      (active.preview.state !== "unsent" || !!active.line),
    cancel() {
      active = null;
      show();
    },
  };
}
