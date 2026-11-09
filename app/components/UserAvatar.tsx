"use client";
/**
 * A user's avatar: their picture, or, when there is none or it fails to load
 * (a provider URL that expired, an account with no picture), a text avatar of
 * their initial on a colour of their own. Never a broken-image icon.
 */
import Image from "next/image";
import { useState } from "react";
import { isOwnAvatar } from "@/lib/profile/avatar";
import { avatarHue, avatarInitial } from "@/lib/profile/initials";

export function UserAvatar({
  name,
  image,
  size,
  className = "",
  plain = false,
  testId,
}: {
  name: string;
  image: string | null | undefined;
  /** Pixels, for next/image and the initial's font size. */
  size: number;
  className?: string;
  /** A plain <img> (any provider's host, our own route) instead of next/image. */
  plain?: boolean;
  testId?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  if (image && failed !== image) {
    const onError = () => setFailed(image);
    return plain ? (
      <img
        src={image}
        alt={name}
        className={`rounded-full object-cover ${className}`}
        data-testid={testId}
        onError={onError}
      />
    ) : (
      <Image
        className={`rounded-full ${className}`}
        alt={name}
        src={image}
        // An upload of ours is already small, and next/image's loader can't fetch /api/*.
        unoptimized={isOwnAvatar(image) || image.startsWith("blob:")}
        width={size}
        height={size}
        data-testid={testId}
        onError={onError}
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
