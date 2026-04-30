# Sign-In UX Comparison & Redesign Plan

_Research date: 2026-04-30_

---

## Current State (Lianki `sno-auth` branch)

`app/[locale]/sign-in/SignInClient.tsx` has three auth sections stacked vertically:

```
┌─────────────────────────────┐
│  [GitHub]                   │
│  [Google]                   │
│  ─── Or ────                │
│  Tabs: [Sign In] [Sign Up]  │
│  email: [......]            │  ← email field #1
│  password: [......]         │
│  [Sign In / Sign Up]        │
│  ─── Or use magic link ───  │
│  email: [......]            │  ← email field #2 (duplicate!)
│  [Turnstile CAPTCHA]        │
│  [Send Sign-In Link]        │
└─────────────────────────────┘
```

**Problems:**
- Duplicate email input (sign-in form + magic link form)
- Three auth paradigms presented simultaneously → decision paralysis
- Sign In / Sign Up tab adds unnecessary branching; users don't think in those terms
- Turnstile widget visible even before user interacts → visual noise
- No `autocomplete` attributes on inputs → breaks password managers
- No `<label>` elements → accessibility failure

---

## How Modern Apps Approach This

### Linear / Vercel / Clerk pattern — Email-First Progressive Disclosure

```
Step 1:   [email]  [Continue]
           └─ backend lookup ─┐
Step 2a (known, has passkey): [Face/Touch unlock]
Step 2b (known, has OAuth):   [Continue with Google]
Step 2c (known, password):    [password field]
Step 2d (unknown):            create account flow
```

One field. One decision. No tabs. Auth method is revealed **after** the email is known.

### Notion — Social-first, single CTA

```
[Continue with Google]
[Continue with Apple]
── or ──
[email]  [Continue with email]
```

Treats email as the passwordless/magic-link entry, not a second-class citizen. Password isn't shown until after they click Continue and it's needed.

### GitHub — Two-step, no tabs

Sign-in and sign-up are separate pages (different URLs), not tabs on the same page. Users arrive at the right page via context (marketing copy, "Create account" CTA on landing).

### Supabase Auth UI — Email-first, conditional form

Shows only email initially. Once submitted:
- If user exists → password field appears (no page reload)
- If new → registration fields appear

---

## Pattern Comparison

| Pattern | Cognitive load | Mobile UX | Conversion | Complexity |
|---|---|---|---|---|
| Email-first progressive | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | High | Medium |
| Social-first (OAuth primary) | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | High (60-70% pick OAuth) | Low |
| Magic link only | ⭐⭐⭐⭐ | ⭐⭐ | Medium | Low |
| Tabs (current) | ⭐⭐ | ⭐⭐⭐ | Lower (decision paralysis) | Low |
| All methods at once (current) | ⭐ | ⭐⭐ | Lowest | High |

---

## Auth Method Trade-offs

### OAuth (Google / GitHub)
- **60-70%** of users pick social login when available
- Zero password to manage, fast on mobile
- Fails for users on locked-down work devices or privacy-conscious users

### Password
- Still dominant fallback; required for ~30% who won't use OAuth
- Must have `autocomplete="current-password"` or password managers won't fill
- Sign-up vs sign-in **should not** be tabs — use email lookup to detect

### Magic Link
- Best for password recovery and for users without OAuth
- **Bad on mobile**: app-switch friction (email → browser → app) loses 30-40% of users
- Should be secondary / "other options", not co-equal with password form
- Keep Turnstile but only render it once user focuses the email field (lazy mount)

### Passkeys (future)
- 412% adoption growth in 2025; 4× faster completion than password+MFA
- Offer post-login enrollment: "Sign in faster next time with Face ID?"
- Not a blocker for this redesign, but worth planning

---

## Anti-Patterns in Current Implementation

| Anti-pattern | Impact | Fix |
|---|---|---|
| Duplicate email fields | ~40% extra abandonment | Single email entry, shared across flows |
| Sign In / Sign Up tabs | Forces users to self-classify | Email lookup auto-detects new vs existing |
| CAPTCHA always visible | Visual noise, friction | Lazy-mount Turnstile only when email entered |
| No `autocomplete` on inputs | Breaks password managers | Add `autocomplete="email"` / `"current-password"` |
| No `<label>` elements | Fails WCAG 2.1 AA | Wrap inputs with accessible labels |
| Magic link as equal peer | Confuses flow | Demote to "Other options" accordion |

---

## Recommended Redesign for Lianki

### Option A — Social-first + email fallback (low effort, high gain)

Best fit for Lianki's audience (language learners, casual consumers):

```
┌─────────────────────────────────────┐
│  Sign in to Lianki                  │
│                                     │
│  [Continue with Google]             │
│  [Continue with GitHub]             │
│                                     │
│  ─── or ───                         │
│                                     │
│  Email                              │
│  [user@example.com]   [Continue]   │
│                                     │
│  (on submit: show password field    │
│   or magic link depending on what   │
│   the user has set up)              │
└─────────────────────────────────────┘
```

- Remove tabs entirely
- Single email field
- On "Continue": if user exists → show password field; if new → show sign-up inline
- Magic link becomes "Forgot password / send me a link" link under the password field
- Turnstile: lazy-mount only when user actually submits the magic link request

### Option B — Email-first progressive disclosure (higher effort, best UX)

Same as Option A visually, but adds a backend `/api/auth/check-email` call after the user enters their email, so the right step 2 is auto-selected. Requires one new API endpoint.

### Option C — Keep current structure, fix the bugs (minimal effort)

Quick wins without redesign:
1. Remove the magic link email input; reuse the password-form email state
2. Add `autocomplete` attributes
3. Add `<label>` elements
4. Lazy-mount Turnstile (only render after email field is focused)
5. Rename tabs to "Sign In" / "Create Account" (clearer intent)

---

## CAPTCHA Considerations

Current: Turnstile always visible in magic link form.

| Approach | UX | Bot protection |
|---|---|---|
| Always visible (current) | Noisy, ~40% dropout | Strong |
| Lazy-mount (render on focus) | Better perceived load | Same actual protection |
| Risk-based (only on suspicious IPs) | Best UX | Adequate for low-risk app |

Turnstile is already the right tool (non-interactive, privacy-respecting). The fix is to **lazy-mount** it — don't render the widget until the user has started filling in the email.

---

## Accessibility Checklist

- [ ] Every `<input>` paired with a `<label htmlFor>` (or `aria-label`)
- [ ] `autocomplete="email"` on email inputs
- [ ] `autocomplete="current-password"` on sign-in password
- [ ] `autocomplete="new-password"` on sign-up password
- [ ] Error messages use `role="alert"` or `aria-live="polite"`
- [ ] Submit buttons have descriptive text (not just "Submit")
- [ ] Keyboard tab order: email → password → submit
- [ ] Error state uses both color and icon/text (not color alone)

---

## References

- [The 2-Page Login Pattern & How to Fix It — Smashing Magazine 2024](https://www.smashingmagazine.com/2024/06/2-page-login-pattern-how-fix-it/)
- [Magic Links vs OTP vs Passkeys vs Social Login — MojoAuth](https://mojoauth.com/blog/magic-links-passkeys-otp-and-social-login-which-passwordless-method-fits-your-application/)
- [Convincing a Billion Users to Love Passkeys — Microsoft Security Blog](https://www.microsoft.com/en-us/security/blog/2024/12/12/convincing-a-billion-users-to-love-passkeys-ux-design-insights-from-microsoft-and-security/)
- [Progressive Disclosure in SaaS UX — Lollypop Design](https://lollypop.design/blog/2025/may/progressive-disclosure/)
- [State of Passwordless Authentication 2026 — MojoAuth](https://mojoauth.com/data-and-research-reports/state-of-passwordless-2026/)
- [FIDO Alliance Passkey UX Guidelines](https://fidoalliance.org/new-design-guidelines-optimizing-user-sign-in-experience-with-passkeys/)
- [W3C WAI Forms Tutorial](https://www.w3.org/WAI/tutorials/forms/)
