"use client";

import { useState } from "react";

type ContactFormContent = {
  title: string;
  nameLabel: string;
  namePlaceholder: string;
  emailLabel: string;
  emailPlaceholder: string;
  phoneLabel: string;
  phonePlaceholder: string;
  messageLabel: string;
  messagePlaceholder: string;
  optional: string;
  template1: string;
  template2: string;
  template3: string;
  sendButton: string;
  sending: string;
  successMessage: string;
  errorMessage: string;
};

export default function ContactForm({ content }: { content: ContactFormContent }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("loading");
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, phone, message }),
      });
      if (!res.ok) throw new Error("Failed");
      setStatus("success");
      setName("");
      setEmail("");
      setPhone("");
      setMessage("");
    } catch {
      setStatus("error");
    }
  }

  const templates = [content.template1, content.template2, content.template3];

  return (
    <section className="py-12 px-4 sm:px-6 lg:px-8 bg-gray-100 dark:bg-gray-900">
      <div className="max-w-xl mx-auto">
        <h3 className="text-3xl font-bold text-center mb-8">{content.title}</h3>
        {status === "success" ? (
          <p className="text-center text-green-600 dark:text-green-400 font-medium">
            {content.successMessage}
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="contact-name">
                {content.nameLabel} <span className="text-red-500">*</span>
              </label>
              <input
                id="contact-name"
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder={content.namePlaceholder}
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="contact-email">
                {content.emailLabel} <span className="text-red-500">*</span>
              </label>
              <input
                id="contact-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder={content.emailPlaceholder}
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="contact-phone">
                {content.phoneLabel} <span className="text-gray-400">{content.optional}</span>
              </label>
              <input
                id="contact-phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder={content.phonePlaceholder}
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="contact-message">
                {content.messageLabel} <span className="text-gray-400">{content.optional}</span>
              </label>
              <div className="flex flex-wrap gap-2 mb-2">
                {templates.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setMessage(t)}
                    className="text-xs border border-blue-400 text-blue-600 dark:text-blue-400 rounded-full px-3 py-1 hover:bg-blue-50 dark:hover:bg-blue-900 transition-colors"
                  >
                    {t}
                  </button>
                ))}
              </div>
              <textarea
                id="contact-message"
                rows={4}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                className="w-full border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder={content.messagePlaceholder}
              />
            </div>

            {status === "error" && <p className="text-red-500 text-sm">{content.errorMessage}</p>}

            <button
              type="submit"
              disabled={status === "loading"}
              className="bg-blue-600 text-white font-bold py-3 px-6 rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors"
            >
              {status === "loading" ? content.sending : content.sendButton}
            </button>
          </form>
        )}
      </div>
    </section>
  );
}
