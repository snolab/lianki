# Vercel Environment Variable Setup

## Required: Fix Better Auth Base URL Warning

### Current Issue
Every request logs this warning:
```
WARN [Better Auth]: Base URL could not be determined.
Please set BETTER_AUTH_BASE_URL environment variable.
```

### Solution
Add the following environment variable in Vercel:

**Variable Name:** `BETTER_AUTH_BASE_URL`
**Value:** `https://www.lianki.com`

### How to Set (Option 1: Vercel Dashboard)

1. Go to https://vercel.com/snomiao/lianki/settings/environment-variables
2. Click "Add New"
3. Enter:
   - **Key**: `BETTER_AUTH_BASE_URL`
   - **Value**: `https://www.lianki.com`
   - **Environments**: Check all (Production, Preview, Development)
4. Click "Save"
5. Redeploy the project for changes to take effect

### How to Set (Option 2: Vercel CLI)

```bash
# Production
vercel env add BETTER_AUTH_BASE_URL production
# When prompted, enter: https://www.lianki.com

# Preview
vercel env add BETTER_AUTH_BASE_URL preview
# When prompted, enter: https://www.lianki.com

# Development
vercel env add BETTER_AUTH_BASE_URL development
# When prompted, enter: https://www.lianki.com
```

### Verification

After setting the variable and redeploying:
1. Check Vercel logs: `vercel logs lianki.com`
2. The Better Auth warning should no longer appear
3. Auth callbacks and redirects will work correctly

---

## Other Recommended Environment Variables

### MongoDB Connection
Ensure `MONGODB_URI` is set (should already be configured):
```
MONGODB_URI=mongodb+srv://...
```

### Node Environment
```
NODE_ENV=production
```

### Optional: Sentry (for error tracking)
If you want to add Sentry for better error monitoring:
```
SENTRY_DSN=https://...
SENTRY_ENV=production
```

---

## Notes

- After adding/changing environment variables, you **must redeploy** for them to take effect
- Use `vercel env ls` to list all current environment variables
- Use `vercel env rm <name>` to remove a variable
- Sensitive values (like API keys) should only be set in Vercel, not in `.env` files in the repo
