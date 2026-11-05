"use client";

import { signOut } from "@/lib/sign-out";

/** The /auth/logout page's button: the same sign-out as the menu (lib/sign-out.ts). */
export function SignOutButton() {
  return (
    <button
      type="button"
      data-sign-out
      onClick={(e) => {
        e.currentTarget.disabled = true;
        void signOut();
      }}
      className="px-4 py-2 rounded border text-red-600 dark:text-red-400 disabled:opacity-60"
    >
      logout
    </button>
  );
}
