"use client";

import { useEffect } from "react";

/**
 * Rendered by the app layout only for a signed-in user still carrying an
 * invite cookie from /i/CODE: claims it once. The route clears the cookie, so
 * this does not come back on the next page.
 */
export function InviteClaim() {
  useEffect(() => {
    fetch("/api/invite", { method: "POST" }).catch(() => {});
  }, []);
  return null;
}
