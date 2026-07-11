import { useState } from "react";
import { api } from "../lib/api";

// Contact form → POST /api/contact (relays to a Slack webhook on the Worker).
export function ContactPage() {
  const [form, setForm] = useState({ name: "", email: "", phone: "", message: "" });
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function set(k: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setStatus(null);
    try {
      await api("/api/contact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      setStatus("Thanks — your message was sent.");
      setForm({ name: "", email: "", phone: "", message: "" });
    } catch (e) {
      setStatus(`Failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h1>Contact</h1>
      <form
        onSubmit={submit}
        style={{ display: "flex", flexDirection: "column", gap: "0.75rem", maxWidth: 480 }}
      >
        <input placeholder="Name" required value={form.name} onChange={set("name")} />
        <input
          type="email"
          placeholder="Email"
          required
          value={form.email}
          onChange={set("email")}
        />
        <input placeholder="Phone (optional)" value={form.phone} onChange={set("phone")} />
        <textarea placeholder="Message" rows={4} value={form.message} onChange={set("message")} />
        <button type="submit" disabled={busy} style={{ alignSelf: "flex-start" }}>
          {busy ? "Sending…" : "Send"}
        </button>
      </form>
      {status ? <p role="status">{status}</p> : null}
    </section>
  );
}
