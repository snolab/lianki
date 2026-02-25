"use client";

import Image from "next/image";
import Link from "next/link";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { useState } from "react";

interface HeaderProps {
  locale: string;
  appName: string;
  blogLabel: string;
  learnLabel: string;
  user?: {
    name: string;
    email: string;
    image?: string;
  } | null;
}

export function Header({ locale, appName, blogLabel, learnLabel, user }: HeaderProps) {
  const [isProfileOpen, setIsProfileOpen] = useState(false);

  return (
    <header className="py-4 px-4 sm:px-6 lg:px-8 border-b border-gray-200 dark:border-gray-800">
      <div className="flex items-center justify-between max-w-7xl mx-auto">
        {/* Site Logo */}
        <Link href={`/${locale}`} className="text-2xl font-bold hover:opacity-80 transition-opacity">
          {appName}
        </Link>

        {/* Navigation */}
        <nav className="flex items-center gap-4 md:gap-6">
          {/* Learn Button */}
          <Link
            href={`/${locale}/learn`}
            className="text-base md:text-lg font-medium hover:underline"
          >
            {learnLabel}
          </Link>

          {/* Blog Button */}
          <Link
            href={`/${locale}/blog`}
            className="text-base md:text-lg font-medium hover:underline"
          >
            {blogLabel}
          </Link>

          {/* Language Switcher */}
          <LanguageSwitcher />

          {/* Profile Dropdown */}
          {user ? (
            <div className="relative">
              <button
                onClick={() => setIsProfileOpen(!isProfileOpen)}
                onBlur={() => setTimeout(() => setIsProfileOpen(false), 150)}
                className="flex items-center gap-2 text-lg font-medium hover:opacity-80 transition-opacity"
              >
                {user.image && (
                  <Image
                    className="w-8 h-8 rounded-full ring-2 ring-gray-200 dark:ring-gray-700"
                    alt={user.name}
                    src={user.image}
                    width={32}
                    height={32}
                  />
                )}
                {/* Show username on desktop, hide on mobile */}
                <span className="hidden md:inline">{user.name}</span>
                {/* Dropdown arrow */}
                <svg
                  className={`w-4 h-4 transition-transform ${isProfileOpen ? "rotate-180" : ""}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
              </button>

              {/* Dropdown Menu */}
              {isProfileOpen && (
                <div className="absolute right-0 mt-2 w-56 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-2 z-50">
                  <div className="px-4 py-2 text-sm text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                    {user.email}
                  </div>
                  <Link
                    href={`/${locale}/list`}
                    className="block px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700"
                  >
                    Dashboard
                  </Link>
                  <Link
                    href={`/${locale}/profile`}
                    className="block px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700"
                  >
                    Profile
                  </Link>
                  <Link
                    href={`/${locale}/preferences`}
                    className="block px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700"
                  >
                    Preferences
                  </Link>
                  <Link
                    href={`/${locale}/membership`}
                    className="block px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700"
                  >
                    Membership
                  </Link>
                  <div className="border-t border-gray-200 dark:border-gray-700 mt-2 pt-2">
                    <Link
                      href="/auth/logout"
                      className="block px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                    >
                      Sign out
                    </Link>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <Link
              href={`/${locale}/sign-in`}
              className="text-base md:text-lg font-medium hover:underline"
            >
              Sign in
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
