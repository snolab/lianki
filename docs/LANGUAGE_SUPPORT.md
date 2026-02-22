# Lianki Language Support Guide

## Two-Track Translation System

### 1. Blog Posts (Auto-LLM Translation)
**Location**: `blog/[locale]/*.md`

**How it works**:
- Source: English blog posts in `blog/en/`
- Auto-translated via OpenAI GPT-4o when user visits `/[locale]/blog/[slug]`
- Committed back to repo with `[skip ci]` to avoid deployment costs
- Fetched from GitHub API (visible in ~60s without deployment)

**Supported**: ANY language - just add to `/api/translate` LOCALE_NAMES mapping

### 2. UI Strings (Human + LLM)
**Location**: `app/**/*.content.ts` (Intlayer files)

**How it works**:
- Define translations in TypeScript
- Type-safe, autocomplete, inline with components
- Can be LLM-translated or human-written

**Current**: en, zh, ja (3 languages)
**Need to add**: 12 more languages from the plan

---

## Complete Language List

Based on the i18n plan (top 15 by total speakers) + Korean:

| # | Language | Code | Direction | Status | Priority |
|---|----------|------|-----------|--------|----------|
| 1 | English | `en` | LTR | ✅ Active | Default |
| 2 | Chinese (Simplified) | `zh` | LTR | ✅ Active | High |
| 3 | Hindi | `hi` | LTR | ⏳ Coming | High |
| 4 | Spanish | `es` | LTR | ⏳ Coming | High |
| 5 | French | `fr` | LTR | ⏳ Coming | High |
| 6 | Arabic | `ar` | RTL | ⏳ Coming | High |
| 7 | Bengali | `bn` | LTR | ⏳ Coming | Medium |
| 8 | Portuguese | `pt` | LTR | ⏳ Coming | High |
| 9 | Russian | `ru` | LTR | ⏳ Coming | Medium |
| 10 | Urdu | `ur` | RTL | ⏳ Coming | Medium |
| 11 | Indonesian | `id` | LTR | ⏳ Coming | Medium |
| 12 | German | `de` | LTR | ⏳ Coming | High |
| 13 | Japanese | `ja` | LTR | ✅ Active | High |
| 14 | Swahili | `sw` | LTR | ⏳ Coming | Low |
| 15 | Marathi | `mr` | LTR | ⏳ Coming | Low |
| 16 | Korean | `ko` | LTR | ⏳ Coming | High* |

*Korean added (high demand for language learning apps)

---

## How to Add a New Language

### Step 1: Update Intlayer Config
```typescript
// intlayer.config.ts
const config: IntlayerConfig = {
  internationalization: {
    locales: ["en", "zh", "ja", "es", "fr", ...], // Add new locale
    defaultLocale: "en",
  },
};
```

### Step 2: Add UI Translations

#### Option A: LLM-Assisted (Faster)
1. Extract English strings from `.content.ts` files
2. Use OpenAI to translate to target language:
   ```typescript
   const response = await openai.chat.completions.create({
     model: "gpt-4o",
     messages: [{
       role: "system",
       content: "Translate JSON to Spanish, preserve structure and keys"
     }, {
       role: "user",
       content: JSON.stringify(englishStrings)
     }]
   });
   ```

3. Add translations to `.content.ts` files:
   ```typescript
   // app/page.content.ts
   import { t } from "intlayer";

   export default {
     appName: t({ en: "Lianki", es: "Lianki" }),
     nav: {
       blog: t({ en: "Blog", es: "Blog" }),
       learn: t({ en: "Learn", es: "Aprender" }),
     }
   }
   ```

#### Option B: Human Translation (Better Quality)
1. Export to CSV/JSON for translators
2. Use Intlayer Editor VS Code extension
3. Or directly edit `.content.ts` files
4. Accept community contributions via GitHub PRs

### Step 3: Test Locally
```bash
# Test with cookie
curl -H "Cookie: NEXT_LOCALE=es" http://localhost:3000

# Or change locale via UI language switcher
```

### Step 4: Blog Posts (Auto-Handled)
- Blog posts auto-translate when users visit them
- No manual work needed for blog content
- OpenAI translates on-demand, commits to GitHub

---

## Priority Recommendations

### Phase 1: Western Languages (High ROI)
**Target**: es, fr, de, pt
**Why**: Large online presence, high purchasing power, education/tech sectors

- **Spanish** (`es`) - 500M+ speakers, 2nd most spoken language
- **French** (`fr`) - Europe, Africa, education sector
- **German** (`de`) - Europe, tech-savvy users
- **Portuguese** (`pt`) - Brazil market, growing tech scene

### Phase 2: Asian Languages
**Target**: hi, ko
**Why**: Huge populations, growing internet adoption

- **Hindi** (`hi`) - 600M+ speakers, India's dominant language
- **Korean** (`ko`) - High tech adoption, language learning demand

### Phase 3: Middle East & Others
**Target**: ar, ur, ru, id
**Why**: Large populations, specific regional needs

- **Arabic** (`ar`) - 400M+ speakers, Middle East/North Africa
- **Urdu** (`ur`) - Pakistan/India, 230M+ speakers
- **Russian** (`ru`) - 250M+ speakers, large internet population
- **Indonesian** (`id`) - 280M+ speakers, SE Asia

### Phase 4: Remaining
**Target**: bn, mr, sw
**Why**: Lower priority but still significant populations

- **Bengali** (`bn`) - Bangladesh/India
- **Marathi** (`mr`) - Western India
- **Swahili** (`sw`) - East Africa

---

## Technical Considerations

### RTL Languages (Arabic, Urdu)
Require special handling in layout:

```typescript
// app/layout.tsx
<html
  lang={locale}
  dir={locale === 'ar' || locale === 'ur' ? 'rtl' : 'ltr'}
>
```

Plus Tailwind RTL utilities:
```tsx
// Instead of: ml-4
<div className="ml-4 rtl:mr-4 rtl:ml-0">

// Or use logical properties:
<div className="ms-4"> {/* margin-inline-start */}
```

### CJK Languages (Chinese, Japanese, Korean)
May need font optimization:

```css
/* globals.css */
body {
  font-family: system-ui,
    'Noto Sans CJK SC', /* Chinese Simplified */
    'Noto Sans CJK JP', /* Japanese */
    'Noto Sans CJK KR', /* Korean */
    sans-serif;
}
```

Or use `next/font` with variable fonts.

---

## Current Status Summary

- **Active (3)**: en, zh, ja
- **UI Translations Needed (13)**: hi, es, fr, ar, bn, pt, ru, ur, id, de, sw, mr, ko
- **Blog Posts**: Auto-translate to ANY language when visited
- **Total Possible Languages**: Unlimited (via LLM), practical target: 15-20

---

## Contribution Methods

### For Developers
1. Edit `.content.ts` files directly
2. Add locale to `intlayer.config.ts`
3. Submit PR with translations

### For Translators (Non-Developers)
1. Use Intlayer Editor VS Code extension
2. Export/import CSV or JSON files
3. Submit translations via GitHub Issues
4. Community translation platforms (Crowdin, Weblate)

### Community-Driven
- Create `CONTRIBUTING_TRANSLATIONS.md`
- Accept PRs with new locale files
- Use translation platforms for collaborative work
- Recognize contributors in README

---

## Files to Update When Adding a Language

1. **`intlayer.config.ts`** - Add locale code
2. **`app/**/*.content.ts`** - Add translations to all content files
3. **`app/api/translate/route.ts`** - Add to LOCALE_NAMES (for blog auto-translate)
4. **`app/components/LanguageSwitcher.tsx`** - Already includes all 16 languages
5. **`middleware.ts`** - No changes needed (handled by Intlayer)

---

## Next Steps

1. ✅ **Language Switcher** - Already built with all 16 languages
2. 🔄 **LLM Translation Script** - Automate `.content.ts` translation
3. 🔄 **Add Spanish, French, German** - Quick wins (Western languages)
4. 🔄 **Crowdin/Weblate Setup** - Enable community contributions
5. 🔄 **RTL Support** - Implement for Arabic and Urdu
6. 🔄 **CJK Font Optimization** - Better font loading for Chinese/Japanese/Korean
7. 🔄 **Translation Memory** - Reuse translations across similar strings

---

## Beyond Top 15: Additional Languages

We can support **any language** via LLM translation. Consider adding based on demand:

**High-Demand Candidates**:
- Italian (`it`) - 85M speakers, Europe
- Turkish (`tr`) - 88M speakers, growing tech scene
- Vietnamese (`vi`) - 95M speakers, SE Asia
- Polish (`pl`) - 45M speakers, Europe
- Dutch (`nl`) - 25M speakers, high GDP per capita
- Thai (`th`) - 60M speakers, SE Asia

**Process**: Same as above - add to `intlayer.config.ts`, translate UI strings, blog auto-translates.

---

## Translation Quality Tiers

| Tier | Method | Quality | Cost | Use Case |
|------|--------|---------|------|----------|
| 🥇 Gold | Native speaker review | Excellent | High | Landing page, critical UI |
| 🥈 Silver | Professional translation | Very Good | Medium | Marketing content, docs |
| 🥉 Bronze | LLM + Human review | Good | Low | Blog posts, long-form content |
| ⚙️ Auto | LLM only | Acceptable | Near-zero | First draft, non-critical content |

**Current Approach**:
- **Blog posts**: Auto tier (LLM only, fast iteration)
- **UI strings**: Should be Silver/Gold tier (human review recommended)

---

For questions or contributions, open an issue or PR on GitHub.
