"use client";
/**
 * A user's avatar: their picture, or, when there is none or it fails to load
 * (a provider URL that expired, an account with no picture), a text avatar of
 * their initial on a colour of their own. Never a broken-image icon. A plain
 * <img>: any provider's host, our own /api/avatar route, a blob: preview.
 */
import { useState } from "react";
import { avatarHue, avatarInitial } from "@/lib/profile/initials";

export function UserAvatar({
  name,
  image,
  size,
  className = "",
  testId,
}: {
  name: string;
  image: string | null | undefined;
  /** Pixels: the picture's box and the initial's font size. */
  size: number;
  className?: string;
  testId?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  if (image && failed !== image) {
    return (
      <img
        src={image}
        alt={name}
        width={size}
        height={size}
        className={`rounded-full object-cover ${className}`}
        data-testid={testId}
        onError={() => setFailed(image)}
      />
    );
  }
  const hue = avatarHue(name);
  return (
    <span
      role="img"
      aria-label={name}
      data-testid={testId}
      data-avatar="initial"
      className={`inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold ${className}`}
      style={{
        fontSize: Math.round(size * 0.45),
        background: `oklch(0.62 0.13 ${hue})`,
        color: "oklch(0.99 0 0)",
      }}
    >
      {avatarInitial(name)}
    </span>
  );
}
