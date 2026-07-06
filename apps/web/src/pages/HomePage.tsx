import { Link } from "react-router-dom";

export function HomePage() {
  return (
    <section>
      <h1>Lianki</h1>
      <p>
        Spaced-repetition for the things you read and watch. This is the standalone Vite + React SPA
        (the <code>apps/web</code> shell) that will replace the Next.js frontend as part of the
        Cloudflare-native migration.
      </p>
      <p>
        <Link to="/due">See what's due →</Link>
      </p>
    </section>
  );
}
