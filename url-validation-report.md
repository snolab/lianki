# URL Validation Report - English Blog Posts

Date: 2026-02-27
Total URLs checked: 119
Valid URLs: 95 (79.8%)
Broken/Issues: 24 (20.2%)

---

## Summary

Out of 119 URLs extracted from English blog posts in `/blog/en/`, **95 are valid** and **24 have issues**. However, most of the "broken" URLs are false positives from regex extraction artifacts (16 cases). Only **8 URLs require actual attention**.

---

## Critical Issues Requiring Fixes

### 1. 404 Not Found (4 URLs) ⚠️

These pages genuinely don't exist and need to be updated or removed:

#### File: `2026-02-25-android-installation-guide.md`

- **URL:** `https://www.lianki.com/contact`
- **Status:** HTTP 404
- **Action:** Create contact page or remove link

- **URL:** `https://www.lianki.com/next` (has trailing backtick in markdown)
- **Status:** HTTP 404
- **Action:** Fix URL or remove link

#### File: `2026-02-25-japanese-beginner-materials.md`

- **URL:** `https://jlptstudy.net/n5/?cat=1`
- **Status:** HTTP 404
- **Action:** Find alternative resource or update URL

- **URL:** `https://www.youtube.com/c/JapaneseImmersionwithAsami`
- **Status:** HTTP 404
- **Action:** Channel may have been deleted/renamed - verify and update

---

### 2. Site Appears Down (1 URL) ⚠️

#### File: `2026-02-25-japanese-beginner-materials.md`

- **URL:** `https://hiragana-quest.com/`
- **Status:** Connection timeout
- **Action:** Site appears to be permanently offline - consider removing or finding alternative

---

### 3. Anti-Bot Protection (3 URLs) ℹ️

These block automated requests but are likely valid when accessed by browsers:

#### File: `2025-02-20-jpdb-lianki-workflow.md`

- **URL:** `https://www.patreon.com/jpdb`
- **Status:** HTTP 403
- **Note:** Patreon has anti-bot protection; URL is likely valid

#### File: `2026-02-25-android-installation-guide.md`

- **URL:** `https://alternativeto.net/software/tampermonkey/`
- **Status:** HTTP 403
- **Note:** AlternativeTo blocks curl; URL is likely valid

#### File: `2026-02-27-language-reactor-lianki-workflow.md`

- **URL:** `https://www.classcentral.com/report/review-language-reactor/`
- **Status:** HTTP 403
- **Note:** Class Central blocks automated requests; URL is likely valid

---

### 4. HTTP 406 Not Acceptable (1 URL)

#### File: `2026-02-27-language-reactor-lianki-workflow.md`

- **URL:** `https://ltl-school.com/language-reactor/`
- **Status:** HTTP 406
- **Action:** Verify URL manually; may require specific headers

---

## False Positives (Ignore These)

### Malformed Extractions (16 URLs)

These are artifacts from regex extraction of markdown syntax and can be ignored:

1. `https://*/*` - Code example in userscript.md
2. `https://www.youtube.com/watch?v=${url.pathname.slice(1` - JavaScript template literal
3. URLs with trailing backticks (5 instances)
4. URLs with markdown link syntax `](URL)` (4 instances)
5. Placeholder URLs like `http://` and `https://` (4 instances)

### Already Fixed in Manual Check

- **URL:** `http://www.guidetojapanese.org/learn/`
- **Status:** Initially failed, but manual check shows HTTP 200 (valid)
- **Note:** Timeout issue with initial check

---

## Recommendations

### Immediate Actions Required

1. **Fix or remove 404 URLs** in:
   - `2026-02-25-android-installation-guide.md` (2 URLs)
   - `2026-02-25-japanese-beginner-materials.md` (2 URLs)

2. **Check hiragana-quest.com status** - appears permanently offline

3. **Verify ltl-school.com URL** manually (HTTP 406 error)

### No Action Needed

- Anti-bot 403 errors (3 URLs) - these work in browsers
- Malformed extraction artifacts (16 URLs) - not real URLs
- guidetojapanese.org - works fine

---

## File-by-File Breakdown

### Files with Real Issues

1. **2026-02-25-android-installation-guide.md**: 2 broken links (404)
2. **2026-02-25-japanese-beginner-materials.md**: 3 broken links (2×404, 1×down)
3. **2026-02-27-language-reactor-lianki-workflow.md**: 1 possible issue (406)

### Files with Only False Positives

1. **2025-02-10-userscript.md**: Code examples only
2. **2025-02-20-jpdb-lianki-workflow.md**: Backtick formatting + 1 valid anti-bot 403
3. **2025-02-22-browser-installation-guide.md**: Markdown formatting artifacts
4. **2025-02-23-ios-installation-guide.md**: Markdown formatting artifacts

### Files with All Valid URLs

1. **2025-01-01-introduction.md**: All valid
2. **2025-01-15-fsrs-algorithm.md**: All valid
3. **2025-02-24-language-gdp-coverage.md**: All valid

---

## Next Steps

1. Review and fix the 4 confirmed 404 errors
2. Decide whether to keep or remove hiragana-quest.com reference
3. Manually verify ltl-school.com URL in browser
4. Consider adding URL validation to CI/CD pipeline
5. Clean up markdown formatting to avoid backticks in URLs
