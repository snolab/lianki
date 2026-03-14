---
title: "Installing Lianki on iOS: Complete Guide for iPhone and iPad"
date: 2025-02-23
tags: [installation, ios, iphone, ipad, userscript, safari, mobile]
summary: "Step-by-step guide to install Lianki on iPhone and iPad using Userscripts app for Safari, with alternatives and troubleshooting."
---

# Installing Lianki on iOS: Complete Guide for iPhone and iPad

_Posted February 23, 2025 by [lianki.com](https://www.lianki.com)_

Lianki works on iPhone and iPad through userscript managers — apps that run userscripts in Safari or other browsers. This guide shows you the easiest way to get started.

**Recommended for most users**: The **Userscripts** app (free, open source, actively maintained).

Installation takes about 3-5 minutes. No jailbreak required.

---

## Quick Start (Recommended Method)

### What You'll Need

- iPhone or iPad running iOS 15.1 or later
- Safari browser (built-in)
- The **Userscripts** app (free from App Store)

### Why Userscripts App?

- **Free and open source** — No ads, no tracking
- **Easiest to set up** — Automatic configuration on first launch
- **Actively maintained** — Updated February 2026
- **Works with Safari** — No need to switch browsers
- **Beginner-friendly** — Three difficulty modes to match your experience

---

## Step 1: Install the Userscripts App

1. **Open the App Store** on your iPhone or iPad

2. **Search for "Userscripts"**
   - Look for "Userscripts" by Quoid
   - Icon: A gear/cog symbol
   - Verify it says "Free" (not a paid app)

3. **Tap "Get"** to download and install

4. **Open the Userscripts app**
   - The app will automatically set up its directory on first launch
   - You'll see a welcome screen or tutorial
   - Choose **"Beginner"** mode when prompted (you can change this later)

---

## Step 2: Enable the Userscripts Extension in Safari

Now you need to tell Safari to allow the Userscripts extension to run.

1. **Open Settings** (the Settings app on your iPhone/iPad, not Safari settings)

2. **Scroll down and tap "Safari"**

3. **Tap "Extensions"**

4. **Find "Userscripts" in the list and tap it**

5. **Toggle "Userscripts" ON** (the switch should turn green)

6. **Tap "All Websites"** under "Allow Userscripts On..."

7. **Select "Allow"**
   - This lets Userscripts run on every website you visit
   - Don't worry — the app is open source and doesn't track you

8. **Return to the Home screen**

The Userscripts extension is now active in Safari.

---

## Step 3: Install the Lianki Userscript

Now you'll install the actual Lianki script.

### Method A: Install from Greasy Fork (Easiest)

1. **Open Safari** on your iPhone/iPad

2. **Visit the Lianki script page**:
   [https://greasyfork.org/ja/scripts/567089-lianki](https://greasyfork.org/ja/scripts/567089-lianki)

3. **Tap the green "Install this script" button**

4. **Safari will detect the .user.js file**
   - A popup should appear asking to open in "Userscripts"
   - If you don't see a popup, tap the share button (square with up arrow) and select "Userscripts"

5. **The Userscripts app will open automatically**
   - You'll see the script details and code
   - Tap **"Save"** or **"Install"** to add the script

6. **Done!** The Lianki script is now installed

### Method B: Install Directly from Lianki.com

If Greasy Fork doesn't work or you prefer the direct method:

1. **Open Safari**

2. **Visit**: [https://www.lianki.com/lianki.user.js](https://www.lianki.com/lianki.user.js)

3. **Tap the share button** (square with up arrow)

4. **Select "Userscripts"** from the share sheet

5. **Tap "Save"** in the Userscripts app

---

## Step 4: Verify Installation

Let's make sure everything works.

1. **Open Safari**

2. **Visit any HTTPS website** (for example: https://en.wikipedia.org)

3. **Look for the Lianki floating button**
   - You should see a small circular button in the bottom-right corner
   - It may take a second to appear after the page loads

4. **Try dragging the button**
   - Touch and hold the button, then drag it around
   - This confirms the script is running

5. **Press and hold the button** (or try tapping it)
   - The Lianki dialog should open
   - If you're not logged in, you'll see a login prompt

**If you see the floating button**: ✅ Success! Lianki is installed and working.

**If you don't see it**: Skip to [Troubleshooting](#troubleshooting) below.

---

## Step 5: First Use

Now you're ready to start using Lianki on iOS.

### Sign In

1. **Tap the floating button** on any webpage

2. **If prompted, tap "Sign In"**

3. **Safari will open** https://www.lianki.com

4. **Log in with your account**
   - Email, GitHub, or Google sign-in
   - If you don't have an account, create one (free)

5. **Return to Safari** and reload the page

6. **Tap the floating button again** — you should now be logged in

### Adding Your First Card

1. **Visit a webpage you want to remember**
   - For example, an article, tutorial, or video

2. **Tap the Lianki floating button**

3. **The title and URL are auto-filled**

4. **Tap "Add"** to save the card

5. **You'll see a success message**

The card is now in your review queue!

### Reviewing Cards

When a card is due for review:

1. **The floating button will glow** on that card's webpage

2. **Tap the button** to open the review dialog

3. **Rate your memory** using the buttons or keyboard:
   - **Again** (1) — You forgot it
   - **Hard** (2) — Barely remembered
   - **Good** (3) — Remembered well
   - **Easy** (4) — Too easy

4. **The next review date is calculated automatically** using the FSRS algorithm

---

## Alternative Methods

While we recommend the Userscripts app for most users, here are other options:

### Option 2: Stay 2 (Free, Advanced Features)

**Best for**: Users who want ad blocking, bookmark sync, or advanced features

**Pros**:

- Free and open source
- Cross-device sync (iPhone, iPad, Mac)
- Built-in ad blocking
- Actively maintained

**Cons**:

- Slightly more complex setup
- More features = steeper learning curve

**Installation**:

1. Download "Stay 2 - Userscript Manager" from App Store
2. Enable in Settings > Safari > Extensions
3. Import the Lianki script from Greasy Fork or stayfork.app

### Option 3: Gear Browser (Free, All-in-One)

**Best for**: Users who want a single browser with built-in userscript support (no Safari extension needed)

**Pros**:

- Built-in userscript engine (no extension setup)
- 2026 v7.0 update: Supports desktop browser extensions from Chrome/Edge/Firefox
- No need to manage Safari extensions
- Free

**Cons**:

- Must use Gear Browser instead of Safari
- Loses some iOS Safari integration

**Installation**:

1. Download "Gear Browser - Userscript" from App Store
2. Open Gear Browser
3. Install Lianki userscript from Greasy Fork
4. Use Gear Browser for your browsing

See the [Appendix](#appendix-all-ios-userscript-options) for more alternatives.

---

## Troubleshooting

### I don't see the floating button

**Check if the extension is enabled**:

1. Open Settings > Safari > Extensions
2. Make sure "Userscripts" is toggled ON
3. Check that "All Websites" is set to "Allow"

**Check if the script is installed**:

1. Open the Userscripts app
2. Look for "Lianki" in your scripts list
3. Make sure it's enabled (toggle should be on)

**Check if you're on an HTTPS page**:

- The script only runs on `https://` URLs
- It won't work on `http://` pages or `file://` local files
- Try visiting https://wikipedia.org to test

**Reload the page**:

1. Pull down to refresh in Safari
2. Or tap the reload button in the address bar

**Restart Safari**:

1. Swipe up from the bottom of your screen (or double-click Home button)
2. Swipe up on Safari to close it
3. Open Safari again

### The script is installed but not running

**Clear Safari cache**:

1. Settings > Safari
2. Scroll down and tap "Clear History and Website Data"
3. Tap "Clear History and Data" to confirm
4. Reload the page

**Check Safari Content Blockers**:

- If you have ad blockers or content blockers enabled, they might conflict
- Try disabling them temporarily in Settings > Safari > Content Blockers

**Reinstall the script**:

1. Open the Userscripts app
2. Find "Lianki" and delete it
3. Reinstall from Greasy Fork (see [Step 3](#step-3-install-the-lianki-userscript))

### I get a "not authenticated" error

This means you're not logged in to Lianki.

**Solution**:

1. Tap "Sign In" in the error message (if available)
2. Or manually visit https://www.lianki.com in Safari
3. Log in with your account
4. Return to the page and tap the floating button again

**Important**: Make sure Safari allows cookies from lianki.com:

1. Settings > Safari
2. Scroll down to "Privacy & Security"
3. Make sure "Block All Cookies" is OFF
4. If using Private Browsing, note that cookies don't persist

### The floating button appears but doesn't respond

**Check if JavaScript is enabled**:

1. Settings > Safari
2. Scroll down to "Advanced"
3. Make sure "JavaScript" is ON

**Try in a different browser tab**:

- Close the current tab
- Open a new tab and visit the same page
- Sometimes iOS Safari needs a fresh tab to reset script state

### Updates aren't working

**Manually check for updates**:

1. Open the Userscripts app
2. Find the "Lianki" script
3. Look for an update option or refresh button
4. Or delete and reinstall from Greasy Fork

**Enable automatic updates** (if available in Userscripts app):

1. Open Userscripts app
2. Go to Settings
3. Enable automatic update checking

---

## iOS-Specific Tips

### Battery and Performance

Userscripts can affect battery life and performance on older devices.

**If you notice slowdowns**:

1. Open the Userscripts app
2. Disable scripts you don't use
3. Keep only Lianki enabled

**Battery optimization**:

- Userscripts run only when Safari is active
- Closing Safari completely stops all scripts
- No background battery drain

### iCloud Sync (Userscripts App)

The Userscripts app can sync your scripts across devices via iCloud.

**To enable sync**:

1. Make sure iCloud Drive is enabled (Settings > [Your Name] > iCloud)
2. Open the Userscripts app
3. Go to Settings
4. Enable iCloud sync

**iOS 18+ users**: Set scripts to "Keep Downloaded" to avoid iCloud eviction issues:

1. Open Files app
2. Navigate to iCloud Drive > Userscripts
3. Long-press the folder
4. Select "Keep Downloaded"

### Using Lianki on iPad

The setup is identical to iPhone. Some iPad-specific notes:

- **Split View**: The floating button works in Split View mode
- **External Keyboard**: Keyboard shortcuts work (if the userscript supports them on iOS)
- **Larger Screen**: You may want to reposition the floating button for easier reach

### Private Browsing Mode

Lianki works in Safari Private Browsing, but:

- ⚠️ You'll need to log in again each time (cookies don't persist)
- ⚠️ Your review history won't carry over between private sessions
- ✅ Scripts still run normally

**Not recommended for regular use** — use normal Safari browsing for the best experience.

---

## Keyboard Shortcuts on iOS

If you have an external keyboard connected to your iPad (or using on-screen keyboard), some shortcuts may work:

- **On-screen keyboard**: Type numbers 1-4 during review to rate cards
- **External keyboard**: Full desktop shortcuts may work (varies by userscript implementation)

---

## Comparison: Safari Extension vs. Browser Apps

Still deciding between Userscripts (Safari extension) and Gear Browser (standalone)?

| Feature                | Userscripts (Safari Ext.)    | Gear Browser                     |
| ---------------------- | ---------------------------- | -------------------------------- |
| **Price**              | Free                         | Free                             |
| **Browser**            | Safari (default iOS browser) | Gear Browser                     |
| **Setup Complexity**   | Moderate (enable extension)  | Easy (built-in)                  |
| **iOS Integration**    | Full (uses Safari)           | Limited (separate browser)       |
| **Script Management**  | In Userscripts app           | In browser settings              |
| **Works Offline**      | Yes                          | Yes                              |
| **iCloud Sync**        | Yes (scripts sync)           | No                               |
| **Other Extensions**   | Safari content blockers work | Built-in ad blocking             |
| **Desktop Extensions** | No                           | Yes (v7.0+: Chrome/Edge/Firefox) |

**Recommendation**:

- **Use Userscripts** if you prefer Safari and want iOS integration
- **Use Gear Browser** if you want an all-in-one solution or desktop extension support

---

## Next Steps

Now that Lianki is installed on your iPhone/iPad:

- **Check your review queue**: Visit [lianki.com/list](https://www.lianki.com/list) in Safari
- **Learn the algorithm**: Read [Understanding the FSRS Algorithm](/blog/2025-01-15-fsrs-algorithm)
- **Install on desktop too**: Follow the [Desktop Browser Installation Guide](/blog/2025-02-22-browser-installation-guide)

---

## Appendix: All iOS Userscript Options

Here's a complete list of all available userscript managers for iOS as of 2026.

### Safari Extension-Based Managers

#### 1. Userscripts (by Quoid) ⭐ RECOMMENDED

- **Price**: Free
- **App Store**: "Userscripts"
- **Latest Update**: February 13, 2026 (v1.8.6)
- **Requirements**: iOS 15.1+

**Pros**:

- Free and open source
- Automatic setup on first launch
- Three difficulty modes (Novice, Beginner, Advanced)
- iCloud sync between iOS and macOS
- Actively maintained
- No tracking or ads

**Cons**:

- No built-in script editor on iOS (editing requires macOS or manual file editing)
- iCloud sync can be finicky on iOS 18+ (requires "keep downloaded" setting)

**Best for**: Beginners, users who want a free and simple solution

---

#### 2. Stay 2 - Userscript Manager

- **Price**: Free (one-time payment covers iPhone, iPad, Mac)
- **App Store**: "Stay 2 - Userscript Manager"
- **Latest Update**: 2026 (optimized for iOS 26)
- **Requirements**: iOS 15.0+

**Pros**:

- Free and open source
- Cross-device bookmark sync
- Ad blocking support (AdGuard, uBlock Origin compatible)
- Enhanced file download management
- Script hosting platform (stayfork.app)
- Modern "Liquid Glass style" UI

**Cons**:

- More features = more complex
- Steeper learning curve than Userscripts

**Best for**: Advanced users who want ad blocking and sync features

---

#### 3. Tampermonkey

- **Price**: $2.99 USD
- **App Store**: "Tampermonkey"
- **Launch Date**: November 19, 2024
- **Requirements**: iOS 15.0+

**Pros**:

- Most famous userscript manager (desktop version widely used)
- Excellent script compatibility
- Built-in sync across devices
- Large community and documentation
- Compatible with Apple Vision Pro

**Cons**:

- Paid app ($2.99)
- Relatively new on iOS (launched late 2024)

**Best for**: Users already familiar with Tampermonkey on desktop, willing to pay for premium experience

---

#### 4. Macaque - UserScript Manager

- **Price**: Paid (exact price varies)
- **App Store**: "Macaque - UserScript Manager"
- **Requirements**: iOS, iPadOS, macOS

**Pros**:

- Works across Apple platforms
- Safari-focused

**Cons**:

- Less popular than Userscripts or Stay
- Fewer features than competitors
- Paid

**Best for**: Users wanting a simple paid alternative

---

### Browser-Based Solutions

#### 5. Gear Browser - Userscript ⭐ RECOMMENDED FOR ALL-IN-ONE

- **Price**: Free
- **App Store**: "Gear Browser - Userscript" (also called "Gear: AI Web Extension Browser")
- **Latest Update**: 2026 (v7.0 major update)
- **Requirements**: iOS

**Pros**:

- Built-in userscript engine (no Safari extension needed)
- **NEW in v7.0**: Supports desktop browser extensions (Chrome, Edge, Firefox)
- High-performance extension engine
- Compatible with Tampermonkey, Greasemonkey, Violentmonkey scripts
- Officially featured by GreasyFork
- Modern "Liquid Glass style" UI (2026 redesign)
- Free

**Cons**:

- Must use Gear Browser instead of Safari
- Loses Safari-specific iOS integrations
- May have different script compatibility than Safari-based managers

**Best for**: Users who want desktop browser extension support, or prefer an all-in-one browser solution

---

#### 6. Alook Browser - 8x Speed

- **Price**: $0.99 USD
- **App Store**: "Alook Browser - 8x Speed"
- **Developer**: Baoding Lehuo Network Technology Co., Ltd.
- **Rating**: 4.6/5

**Pros**:

- Built-in Tampermonkey script support
- Fast browsing (marketed as "8x speed")
- Cheap ($0.99)

**Cons**:

- Paid (though inexpensive)
- Must use Alook instead of Safari
- Less popular than other options
- Fewer features than Gear Browser

**Best for**: Users wanting a cheap, fast browser with userscript support

---

### Comparison Table

| App               | Type        | Price | Update    | Ease       | Features |
| ----------------- | ----------- | ----- | --------- | ---------- | -------- |
| **Userscripts**   | Safari ext. | Free  | Feb 2026  | ⭐⭐⭐⭐⭐ | Basic    |
| **Stay 2**        | Safari ext. | Free  | 2026      | ⭐⭐⭐⭐   | Advanced |
| **Tampermonkey**  | Safari ext. | $2.99 | 2024+     | ⭐⭐⭐⭐   | Premium  |
| **Macaque**       | Safari ext. | Paid  | N/A       | ⭐⭐⭐     | Basic    |
| **Gear Browser**  | Browser     | Free  | v7.0 2026 | ⭐⭐⭐⭐   | Advanced |
| **Alook Browser** | Browser     | $0.99 | N/A       | ⭐⭐⭐     | Basic    |

---

### Our Top 3 Recommendations

1. **Userscripts** (easiest, free, great for beginners)
2. **Gear Browser v7.0** (all-in-one with desktop extension support)
3. **Stay 2** (advanced features, ad blocking, free)

Choose based on your needs:

- **Just want Lianki to work on Safari?** → Userscripts
- **Want desktop browser extensions on iOS?** → Gear Browser
- **Want ad blocking + advanced features?** → Stay 2
- **Already use Tampermonkey on desktop?** → Tampermonkey (if willing to pay)

---

## Summary

**Quickest path to get Lianki working on iPhone/iPad**:

1. Install "Userscripts" app (free) from App Store
2. Enable it in Settings > Safari > Extensions
3. Visit https://greasyfork.org/ja/scripts/567089-lianki in Safari
4. Tap "Install this script"
5. Look for the floating button on any HTTPS webpage

**Total time**: 3-5 minutes

**Alternative**: Download Gear Browser for a one-step all-in-one solution (no extension setup needed).

You're now ready to use Lianki for spaced repetition learning on iOS!

---

**License**: This work is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). You are free to share and adapt this content with attribution.
