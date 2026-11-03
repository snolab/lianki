/**
 * A host page for scripts/dev/live-view-qa.ts: the real LiveViewBoot (it
 * verifies the pointer with the browser's WebCrypto) and the account menu's
 * LiveViewChip (in a stand-in Preview build row), under a stand-in top bar. The QA script injects the pointer
 * and the test public key; nothing here talks to lianki.com.
 */
import { createRoot } from "react-dom/client";
import { LiveViewBoot, LiveViewChip, type LiveViewShell } from "@/app/components/LiveView";

const w = window as unknown as { __LV: LiveViewShell };
const lv = w.__LV;

function Page() {
  return (
    <div className="min-h-screen flex flex-col">
      <LiveViewBoot lv={lv} />
      <header className="flex items-center gap-3 px-4 h-14 border-b border-[oklch(0.85_0_0)] dark:border-[oklch(0.35_0_0)]">
        <b className="text-xl">Lianki</b>
        <span className="ms-auto text-sm">Owner ▾</span>
      </header>
      <div className="relative">
        <div
          data-menu
          className="absolute end-4 mt-2 w-64 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-2"
        >
          <div className="px-4 py-2 text-sm text-gray-500 border-b border-gray-200 dark:border-gray-700">
            owner@example.com
          </div>
          <div className="px-4 py-2 text-sm">Dashboard</div>
          <div className="px-4 py-2 text-sm">Profile</div>
          <div data-preview-row>
            <div className="flex items-center gap-3 px-4 py-2 text-sm">
              <span className="flex-1">Preview build</span>
              <span className="w-9 h-5 rounded-full bg-gray-300 dark:bg-gray-600" />
            </div>
            <div className="px-4 pb-2 -mt-0.5">
              <LiveViewChip lv={lv} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
