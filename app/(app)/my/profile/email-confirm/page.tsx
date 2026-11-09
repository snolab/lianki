import { EmailConfirm } from "./EmailConfirm";

/**
 * Where the link in a change-of-address mail lands. The token is in the URL's
 * fragment, and applying it takes a press on the page: a mail scanner that opens
 * the link changes nothing.
 */
export default function EmailConfirmPage() {
  return <EmailConfirm />;
}
