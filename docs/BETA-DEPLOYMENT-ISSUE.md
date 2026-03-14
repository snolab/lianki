# Beta Deployment Issue - Root Cause & Solutions

**Issue**: beta.lianki.com returns 404 (DEPLOYMENT_NOT_FOUND)
**Impact**: Cannot test v2.20.0 offline-first functionality before production merge

---

## Root Cause Analysis

### What We Found

1. **✓ DNS Configuration: WORKING**

   ```bash
   $ getent hosts beta.lianki.com
   64.29.17.1  973a3d7061d8fc14.vercel-dns-017.com beta.lianki.com
   ```

   - DNS resolves correctly to Vercel servers
   - Same infrastructure as www.lianki.com

2. **✓ vercel.json Configuration: CORRECT**

   ```json
   {
     "git": {
       "deploymentEnabled": {
         "main": true,
         "beta": true
       }
     }
   }
   ```

   - Beta branch deployment is enabled

3. **✓ Beta Branch: UP TO DATE**

   ```bash
   $ git log origin/beta --oneline -1
   122f6cb feat: Offline-First Sync with IndexedDB and CRDT (v2.20.0) (#60)
   ```

   - PR #60 merged 35 minutes ago (2026-02-26 00:05:15 UTC)
   - Contains v2.20.0 offline-first code

4. **❌ Beta Deployment: OUTDATED (8 days old)**

   ```bash
   $ vercel inspect lianki-git-beta-snomiao.vercel.app
   created: Tue Feb 17 2026 20:04:38 GMT+0000 (8d ago)
   ```

   - Last beta deployment is from Feb 17 (before offline-first merge)
   - Current URL: https://lianki-git-beta-snomiao.vercel.app
   - Status: ❌ 401 Unauthorized (Deployment Protection enabled)

5. **❌ Deployment Protection: ENABLED**
   - All preview/non-production deployments require authentication (401)
   - Includes:
     - `lianki-git-beta-snomiao.vercel.app` (beta branch)
     - `lianki-git-sno-sync-snomiao.vercel.app` (sno-sync branch)
     - All `lianki-XXXXX-snomiao.vercel.app` preview URLs

6. **❌ Domain Mapping: NOT CONFIGURED**
   - beta.lianki.com DNS exists BUT no Vercel deployment mapped to it
   - Result: 404 DEPLOYMENT_NOT_FOUND
   - The domain needs to be explicitly added to Vercel project

---

## Why Beta Branch Isn't Auto-Deploying

**Issue**: PR #60 was merged to beta 35 minutes ago, but no new deployment was triggered.

**Possible Reasons:**

1. **Vercel Git Integration Limitation**
   - `deploymentEnabled.beta: true` only enables preview deployments
   - It does NOT automatically deploy to a production domain (beta.lianki.com)
   - Beta branch deployments go to `lianki-git-beta-*.vercel.app` (preview URLs)

2. **No GitHub Actions Workflow**
   - No CI/CD workflow found that deploys beta branch to beta.lianki.com
   - Vercel expects either:
     - Manual domain assignment in dashboard
     - GitHub Actions workflow with Vercel CLI

3. **Deployment Protection Blocks Testing**
   - Even if beta branch deploys to preview URL, it requires authentication
   - Cannot run automated tests against protected URLs

---

## Solutions

### Option A: Add beta.lianki.com Domain to Vercel (RECOMMENDED)

**Steps:**

1. **Add Domain via Vercel Dashboard**
   - Go to: https://vercel.com/snomiao/lianki/settings/domains
   - Click "Add Domain"
   - Enter: `beta.lianki.com`
   - Select "Assign to Git Branch: beta"
   - This will make beta.lianki.com always point to the latest beta branch deployment

2. **Verify Domain Configuration**

   ```bash
   # Should return 200 and v2.20.0
   curl -I https://beta.lianki.com/lianki.user.js
   ```

3. **Disable Deployment Protection (if needed)**
   - Go to: https://vercel.com/snomiao/lianki/settings/deployment-protection
   - Choose one:
     - **Option 1**: Disable protection (makes all deployments public)
     - **Option 2**: Add specific domains to bypass list (beta.lianki.com)
     - **Option 3**: Keep protection, use Vercel CLI with auth token for tests

**Pros:**

- ✓ Permanent solution
- ✓ beta.lianki.com always shows latest beta branch
- ✓ No manual deployment needed
- ✓ Matches production setup

**Cons:**

- ⚠️ Requires Vercel dashboard access

**Time:** 5 minutes

---

### Option B: Create GitHub Actions Workflow for Beta

**Create**: `.github/workflows/deploy-beta.yml`

```yaml
name: Deploy Beta

on:
  push:
    branches: [beta]
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Vercel CLI
        run: npm install -g vercel

      - name: Deploy to Beta
        run: |
          vercel pull --yes --environment=production --token=${{ secrets.VERCEL_TOKEN }}
          vercel build --prod --token=${{ secrets.VERCEL_TOKEN }}
          vercel deploy --prebuilt --prod --token=${{ secrets.VERCEL_TOKEN }}
        env:
          VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
          VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}

      - name: Assign to beta.lianki.com
        run: |
          DEPLOYMENT_URL=$(vercel ls --scope team_0YVgkyqvak5X8lMl3zNBqIC7 --token=${{ secrets.VERCEL_TOKEN }} | head -1 | awk '{print $2}')
          vercel alias set $DEPLOYMENT_URL beta.lianki.com --scope team_0YVgkyqvak5X8lMl3zNBqIC7 --token=${{ secrets.VERCEL_TOKEN }}
```

**Pros:**

- ✓ Automated deployment on push to beta
- ✓ Can customize build process
- ✓ Visible in GitHub Actions tab

**Cons:**

- ⚠️ Requires workflow creation and testing
- ⚠️ More complex than dashboard config

**Time:** 15-20 minutes

---

### Option C: Manual Deployment via Vercel CLI (TEMPORARY FIX)

**Steps:**

1. **Checkout beta branch**

   ```bash
   git checkout beta
   git pull origin beta
   ```

2. **Deploy to production** (will be accessible at beta.lianki.com if domain is configured)

   ```bash
   vercel --prod --scope team_0YVgkyqvak5X8lMl3zNBqIC7
   ```

3. **Alias to beta.lianki.com**
   ```bash
   # Get the deployment URL from previous command output
   vercel alias set <deployment-url> beta.lianki.com --scope team_0YVgkyqvak5X8lMl3zNBqIC7
   ```

**Pros:**

- ✓ Quick temporary fix
- ✓ Can test immediately

**Cons:**

- ⚠️ Manual process (not automated)
- ⚠️ Need to repeat for every beta update
- ⚠️ Won't work if domain not configured

**Time:** 2-3 minutes

---

### Option D: Disable Deployment Protection (QUICK TEST)

**Steps:**

1. **Go to Vercel Dashboard**
   - https://vercel.com/snomiao/lianki/settings/deployment-protection

2. **Disable Protection**
   - Select "All Deployments"
   - Click "Save"

3. **Test Preview URL**

   ```bash
   # Now should return 200 instead of 401
   curl -I https://lianki-git-beta-snomiao.vercel.app/lianki.user.js
   ```

4. **Run Beta Tests**
   ```bash
   LIANKI_URL=https://lianki-git-beta-snomiao.vercel.app node tests/beta-test.spec.mjs
   ```

**Pros:**

- ✓ Fastest solution (1 minute)
- ✓ Allows immediate testing
- ✓ Works with existing preview URLs

**Cons:**

- ⚠️ Makes ALL deployments public (including dev branches)
- ⚠️ Security concern if repo has sensitive code
- ⚠️ Still testing 8-day-old deployment (not v2.20.0)

**Time:** 1 minute

---

## Recommended Approach

**For immediate testing:**

1. **Option A** (Add domain via dashboard) - 5 minutes
   - This is the proper long-term solution
   - Matches your production setup
   - Enables automated testing

**If dashboard access is difficult:** 2. **Option C** (Manual CLI deployment) + **Option D** (Disable protection)

- Quick workaround to test v2.20.0
- Can be replaced with Option A later

---

## Step-by-Step Instructions (Option A - RECOMMENDED)

### 1. Add beta.lianki.com Domain

**Via Vercel Dashboard:**

1. Go to: https://vercel.com/snomiao/lianki/settings/domains
2. Click "Add Domain"
3. Enter: `beta.lianki.com`
4. Under "Git Branch", select: `beta`
5. Click "Add"

**Via Vercel CLI (alternative):**

```bash
# Switch to beta branch
git checkout beta

# Deploy to production environment
vercel --prod --scope team_0YVgkyqvak5X8lMl3zNBqIC7

# Get the deployment URL from output, then:
vercel domains add beta.lianki.com --scope team_0YVgkyqvak5X8lMl3zNBqIC7
vercel alias set <deployment-url> beta.lianki.com --scope team_0YVgkyqvak5X8lMl3zNBqIC7
```

### 2. Verify Deployment

```bash
# Check if domain is accessible
curl -I https://beta.lianki.com/lianki.user.js

# Should see:
# HTTP/2 200
# content-length: 103578  (v2.20.0 size)
```

### 3. Disable Deployment Protection (Optional)

**Only if tests still fail with 401:**

1. Go to: https://vercel.com/snomiao/lianki/settings/deployment-protection
2. Under "Deployment Protection Mode", select:
   - Either: "All Deployments" (fully disable)
   - Or: "Standard Protection" and add `beta.lianki.com` to bypass list
3. Click "Save"

### 4. Run Beta Tests

```bash
node tests/beta-test.spec.mjs
```

**Expected output:**

```
🧪 Starting Beta Testing for v2.20.0

Testing: https://beta.lianki.com

📦 Test 1: Checking beta userscript version...
  ✓ Version: 2.20.0
  ✓ IndexedDB support: true
  ✓ LiankiDeps bundled: true
  ✓ HLC implementation: true

[... 7 more tests ...]

✨ ✅ READY FOR PRODUCTION
All critical tests passed with no errors!

Recommendation: Safe to merge to main 🚀
```

---

## Verification Checklist

After implementing the solution:

- [ ] beta.lianki.com returns 200 (not 404)
- [ ] `/lianki.user.js` is 103KB (v2.20.0, not 48KB old version)
- [ ] Version in script is 2.20.0
- [ ] `grep "IndexedDB" lianki.user.js` returns results
- [ ] Beta test script runs successfully
- [ ] All 8 test scenarios pass
- [ ] Overall recommendation is "READY FOR PRODUCTION"

---

## Current Status

**As of 2026-02-26 00:35 UTC:**

- ❌ beta.lianki.com → 404 DEPLOYMENT_NOT_FOUND
- ❌ lianki-git-beta-snomiao.vercel.app → 401 Unauthorized (old deployment)
- ✅ www.lianki.com → 200 (production, v2.19.3)
- ✅ Code merged to beta branch (122f6cb)
- ✅ vercel.json configured correctly
- ❌ Domain not assigned to beta branch in Vercel

**Next Action Required:**
Add beta.lianki.com domain in Vercel dashboard and assign to beta branch.

---

## Additional Notes

### Why Deployment Protection Blocks Testing

Vercel's "Deployment Protection" feature requires authentication for:

- All preview deployments (`*.vercel.app` URLs)
- Git branch deployments (`lianki-git-*-snomiao.vercel.app`)
- Unless domain is explicitly in "Standard Protection" bypass list

**Purpose**: Prevents exposing development/staging environments publicly

**Our situation**: Blocks automated E2E testing of beta environment

**Solutions**:

1. Disable protection entirely (quick but less secure)
2. Add beta.lianki.com to bypass list (better)
3. Use production deployment for beta branch (best)

### Why Git Branch Deployments Don't Auto-Update

Vercel's git integration behavior:

- `main` branch → Deploys to production domains (www.lianki.com)
- Other branches → Deploy to preview URLs (`lianki-git-BRANCH-*.vercel.app`)
- Preview URLs are NOT automatically updated on push
- Preview URLs have unique hashes per deployment

**To get auto-updating beta.lianki.com:**
Must explicitly assign domain to branch in Vercel dashboard.

---

## Related Files

- `vercel.json` - Vercel configuration
- `tests/beta-test.spec.mjs` - Comprehensive beta test suite
- `tests/BETA-TEST-REPORT.md` - Test results report
- `docs/offline-first-implementation.md` - Implementation details

---

**Document Created**: 2026-02-26 00:36 UTC
**Author**: Claude Code (Sonnet 4.5)
**Status**: Awaiting Vercel dashboard configuration
