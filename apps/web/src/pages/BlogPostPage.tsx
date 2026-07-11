import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { marked } from "marked";
import { postBySlug } from "../lib/blog";

export function BlogPostPage() {
  const { slug } = useParams();
  const post = slug ? postBySlug(slug) : undefined;
  const html = useMemo(() => (post ? marked.parse(post.body, { async: false }) : ""), [post]);

  if (!post)
    return (
      <section>
        <p>
          Post not found. <Link to="/blog">← Blog</Link>
        </p>
      </section>
    );

  return (
    <article>
      <p style={{ margin: 0 }}>
        <Link to="/blog">← Blog</Link>
      </p>
      <div style={{ color: "#888", fontSize: "0.9rem", marginTop: "0.5rem" }}>{post.date}</div>
      {/* Blog markdown is trusted first-party content from the repo. */}
      <div dangerouslySetInnerHTML={{ __html: html as string }} />
    </article>
  );
}
