import { Link } from "react-router-dom";
import { useIntlayer } from "react-intlayer";

export function HomePage() {
  const content = useIntlayer("home");
  return (
    <section>
      <h1>{content.title}</h1>
      <p>{content.tagline}</p>
      <p>
        <Link to="/review">Start reviewing →</Link>
      </p>
    </section>
  );
}
