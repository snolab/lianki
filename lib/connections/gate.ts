import { flagIn, type FlagValues } from "@/lib/flags";

/**
 * Who gets Google connections (docs/connections.md): everyone signed in when
 * `connections.google` is on, else the owner only (the flag ships off).
 */
export function connectionsOn(flags: FlagValues | null | undefined, owner: boolean): boolean {
  return owner || flagIn(flags, "connections.google");
}
