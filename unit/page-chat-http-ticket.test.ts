import { describe, test, expect } from "bun:test";
import { signPageChatHttpTicket, verifyPageChatHttpTicket } from "../lib/page-chat-http-ticket";
describe("private chat HTTP capability", () => {
  test("binds account, site and exact operation without a reusable token", async () => {
    const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const action = { op: "send" as const, id: "message_1", text: "Hello" };
    const ticket = await signPageChatHttpTicket(
      keys.privateKey,
      { sub: "account_a", ho: "https://example.com", th: "A".repeat(22) },
      action,
      100000,
    );
    const result = await verifyPageChatHttpTicket(ticket, keys.publicKey, action, 100001);
    expect(result?.sub).toBe("account_a");
    expect(result?.exp).toBe(160);
    expect(
      await verifyPageChatHttpTicket(
        ticket,
        keys.publicKey,
        { ...action, text: "changed" },
        100001,
      ),
    ).toBeNull();
    expect(
      await verifyPageChatHttpTicket(ticket, keys.publicKey, { op: "read", wait: false }, 100001),
    ).toBeNull();
    expect(await verifyPageChatHttpTicket(ticket, keys.publicKey, action, 161000)).toBeNull();
    expect(await verifyPageChatHttpTicket(ticket + "x", keys.publicKey, action, 100001)).toBeNull();
  });
});
