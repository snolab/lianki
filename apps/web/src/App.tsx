import { Link, Outlet } from "react-router-dom";
import { useSession } from "./lib/useSession";

/** App shell: nav + routed outlet. Ported pages plug into <Outlet/>. */
export function App() {
  const { user, loading } = useSession();
  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: 720,
        margin: "2rem auto",
        padding: "0 1rem",
      }}
    >
      <header
        style={{ display: "flex", gap: "1rem", alignItems: "baseline", marginBottom: "1.5rem" }}
      >
        <Link to="/" style={{ fontWeight: 700, fontSize: "1.25rem", textDecoration: "none" }}>
          Lianki
        </Link>
        <nav style={{ display: "flex", gap: "0.75rem" }}>
          <Link to="/">Home</Link>
          <Link to="/add">Add</Link>
          <Link to="/review">Review</Link>
          <Link to="/due">Due</Link>
          <Link to="/data">Data</Link>
        </nav>
        <span style={{ marginLeft: "auto", fontSize: "0.9rem", color: "#666" }}>
          {loading ? "…" : user ? user.email : <a href="/api/auth/sign-in">Sign in</a>}
        </span>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
