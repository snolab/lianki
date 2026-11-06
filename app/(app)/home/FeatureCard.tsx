import Link from "next/link";
import { Icon, type IconName } from "@/app/components/icons";
import type { HomeFeatureKey } from "@/lib/home-features";
import { FeatureArt } from "./FeatureArt";

/**
 * One card under Explore on /home: the feature's name and a one-line
 * explanation, over a drawing of what it does (no words in it, so it suits
 * every locale). The text carries its own scrim in the page's colour, so it
 * stays readable however long the locale makes it. The card's height comes
 * from its text and the drawing is out of the flow.
 */
export function FeatureCard({
  href,
  icon,
  label,
  desc,
  featureKey,
}: {
  href: string;
  icon: IconName;
  label: string;
  desc: string;
  featureKey: HomeFeatureKey;
}) {
  return (
    <Link href={href} data-feature={featureKey} className="lk-feature-card group">
      <FeatureArt feature={featureKey} />
      <span className="lk-feature-text">
        <span className="flex items-center gap-2 font-medium">
          <Icon name={icon} className="text-lg opacity-80" />
          {label}
        </span>
        <span className="text-xs leading-snug opacity-80">{desc}</span>
      </span>
    </Link>
  );
}
