import Link from "next/link";
import { Icon, type IconName } from "@/app/components/icons";
import { HOME_FEATURE_SHOT } from "@/lib/home-features";

export type FeatureShot = { light: string; dark: string; alt: string };

/**
 * One card under Explore on /home: the feature's name and a one-line
 * explanation, over a faint screenshot of the feature (light or dark, as the
 * page) behind a scrim in the page's own colour. The card's height comes
 * from its text and the screenshot is absolutely placed, so it loading (or not) never moves
 * anything. Without a shot the card is the same minus the picture.
 */
export function FeatureCard({
  href,
  icon,
  label,
  desc,
  shot,
  featureKey,
}: {
  href: string;
  icon: IconName;
  label: string;
  desc: string;
  shot: FeatureShot | null;
  featureKey: string;
}) {
  return (
    <Link href={href} data-feature={featureKey} className="lk-feature-card group">
      {shot && (
        <picture>
          <source media="(prefers-color-scheme: dark)" srcSet={shot.dark} />
          <img
            src={shot.light}
            alt={shot.alt}
            width={HOME_FEATURE_SHOT.width}
            height={HOME_FEATURE_SHOT.height}
            loading="lazy"
            decoding="async"
            className="lk-feature-shot"
          />
        </picture>
      )}
      <span className="flex items-center gap-2 font-medium">
        <Icon name={icon} className="text-lg opacity-80" />
        {label}
      </span>
      <span className="text-xs leading-snug opacity-80">{desc}</span>
    </Link>
  );
}
