import type { Meta, StoryObj } from "@storybook/html";

// ── helpers extracted from lianki.user.js ──────────────────────────────────

const btn = (bg: string, extra = "") =>
  `all:initial;display:inline-block;box-sizing:border-box;background:${bg};color:${bg === "transparent" ? "var(--lk-fg)" : "#eee"};border:none;border-radius:8px;padding:8px 14px;cursor:pointer;font-size:13px;font-family:system-ui,sans-serif;min-width:60px;line-height:1.5;text-align:center;${extra}`;

const CSS_VARIABLES = `
  :host {
    --lk-bg: #1e1e1e;
    --lk-fg: #eeeeee;
    --lk-shadow: 0 8px 32px rgba(0,0,0,0.6);
    --lk-input-bg: #222222;
    --lk-input-fg: #dddddd;
    --lk-input-border: #444444;
    --lk-muted: #aaaaaa;
    --lk-backdrop: rgba(0,0,0,0.75);
    --lk-error: #ff8a80;
    --lk-success: #69f0ae;
  }
  @media (prefers-color-scheme: light) {
    :host {
      --lk-bg: #ffffff;
      --lk-fg: #111111;
      --lk-shadow: 0 8px 32px rgba(0,0,0,0.15);
      --lk-input-bg: #f0f0f0;
      --lk-input-fg: #333333;
      --lk-input-border: #cccccc;
      --lk-muted: #666666;
      --lk-backdrop: rgba(0,0,0,0.5);
      --lk-error: #b71c1c;
      --lk-success: #1b5e20;
    }
  }
`;

type Phase = "adding" | "reviewing" | "error" | "reviewed";

interface ReviewOption {
  label: string;
  due: string;
  rating: number;
}

interface ModalArgs {
  phase: Phase;
  currentUrl: string;
  pageTitle: string;
  notes: string;
  notesSynced: boolean;
  errorMessage: string;
  errorDetails: string;
  reviewedMessage: string;
  options: ReviewOption[];
  showOfflineIndicator: boolean;
  offlineStatus: "offline" | "syncing" | "queued" | "ready";
  queueLength: number;
}

// ── Shadow DOM modal builder ───────────────────────────────────────────────

function buildModal(args: ModalArgs): HTMLElement {
  const shadowHost = document.createElement("div");
  const shadow = shadowHost.attachShadow({ mode: "open" });

  const styleReset = document.createElement("style");
  styleReset.textContent = `
    * { all: initial; box-sizing: border-box; }
    *:before, *:after { all: initial; box-sizing: border-box; }
    style { display: none !important; }
    ${CSS_VARIABLES}
  `;
  shadow.appendChild(styleReset);

  const el = document.createElement("div");
  Object.assign(el.style, {
    all: "initial",
    background: "var(--lk-bg)",
    color: "var(--lk-fg)",
    borderRadius: "12px",
    padding: "20px 24px",
    minWidth: "320px",
    maxWidth: "min(480px, 90vw)",
    boxShadow: "var(--lk-shadow)",
    fontFamily: "system-ui,sans-serif",
    fontSize: "14px",
    lineHeight: "1.5",
    boxSizing: "border-box",
    display: "block",
    position: "relative",
  });
  shadow.appendChild(el);

  // Reset styles inside shadow
  const globalStyle = document.createElement("style");
  globalStyle.textContent = `
    * { font-family: system-ui, sans-serif; box-sizing: border-box; }
    div, span, button, a { all: revert; }
    button { cursor: pointer; }
  `;
  el.appendChild(globalStyle);

  // Header
  const header = document.createElement("div");
  Object.assign(header.style, {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "16px",
  });
  const titleSpan = document.createElement("span");
  Object.assign(titleSpan.style, { fontWeight: "700", fontSize: "16px" });
  titleSpan.textContent = "\uD83D\uDD16 Lianki";
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "\u00D7";
  closeBtn.setAttribute(
    "style",
    `${btn("transparent")};color:var(--lk-muted);font-size:20px;padding:0 6px;line-height:1`,
  );
  header.appendChild(titleSpan);
  header.appendChild(closeBtn);
  el.appendChild(header);

  // Phase content
  if (args.phase === "adding") {
    const styleEl = document.createElement("style");
    styleEl.textContent =
      "@keyframes lk-spin{to{transform:rotate(360deg)}}" +
      ".lk-spinner{display:inline-block;width:20px;height:20px;" +
      "border:3px solid #555;border-top-color:#7eb8f7;border-radius:50%;" +
      "animation:lk-spin 0.8s linear infinite;vertical-align:middle;margin-right:8px}";
    el.appendChild(styleEl);
    const wrap = document.createElement("div");
    Object.assign(wrap.style, { display: "flex", flexDirection: "column", gap: "10px" });
    const spinRow = document.createElement("div");
    Object.assign(spinRow.style, { fontSize: "15px", fontWeight: "600" });
    const spinner = document.createElement("span");
    spinner.className = "lk-spinner";
    spinRow.appendChild(spinner);
    spinRow.appendChild(document.createTextNode("Adding note\u2026"));
    const urlDiv = document.createElement("div");
    Object.assign(urlDiv.style, {
      color: "var(--lk-muted)",
      fontSize: "12px",
      wordBreak: "break-all",
    });
    urlDiv.textContent = args.currentUrl;
    wrap.appendChild(spinRow);
    wrap.appendChild(urlDiv);
    el.appendChild(wrap);
  } else if (args.phase === "error") {
    const errDiv = document.createElement("div");
    errDiv.style.color = "var(--lk-error)";
    errDiv.textContent = `Error: ${args.errorMessage}`;
    el.appendChild(errDiv);
    const btnRow = document.createElement("div");
    Object.assign(btnRow.style, {
      display: "flex",
      gap: "8px",
      marginTop: "10px",
      flexWrap: "wrap",
    });
    const loginBtn = document.createElement("button");
    loginBtn.setAttribute("style", btn("#2a5f8f"));
    loginBtn.textContent = "Login to Lianki";
    btnRow.appendChild(loginBtn);
    const tokenBtn = document.createElement("button");
    tokenBtn.setAttribute("style", btn("#3a6f3f"));
    tokenBtn.textContent = "Set API Token";
    btnRow.appendChild(tokenBtn);
    const copyBtn = document.createElement("button");
    copyBtn.setAttribute("style", btn("#444"));
    copyBtn.textContent = "Copy error";
    btnRow.appendChild(copyBtn);
    el.appendChild(btnRow);
    if (args.errorDetails) {
      const details = document.createElement("pre");
      Object.assign(details.style, {
        marginTop: "10px",
        fontSize: "11px",
        color: "var(--lk-muted)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
      });
      details.textContent = args.errorDetails;
      el.appendChild(details);
    }
  } else if (args.phase === "reviewing") {
    const titleDiv = document.createElement("div");
    Object.assign(titleDiv.style, {
      marginBottom: "12px",
      wordBreak: "break-all",
      fontSize: "13px",
      opacity: ".8",
    });
    const bold = document.createElement("b");
    bold.textContent = args.pageTitle || args.currentUrl;
    titleDiv.appendChild(bold);
    el.appendChild(titleDiv);

    const btnRow = document.createElement("div");
    Object.assign(btnRow.style, {
      display: "flex",
      gap: "8px",
      flexWrap: "wrap",
      marginBottom: "8px",
    });
    for (const o of args.options) {
      const b = document.createElement("button");
      b.setAttribute("style", btn("#2a5f8f"));
      b.appendChild(document.createTextNode(o.label));
      b.appendChild(document.createElement("br"));
      const small = document.createElement("small");
      Object.assign(small.style, { color: "rgba(255,255,255,0.9)", fontSize: "11px" });
      small.textContent = o.due;
      b.appendChild(small);
      btnRow.appendChild(b);
    }
    el.appendChild(btnRow);

    const deleteBtn = document.createElement("button");
    deleteBtn.setAttribute("style", btn("#7a2a2a"));
    deleteBtn.textContent = "Delete";
    el.appendChild(deleteBtn);

    const hints = document.createElement("div");
    Object.assign(hints.style, { marginTop: "14px", opacity: ".6", fontSize: "11px" });
    hints.textContent =
      "A/H=Easy \u00B7 S/J=Good \u00B7 W/K=Hard \u00B7 D/L=Again \u00B7 T/M=Delete \u00B7 Esc=Close";
    el.appendChild(hints);

    const notesRow = document.createElement("div");
    Object.assign(notesRow.style, { marginTop: "10px", position: "relative" });
    const notesInput = document.createElement("input");
    notesInput.type = "text";
    notesInput.maxLength = 128;
    notesInput.placeholder = "Notes\u2026";
    notesInput.value = args.notes;
    Object.assign(notesInput.style, {
      width: "100%",
      boxSizing: "border-box",
      background: "var(--lk-input-bg)",
      color: "var(--lk-input-fg)",
      border: "1px solid var(--lk-input-border)",
      borderRadius: "6px",
      padding: "6px 28px 6px 8px",
      fontSize: "12px",
      outline: "none",
    });
    const syncIndicator = document.createElement("span");
    Object.assign(syncIndicator.style, {
      position: "absolute",
      right: "8px",
      top: "50%",
      transform: "translateY(-50%)",
      fontSize: "13px",
      opacity: ".7",
      pointerEvents: "none",
    });
    syncIndicator.textContent = args.notesSynced ? "\u2713" : "\u22EF";
    notesRow.appendChild(notesInput);
    notesRow.appendChild(syncIndicator);
    el.appendChild(notesRow);
  } else if (args.phase === "reviewed") {
    const msgDiv = document.createElement("div");
    Object.assign(msgDiv.style, { color: "var(--lk-success)", fontSize: "15px" });
    msgDiv.textContent = args.reviewedMessage;
    el.appendChild(msgDiv);
  }

  // Offline indicator
  if (args.showOfflineIndicator) {
    const indicator = document.createElement("div");
    Object.assign(indicator.style, {
      position: "absolute",
      top: "8px",
      right: "8px",
      fontSize: "11px",
      opacity: "0.6",
      display: "flex",
      alignItems: "center",
      gap: "4px",
    });
    if (args.offlineStatus === "offline") indicator.textContent = "\uD83D\uDCF4 Offline";
    else if (args.offlineStatus === "syncing") indicator.textContent = "\uD83D\uDD04 Syncing...";
    else if (args.offlineStatus === "queued") indicator.textContent = `\u23F3 ${args.queueLength}`;
    else indicator.textContent = "\u2713";
    el.appendChild(indicator);
  }

  return shadowHost;
}

// ── Storybook meta ─────────────────────────────────────────────────────────

const meta: Meta<ModalArgs> = {
  title: "Lianki/Popup Modal",
  render: (args) => {
    const wrapper = document.createElement("div");
    Object.assign(wrapper.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      minHeight: "100vh",
      minWidth: "100vw",
      background: "#f0f0f0",
    });
    wrapper.appendChild(buildModal(args));
    return wrapper;
  },
  argTypes: {
    phase: {
      control: "select",
      options: ["adding", "reviewing", "error", "reviewed"],
      description: "Current phase of the modal",
    },
    currentUrl: { control: "text", description: "Current page URL" },
    pageTitle: { control: "text", description: "Current page title" },
    notes: { control: "text", description: "Note content" },
    notesSynced: { control: "boolean", description: "Whether notes are synced" },
    errorMessage: { control: "text", description: "Error message text" },
    errorDetails: { control: "text", description: "Detailed error response body" },
    reviewedMessage: { control: "text", description: "Success message after review" },
    showOfflineIndicator: { control: "boolean", description: "Show offline status indicator" },
    offlineStatus: {
      control: "select",
      options: ["offline", "syncing", "queued", "ready"],
      description: "Offline indicator state",
    },
    queueLength: { control: "number", description: "Number of queued offline actions" },
  },
};

export default meta;
type Story = StoryObj<ModalArgs>;

// ── Default review options used across stories ─────────────────────────────

const DEFAULT_OPTIONS: ReviewOption[] = [
  { label: "Again", due: "now", rating: 1 },
  { label: "Hard", due: "10m", rating: 2 },
  { label: "Good", due: "1d", rating: 3 },
  { label: "Easy", due: "4d", rating: 4 },
];

// ── Stories ────────────────────────────────────────────────────────────────

export const Adding: Story = {
  args: {
    phase: "adding",
    currentUrl: "https://example.com/article/spaced-repetition-guide",
    pageTitle: "Spaced Repetition: A Complete Guide",
    notes: "",
    notesSynced: true,
    errorMessage: "",
    errorDetails: "",
    reviewedMessage: "",
    options: DEFAULT_OPTIONS,
    showOfflineIndicator: false,
    offlineStatus: "ready",
    queueLength: 0,
  },
};

export const Reviewing: Story = {
  args: {
    ...Adding.args,
    phase: "reviewing",
    options: DEFAULT_OPTIONS,
  },
};

export const ReviewingWithNotes: Story = {
  name: "Reviewing — with notes",
  args: {
    ...Reviewing.args,
    notes: "Key insight: active recall beats passive re-reading",
    notesSynced: true,
  },
};

export const ReviewingNotesSyncing: Story = {
  name: "Reviewing — notes syncing",
  args: {
    ...ReviewingWithNotes.args,
    notesSynced: false,
  },
};

export const ReviewingLongTitle: Story = {
  name: "Reviewing — long page title",
  args: {
    ...Reviewing.args,
    pageTitle:
      "The Complete Beginner's Guide to Anki and Spaced Repetition Systems for Language Learning and Medical Studies 2024",
  },
};

export const Error: Story = {
  args: {
    ...Adding.args,
    phase: "error",
    errorMessage: "Not authenticated",
    errorDetails: "",
  },
};

export const ErrorWithDetails: Story = {
  name: "Error — with response details",
  args: {
    ...Error.args,
    errorMessage: "Internal server error",
    errorDetails: '{"status":500,"message":"MongoDB connection failed","code":"DB_CONN_ERROR"}',
  },
};

export const Reviewed: Story = {
  args: {
    ...Adding.args,
    phase: "reviewed",
    reviewedMessage: "\u2713 Good \u2014 see you in 1 day",
  },
};

export const ReviewedEasy: Story = {
  name: "Reviewed — Easy",
  args: {
    ...Reviewed.args,
    reviewedMessage: "\u2713 Easy \u2014 see you in 4 days",
  },
};

export const ReviewingOffline: Story = {
  name: "Reviewing — offline mode",
  args: {
    ...Reviewing.args,
    showOfflineIndicator: true,
    offlineStatus: "offline",
  },
};

export const ReviewingSyncing: Story = {
  name: "Reviewing — syncing queue",
  args: {
    ...Reviewing.args,
    showOfflineIndicator: true,
    offlineStatus: "syncing",
  },
};

export const ReviewingQueued: Story = {
  name: "Reviewing — 3 items queued",
  args: {
    ...Reviewing.args,
    showOfflineIndicator: true,
    offlineStatus: "queued",
    queueLength: 3,
  },
};
