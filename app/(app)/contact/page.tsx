import { permanentRedirect } from "next/navigation";

// The contact form lives at /contacts; old links keep working.
export default function ContactRedirect() {
  permanentRedirect("/contacts");
}
