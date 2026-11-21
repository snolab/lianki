"use client";

import { DevSwitchItem, type DevSwitch } from "./DevSwitchItem";
import { LiveViewChip, type LiveViewShell } from "./LiveView";

/** What the server hands an account menu for its preview row: both absent for anyone without `dev`. */
export type PreviewMenu = { devSwitch?: DevSwitch; liveView?: LiveViewShell };

/**
 * One preview control: the whole-page switch, with Live view (dev parts on
 * lianki.com) as a chip in the same row, only on lianki.com: the preview
 * build is all dev code already. Shared by the app's account menu
 * (ProfileMenu) and the landing/blog header (Header). Renders nothing unless
 * the server decided this account gets it (devSwitchFor / liveViewFor).
 */
export function PreviewMenuItem({ devSwitch, liveView }: PreviewMenu) {
  if (!devSwitch) return null;
  return (
    <DevSwitchItem sw={devSwitch}>
      {liveView && devSwitch.mode === "go" && (liveView.wanted || liveView.ready) && (
        <LiveViewChip lv={liveView} />
      )}
    </DevSwitchItem>
  );
}
