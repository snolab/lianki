/** A server on this machine: localhost or 127.0.0.1, any port. Invite mail from it is a stub. */
export const isLocalOrigin = (o: string) =>
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(o);
