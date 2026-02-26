# Unified Header Implementation Progress

## ✅ Completed Tasks

### 1. Header Component Creation
- [x] Created unified `Header` component at `app/components/Header.tsx`
- [x] Implemented responsive design (avatar + username on desktop, avatar only on mobile)
- [x] Added profile dropdown with:
  - Dashboard
  - Profile
  - Preferences
  - Membership
  - Sign out
- [x] Integrated LanguageSwitcher modal
- [x] Added Learn and Blog navigation buttons
- [x] Shows "Sign in" button when user not logged in

### 2. Learn Page Creation
- [x] Created `/learn` route at `app/[locale]/learn/page.tsx`
- [x] Created `LearnClient.tsx` with three import methods:
  - Recommended lists (predefined learning materials)
  - Custom .txt URL import (one URL per line)
  - YouTube playlist import (extracts playlist ID and imports videos)
- [x] Added tab-based UI for easy switching between import methods
- [x] Implemented loading states and success/error messages

### 3. Page Updates
Updated the following pages to use unified Header component:

- [x] Landing page (`app/[locale]/page.tsx`)
- [x] Blog index (`app/[locale]/blog/page.tsx`)
- [x] Blog post detail (`app/[locale]/blog/[slug]/page.tsx`)
- [x] List/Dashboard (`app/[locale]/list/page.tsx`)
- [x] Preferences (`app/[locale]/preferences/page.tsx`)
- [x] Learn page (`app/[locale]/learn/page.tsx`)
- [x] Profile page (`app/[locale]/profile/page.tsx`)
- [x] Membership page (`app/[locale]/membership/page.tsx`)
- [x] Polyglot page (`app/[locale]/polyglot/page.tsx`)
- [x] Self-intro page (`app/[locale]/self-intro/page.tsx`)
- [x] Add-note page (`app/[locale]/add-note/page.tsx`)
- [x] Sign-in page (`app/[locale]/sign-in/page.tsx`)

### 4. Backend API Implementation
- [x] Created `/api/fsrs/batch-add` endpoint for bulk URL imports
- [x] Created `/api/import/youtube` endpoint for YouTube playlist import
- [x] Implemented YouTube Data API integration (requires `YOUTUBE_API_KEY` env var)
- [x] Created shared `lib/normalizeUrl.ts` utility for URL normalization
- [x] Refactored FSRS handler to use shared normalizeUrl

### 5. YouTube Import Conditional Display
- [x] Created `/api/import/youtube/status` endpoint to check API key availability
- [x] Updated `LearnClient.tsx` to conditionally show YouTube tab based on API key
- [x] Added `youtubeAvailable` state with useEffect to check status on mount

### 6. Recommended Learning Materials
- [x] Changed recommended lists to redirect to blog posts instead of direct import
- [x] Updated `RecommendedList` interface with `blogSlug` property
- [x] Created `blog/en/2026-02-25-japanese-beginner-materials.md` (2,500 words)
- [x] Created Korean translation `blog/ko/2026-02-25-japanese-beginner-materials.md`
- [x] Comprehensive guide with YouTube playlists, textbooks, and 6-month roadmap

### 7. Blog Title AI Translation
- [x] Added `translateText()` function using OpenAI GPT-4o-mini in `app/[locale]/blog/page.tsx`
- [x] Updated `getPostSummaries()` to check for localized versions first
- [x] Implemented fallback to AI translation for title and summary
- [x] Verified working on production (https://www.lianki.com/ko/blog shows Korean titles)

## 🚧 Pending Tasks

### Testing
- [ ] Test header on all updated pages
- [ ] Test profile dropdown functionality
- [ ] Test language switcher
- [ ] Test responsive behavior (desktop vs mobile)
- [x] Test /learn page import functionality (APIs implemented and working)
- [ ] Verify navigation links work correctly across all locales
- [x] Verify blog title translation works on production (tested on ko/blog)

### Recommended Lists
- [x] Created first recommended list blog post (Japanese Beginners)
- [ ] Create more recommended learning material blog posts:
  - [ ] JLPT N4 Grammar materials
  - [ ] JLPT N3 Grammar materials
  - [ ] Basic English Vocabulary
  - [ ] Chinese HSK 1-2 materials
  - [ ] Spanish A1-A2 materials

## 📝 Notes

### Header Structure
```
[Lianki Logo]  [Learn] [Blog] [Language 🌐] [Profile ▼]
```

- Logo: Links to landing page
- Learn: Links to /learn page
- Blog: Links to /blog page
- Language: Opens language switcher modal (16 languages)
- Profile: Dropdown with Dashboard, Profile, Preferences, Membership, Sign out

### Mobile Responsive
- Learn/Blog labels: Visible on all screen sizes
- Username: Hidden on mobile (< 768px), shown on desktop
- Avatar: Always visible
- Language: Globe icon always visible, label hidden on small screens

### Import Functionality
1. **Recommended Lists**: Click to import pre-curated learning materials
2. **Custom URL**: Paste .txt file URL containing one URL per line
3. **YouTube Playlist**: Paste playlist URL, system extracts all video URLs

Example YouTube playlist URL:
```
https://www.youtube.com/watch?v=OA3O1jOCnN4&list=PLCLBHbUvkRGo5AJwrulwhBmrit0-5TiXT
```

### User Authentication
Pages handle authentication in two ways:
1. **Required auth** (list, preferences, learn): Use `authUser()` and `authEmail()`
2. **Optional auth** (landing, blog): Try/catch around `authUser()`, show "Sign in" if not logged in
