# Google OAuth Fix - 2026-03-01

## Problem

Google OAuth sign-in was failing with error:
```
Error 400: invalid_request
Access Blocked: Authentication Error
```

## Root Cause

The `BETTER_AUTH_BASE_URL` environment variable in Vercel contained a literal newline character (`\n`) at the end:
```
BETTER_AUTH_BASE_URL="http://localhost:3000\n"
```

This caused the redirect URI sent to Google to be malformed:
```
https://www.lianki.com
/api/auth/callback/google
```

Instead of:
```
https://www.lianki.com/api/auth/callback/google
```

Google's OAuth 2.0 policy for secure response handling rejected the malformed URI.

## Solution

1. Removed the incorrect environment variable from all environments
2. Added corrected values without newline characters:
   - **Production**: `https://www.lianki.com`
   - **Preview**: `https://www.lianki.com`
   - **Development**: `http://localhost:3000`

## Commands Used

```bash
# Remove old variables
vercel env rm BETTER_AUTH_BASE_URL production --yes
vercel env rm BETTER_AUTH_BASE_URL preview --yes
vercel env rm BETTER_AUTH_BASE_URL development --yes

# Add correct variables (using printf to avoid trailing newline)
printf "https://www.lianki.com" | vercel env add BETTER_AUTH_BASE_URL production
printf "https://www.lianki.com" | vercel env add BETTER_AUTH_BASE_URL preview
printf "http://localhost:3000" | vercel env add BETTER_AUTH_BASE_URL development
```

## Verification Steps

After deployment:
1. Visit https://www.lianki.com/en/sign-in
2. Click "Sign in with Google"
3. Should successfully redirect to Google OAuth
4. After authorization, should redirect back to Lianki

## Google Cloud Console Configuration

The Google OAuth client already has the correct redirect URIs configured:
- `https://lianki.com/api/auth/callback/google`
- `https://www.lianki.com/api/auth/callback/google`

The issue was entirely on the Lianki side (malformed baseURL).

## Related Files

- `auth.ts` - Better Auth configuration (no changes needed)
- Vercel environment variables - Fixed in this session

## Prevention

When setting environment variables in Vercel:
- Always use `printf` instead of `echo` to avoid trailing newlines
- Verify the value after setting: `vercel env pull` and inspect
- Test OAuth flows after environment variable changes

---

*Fixed: 2026-03-01*
*Next deployment will activate the fix*
