import { Link } from "react-router-dom";
import { posts } from "../lib/blog";

export function BlogListPage() {
  return (
    <section>
      <h1>Blog</h1>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {posts.map((p) => (
          <li key={p.slug} style={{ marginBottom: "1.25rem" }}>
            <Link to={`/blog/${p.slug}`} style={{ fontSize: "1.1rem", fontWeight: 600 }}>
              {p.title}
            </Link>
            <div style={{ color: "#888", fontSize: "0.9rem" }}>{p.date}</div>
            {p.summary ? <p style={{ margin: "0.25rem 0 0" }}>{p.summary}</p> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
