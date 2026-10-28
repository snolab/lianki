import { describe, expect, test } from "bun:test";
import { mailLocale, signInMail } from "@/lib/sign-in-mail";

describe("sign-in mail", () => {
  test("language follows the app locale header, then Accept-Language", () => {
    expect(mailLocale({ headers: new Headers({ "x-lianki-lang": "zh" }) })).toBe("zh");
    expect(mailLocale({ headers: new Headers({ "accept-language": "zh-CN,zh;q=0.9" }) })).toBe(
      "zh",
    );
    expect(mailLocale({ headers: new Headers({ "accept-language": "ja,en;q=0.8" }) })).toBe("en");
    expect(mailLocale(undefined)).toBe("en");
  });

  test("Chinese readers get Chinese only, others English only", () => {
    const zh = signInMail("zh", { otp: "123456" });
    expect(zh.subject).toContain("123456");
    expect(zh.text).toContain("验证码");
    expect(zh.text).not.toContain("sign-in code");
    const en = signInMail("en", { url: "https://lianki.com/x" });
    expect(en.text).toContain("https://lianki.com/x");
    expect(en.text).not.toMatch(/[一-鿿]/);
  });

  test("every variant renders: code and link, both languages", () => {
    expect(signInMail("en", { otp: "654321" }).subject).toBe("654321 is your Lianki sign-in code");
    const zhLink = signInMail("zh", { url: "https://lianki.com/y" });
    expect(zhLink.subject).toBe("登录炼記");
    expect(zhLink.html).toContain('href="https://lianki.com/y"');
  });
});
