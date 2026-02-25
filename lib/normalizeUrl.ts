/**
 * Normalize URLs for consistent storage in the database
 * - Converts youtu.be links to youtube.com/watch format
 * - Strips mobile subdomains (m.youtube.com → www.youtube.com)
 * - Removes tracking and session parameters
 */
export function normalizeUrl(href: string): string {
  try {
    const u = new URL(href);
    // YouTube: youtu.be/ID → youtube.com/watch?v=ID
    if (u.hostname === "youtu.be") {
      const id = u.pathname.slice(1);
      u.hostname = "www.youtube.com";
      u.pathname = "/watch";
      u.searchParams.set("v", id);
    }
    // Strip mobile subdomain (m.youtube.com → www.youtube.com)
    if (u.hostname.startsWith("m.")) u.hostname = "www." + u.hostname.slice(2);
    // Strip tracking & session params
    for (const p of [
      "si",
      "pp",
      "feature",
      "ref",
      "source",
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "fbclid",
      "gclid",
      "mc_cid",
      "mc_eid",
      "igshid",
    ])
      u.searchParams.delete(p);
    u.searchParams.sort();
    return u.toString();
  } catch {
    return href;
  }
}
