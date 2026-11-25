"use client";

import { useEffect, useState } from "react";
import {
  observeUserscriptInstall,
  USERSCRIPT_INSTALL_URL,
  USERSCRIPT_TRY_URL,
  type UserscriptInstallState,
} from "@/lib/userscript-install";

export type PillInstallLabels = {
  title: string;
  checking: string;
  missing: string;
  outdated: string;
  ready: string;
  install: string;
  update: string;
  installHelp: string;
  reload: string;
  trySite: string;
  tryHelp: string;
  versions: string;
};

export default function PillInstallGuide({
  latestVersion,
  labels,
}: {
  latestVersion: string;
  labels: PillInstallLabels;
}) {
  const [state, setState] = useState<UserscriptInstallState>({ status: "checking", version: null });
  useEffect(() => observeUserscriptInstall(document, latestVersion, setState), [latestVersion]);
  const ready = state.status === "ready";
  const checking = state.status === "checking";
  return (
    <section
      aria-labelledby="pill-install-title"
      data-testid="pill-install-guide"
      data-install-status={state.status}
      className="mb-6 rounded-xl border border-current/20 p-4"
    >
      <h2 id="pill-install-title" className="font-semibold">
        {labels.title}
      </h2>
      <p role="status" className="mt-2 text-sm">
        {labels[state.status]}
      </p>
      {state.version && (
        <p className="mt-1 text-xs opacity-75">
          {labels.versions.replace("{installed}", state.version).replace("{latest}", latestVersion)}
        </p>
      )}
      {!checking && (
        <>
          <p className="mt-2 text-sm">{ready ? labels.tryHelp : labels.installHelp}</p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <a
              href={ready ? USERSCRIPT_TRY_URL : USERSCRIPT_INSTALL_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="tap-40 inline-flex items-center rounded-full bg-primary px-4 py-2 text-sm font-semibold text-on-primary"
              data-testid={ready ? "pill-try-site" : "pill-install-link"}
            >
              {ready ? labels.trySite : state.status === "missing" ? labels.install : labels.update}
            </a>
            {!ready && (
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="tap-40 rounded-full border border-current/25 px-4 py-2 text-sm"
              >
                {labels.reload}
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
