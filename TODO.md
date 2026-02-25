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

## 🚧 Pending Tasks

### API Implementation
- [ ] Create `/api/fsrs/batch-add` endpoint for bulk URL imports
- [ ] Create `/api/import/youtube` endpoint for YouTube playlist import
- [ ] Implement YouTube Data API integration (requires API key)

### Additional Pages
Need to check and update if they have headers:
- [ ] Profile page (`app/[locale]/profile/page.tsx`)
- [ ] Membership page (`app/[locale]/membership/page.tsx`)
- [ ] Polyglot page (`app/[locale]/polyglot/page.tsx`)
- [ ] Self-intro page (`app/[locale]/self-intro/page.tsx`)
- [ ] Add-note page (`app/[locale]/add-note/page.tsx`)
- [ ] Sign-in page (`app/[locale]/sign-in/page.tsx`)

### Testing
- [ ] Test header on all updated pages
- [ ] Test profile dropdown functionality
- [ ] Test language switcher
- [ ] Test responsive behavior (desktop vs mobile)
- [ ] Test /learn page import functionality once APIs are implemented
- [ ] Verify navigation links work correctly across all locales

### Recommended Lists
- [ ] Create actual recommended learning material lists (currently empty arrays)
- [ ] Add JLPT N5 Grammar URLs
- [ ] Add JLPT N4 Grammar URLs
- [ ] Add Basic English Vocabulary URLs
- [ ] Create database or config for recommended lists

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
