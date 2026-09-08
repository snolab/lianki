/**
 * Transactional email over Resend's HTTP API.
 *
 * Not SMTP: this app is moving to Cloudflare Workers, where nodemailer cannot
 * run — there is no usable raw-TCP path for it under workerd. Magic-link
 * sign-in is the primary production auth method, so an SMTP transport would
 * have failed at exactly the moment of the cutover, and only for the auth
 * method that is not OAuth (i.e. the one CI never exercises).
 *
 * Plain `fetch` rather than the `resend` SDK: it is one POST, and a dependency
 * cannot be more portable than the platform primitive.
 */

const ENDPOINT = "https://api.resend.com/emails";

export const RESEND_NOT_CONFIGURED = "Email is not configured: set RESEND_API_KEY and EMAIL_FROM";

export const isEmailConfigured = () =>
  Boolean(process.env.RESEND_API_KEY?.trim() && process.env.EMAIL_FROM?.trim());

export type SendEmailInput = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

/**
 * Send one email. Throws on failure — better-auth turns a rejection into a
 * visible error, whereas swallowing it would tell the user their magic link is
 * on the way when nothing was ever sent.
 */
export async function sendEmail(input: SendEmailInput): Promise<{ id: string }> {
  if (!isEmailConfigured()) throw new Error(RESEND_NOT_CONFIGURED);

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY!.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM!.trim(),
      to: [input.to],
      subject: input.subject,
      text: input.text,
      ...(input.html ? { html: input.html } : {}),
    }),
  });

  const body = await res.text();

  if (!res.ok) {
    // Resend answers with {"name","message"}; the message is the difference
    // between "500" and "the from-domain is not verified".
    let detail = body.slice(0, 500);
    try {
      const parsed = JSON.parse(body) as { message?: string; name?: string };
      if (parsed.message) detail = `${parsed.name ?? "error"}: ${parsed.message}`;
    } catch {}
    throw new Error(`Resend rejected the message (HTTP ${res.status}) ${detail}`);
  }

  try {
    const parsed = JSON.parse(body) as { id?: string };
    return { id: parsed.id ?? "" };
  } catch {
    // A 2xx that is not JSON still means it was accepted; do not fail the login.
    return { id: "" };
  }
}
