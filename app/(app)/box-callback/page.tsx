import { notFound } from "next/navigation";
import { boxConfig } from "@/lib/box-oauth/mode";
import BoxCallback from "./BoxCallback";

export const dynamic = "force-dynamic";

/** Where lianki.com returns a box's browser. Only a box has this page. */
export default function BoxCallbackPage() {
  const config = boxConfig();
  if (!config) notFound();
  return <BoxCallback config={config} />;
}
