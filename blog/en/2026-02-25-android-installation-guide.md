---
title: "How to Use Lianki on Android: Complete Installation Guide"
description: "Step-by-step tutorial for installing and using Lianki userscript on Android phones and tablets with Firefox, Kiwi Browser, or other supported browsers"
date: 2026-02-25
author: Lianki Team
tags: ["android", "mobile", "installation", "userscript", "tampermonkey", "violentmonkey", "firefox", "tutorial"]
---

# How to Use Lianki on Android: Complete Installation Guide

Want to use Lianki's spaced repetition system on your Android phone or tablet? This comprehensive guide will show you how to install and use the Lianki userscript on Android devices.

## Table of Contents

- [Why Use Lianki on Android?](#why-use-lianki-on-android)
- [Supported Browsers](#supported-browsers)
- [Method 1: Firefox for Android (Recommended)](#method-1-firefox-for-android-recommended)
- [Method 2: Kiwi Browser](#method-2-kiwi-browser)
- [Installing the Lianki Userscript](#installing-the-lianki-userscript)
- [Using Lianki on Android](#using-lianki-on-android)
- [Troubleshooting](#troubleshooting)
- [Frequently Asked Questions](#frequently-asked-questions)

## Why Use Lianki on Android?

Using Lianki on your Android device offers several advantages:

- 📱 **Learn anywhere**: Review flashcards during commutes, breaks, or downtime
- 🔄 **Seamless sync**: Your cards sync across all devices (desktop, mobile, tablet)
- 🚀 **Quick reviews**: Add cards from mobile browsers while browsing
- 🎯 **Stay consistent**: Never miss a review session with mobile access

## Supported Browsers

Android browsers that support userscript managers in 2026:

| Browser | Userscript Manager | Status | Recommendation |
|---------|-------------------|--------|----------------|
| **Firefox for Android** | Tampermonkey, Violentmonkey | ✅ Fully supported | **Recommended** |
| **Kiwi Browser** | Violentmonkey (Legacy) | ⚠️ Limited support | Alternative |
| **Yandex Browser** | Tampermonkey | ⚠️ Limited | Not recommended |

### Why Firefox is Recommended

[Firefox for Android](https://www.mozilla.org/firefox/browsers/mobile/android/) is the most reliable option because:

- ✅ **Official extension support**: Native support for [Tampermonkey](https://addons.mozilla.org/en-US/android/addon/tampermonkey/) and [Violentmonkey](https://addons.mozilla.org/en-US/android/addon/violentmonkey/)
- ✅ **Actively maintained**: Regular updates from Mozilla
- ✅ **No workarounds needed**: Extensions work out of the box
- ✅ **Better privacy**: Open-source and privacy-focused
- ✅ **Stable performance**: Reliable userscript execution

### Kiwi Browser Considerations

[Kiwi Browser](https://kiwibrowser.com/) was popular for Chrome extension support but has limitations:

- ⚠️ **Discontinued**: [Officially unmaintained since January 2025](https://www.quetta.net/blog/the-best-alternatives-to-kiwi-browser)
- ⚠️ **Requires workarounds**: Developer mode needed for Tampermonkey
- ⚠️ **Best with ViolentMonkey**: [Recommended extension for Kiwi](https://yunharla.wixsite.com/softwaremmm/post/user-scripting-in-browser-in-android)

---

## Method 1: Firefox for Android (Recommended)

### Step 1: Install Firefox for Android

1. Open **Google Play Store** on your Android device
2. Search for "**Firefox Browser**"
3. Install **Firefox Browser** (by Mozilla)
4. Open Firefox and complete the initial setup

### Step 2: Install a Userscript Manager

Choose either Tampermonkey or Violentmonkey:

#### Option A: Violentmonkey (Open Source, Lightweight)

1. Open Firefox on Android
2. Tap the **menu button** (three dots) → **Add-ons**
3. Search for "**Violentmonkey**"
4. Tap **Violentmonkey** → **Add to Firefox**
5. Tap **Add** to confirm installation

**Direct link**: [Violentmonkey for Firefox Android](https://addons.mozilla.org/en-US/android/addon/violentmonkey/)

#### Option B: Tampermonkey (Feature-Rich)

1. Open Firefox on Android
2. Tap the **menu button** (three dots) → **Add-ons**
3. Search for "**Tampermonkey**"
4. Tap **Tampermonkey** → **Add to Firefox**
5. Tap **Add** to confirm

**Direct link**: [Tampermonkey for Firefox Android](https://addons.mozilla.org/en-US/android/addon/tampermonkey/)

**Which to choose?**
- **Violentmonkey**: [Faster, open-source, simpler interface](https://www.androidauthority.com/userscripts-android-firefox-violentmonkey-3610727/)
- **Tampermonkey**: [More features, cloud sync, better for power users](https://www.ghacks.net/2023/02/19/firefox-for-android-adds-tampermonkey-support/)

### Step 3: Install Lianki Userscript

1. In Firefox, visit: **https://www.lianki.com/lianki.user.js**
2. Your userscript manager will detect the script automatically
3. Tap **Install** when prompted
4. Confirm the installation

**✅ Success!** Lianki is now installed on Firefox for Android.

---

## Method 2: Kiwi Browser

⚠️ **Note**: Kiwi Browser is unmaintained as of 2025. Use Firefox for better reliability.

### Step 1: Install Kiwi Browser

1. Open **Google Play Store**
2. Search for "**Kiwi Browser**"
3. Install **Kiwi Browser - Fast & Quiet**
4. Open Kiwi Browser

### Step 2: Enable Developer Mode

Kiwi Browser requires developer mode for extensions:

1. In Kiwi Browser, type in address bar: `chrome://extensions/`
2. Tap the **menu** (three dots in top right)
3. Enable **Developer mode**

### Step 3: Install ViolentMonkey

1. In Kiwi Browser, visit: [Chrome Web Store](https://chrome.google.com/webstore/category/extensions)
2. Search for "**Violentmonkey**"
3. Tap **Add to Chrome**
4. Confirm installation

**Why not Tampermonkey on Kiwi?**
[ViolentMonkey works better with Kiwi Browser](https://yunharla.wixsite.com/softwaremmm/post/user-scripting-in-browser-in-android), while Tampermonkey has compatibility issues.

### Step 4: Install Lianki Userscript

1. Visit: **https://www.lianki.com/lianki.user.js**
2. ViolentMonkey will prompt you to install
3. Tap **Confirm installation**

---

## Installing the Lianki Userscript

Regardless of browser/manager combination:

### Installation Steps

1. **Navigate to Lianki**:
   ```
   https://www.lianki.com/lianki.user.js
   ```

2. **Automatic Detection**:
   - Your userscript manager will detect the script
   - A popup will appear asking to install

3. **Review Permissions**:
   - The script needs access to `*://*/*` (all websites) to add cards from any page
   - Connects to `lianki.com`, `www.lianki.com`, `beta.lianki.com`

4. **Confirm Installation**:
   - Tap **Install** or **Confirm installation**
   - Wait for confirmation message

5. **Verify Installation**:
   - Open your userscript manager
   - Check that "Lianki" is listed and enabled

---

## Using Lianki on Android

### Adding Your First Card

1. **Browse to any webpage** you want to remember
2. **Tap the menu** (three dots) in your browser
3. **Open Lianki**:
   - Violentmonkey: Tap extension icon → Lianki
   - Tampermonkey: Tap extension icon → Lianki

   Or use the keyboard shortcut: **Alt+F** (if your keyboard supports it)

4. **Add the page**:
   - Tap the floating **Lianki button** (if visible)
   - Or type `javascript:` in address bar and select Lianki

5. **Confirm**:
   - The dialog will show "Adding note..."
   - Success message will appear

### Reviewing Cards

1. **Visit Lianki Dashboard**:
   ```
   https://www.lianki.com/list
   ```

2. **Start Review**:
   - Tap "**Next card**" button
   - Or visit: `https://www.lianki.com/next`

3. **Review with Touch**:
   - Tap buttons: **Again** / **Hard** / **Good** / **Easy**

4. **Keyboard Shortcuts** (if you have a physical keyboard):
   - `H` or `4`: Easy
   - `J` or `3`: Good
   - `L` or `1`: Again
   - `M` or `5`: Delete
   - `Escape`: Close dialog

### Mobile-Friendly Tips

- **Tap the floating button**: Lianki adds a floating action button for easy access
- **Use landscape mode**: Better for reading long articles
- **Enable dark mode**: Easier on the eyes (Firefox Settings → Theme)
- **Pin Lianki tab**: Keep the `/list` page open for quick access

---

## Troubleshooting

### Extension Not Showing

**Problem**: Userscript manager extension not visible

**Firefox Solution**:
1. Tap menu (⋮) → **Add-ons**
2. Check that Tampermonkey/Violentmonkey is **enabled**
3. Restart Firefox if needed

**Kiwi Solution**:
1. Go to `chrome://extensions/`
2. Verify **Developer mode** is enabled
3. Check extension is enabled

### Script Not Running

**Problem**: Lianki doesn't appear on pages

**Solutions**:
1. Open userscript manager
2. Find "Lianki" in script list
3. Ensure it's **enabled** (toggle switch)
4. Check script version matches latest (v2.19.3 as of Feb 2026)
5. Try reinstalling from https://www.lianki.com/lianki.user.js

### Floating Button Not Visible

**Problem**: Can't find Lianki button on pages

**Solutions**:
1. Try scrolling - button may be below fold
2. Use Alt+F keyboard shortcut (if available)
3. Access through userscript manager icon
4. Check if site's CSS conflicts (Shadow DOM should prevent this)

### Login Issues

**Problem**: Can't sign in to Lianki

**Solutions**:
1. Clear browser cache and cookies
2. Try signing in at https://www.lianki.com first
3. Use Email magic link instead of OAuth on mobile
4. Ensure cookies are enabled in browser settings

### Sync Not Working

**Problem**: Cards don't sync between desktop and mobile

**Solutions**:
1. Verify you're signed in with the same account
2. Check internet connection
3. Force refresh on mobile: Pull down on `/list` page
4. Sign out and sign back in

---

## Frequently Asked Questions

### Does Lianki work offline on Android?

**Partially**. Once logged in:
- ✅ Installed userscript works offline
- ✅ Can review cards already loaded
- ❌ Cannot sync new cards without internet
- ❌ Cannot add new cards without internet

### Can I use Lianki on Android tablets?

**Yes!** The same installation process works on Android tablets. Firefox for Android works excellently on tablets with better screen real estate.

### Which userscript manager is better for Android?

**Violentmonkey** is recommended for most users:
- Lightweight and fast
- [Open source and transparent](https://www.androidauthority.com/userscripts-android-firefox-violentmonkey-3610727/)
- Works well on mobile devices
- Free with no limitations

**Tampermonkey** is better if you need:
- Cloud sync across devices
- Advanced script management features
- Editor with syntax highlighting

### Can I use Chrome on Android?

**No.** Google Chrome for Android does not support extensions or userscripts. You must use Firefox, Kiwi, or another Chromium-based browser with extension support.

### Does the floating button interfere with websites?

The Lianki floating button uses **Shadow DOM** (as of v2.19.2) to completely isolate itself from page CSS. It won't interfere with website functionality and maintains consistent appearance across all sites.

### How do I update the Lianki script on Android?

Userscript managers check for updates automatically:

**Violentmonkey**:
1. Tap extension icon
2. Tap **Dashboard**
3. Find Lianki → tap **⋮** → **Check for updates**

**Tampermonkey**:
1. Tap extension icon
2. Tap **Dashboard**
3. Updates check automatically (configurable interval)

Or manually reinstall from https://www.lianki.com/lianki.user.js

### Can I use multiple userscripts on Android?

**Yes!** Both Tampermonkey and Violentmonkey support multiple userscripts. You can install Lianki alongside other scripts like:
- Dark Reader (dark mode for websites)
- Bypass Paywalls
- YouTube improvements
- Reddit enhancements

### Is my data safe using userscripts on mobile?

**Yes**, when following best practices:
- ✅ Only install scripts from **trusted sources** (like lianki.com)
- ✅ Review script permissions before installing
- ✅ Use **open-source** managers (Violentmonkey)
- ✅ Keep scripts updated to latest versions
- ⚠️ Avoid installing random scripts from unknown sites

Lianki is **open source** and only requests necessary permissions:
- Access to all websites (to add cards from any page)
- Connection to lianki.com servers (for sync)

### Does Lianki drain battery on Android?

**Minimal impact**. The userscript only runs when:
- You actively browse pages (for the floating button)
- You open the Lianki dialog

It does not run in the background when the browser is closed.

---

## Performance Tips for Android

### Optimize Firefox for Lianki

1. **Enable tracking protection**: Settings → Privacy → Standard/Strict
2. **Use dark theme**: Saves battery on AMOLED screens
3. **Limit open tabs**: Close unused tabs for better performance
4. **Clear cache regularly**: Settings → Delete browsing data

### Save Mobile Data

1. **Prefetch cards**: Open `/list` on WiFi to cache cards
2. **Review offline**: Cards load quickly from cache
3. **Disable auto-sync**: Only sync when needed
4. **Use data saver**: Firefox Settings → Data Saver

### Battery Optimization

1. **Close Lianki dialog** when not reviewing
2. **Don't keep `/next` page open** in background
3. **Use Firefox power-saving mode**
4. **Disable unnecessary userscripts** on mobile

---

## Next Steps

Now that you have Lianki installed on Android:

1. **Sign in** to your account at https://www.lianki.com
2. **Add your first card** from any webpage
3. **Review daily** using the `/next` page
4. **Explore shortcuts** for faster reviews
5. **Join the community** for tips and support

### Related Guides

- [Browser Installation Guide](./2025-02-22-browser-installation-guide.md) - Desktop browser setup
- [iOS Installation Guide](./2025-02-23-ios-installation-guide.md) - iPhone and iPad setup
- [FSRS Algorithm](./2025-01-15-fsrs-algorithm.md) - How spaced repetition works

---

## Get Help

Having trouble? We're here to help:

- 🐛 **Report bugs**: [GitHub Issues](https://github.com/snomiao/lianki/issues)
- 💬 **Ask questions**: [GitHub Discussions](https://github.com/snomiao/lianki/discussions)
- 📧 **Contact us**: Via the [contact form](https://www.lianki.com/contact)
- 📖 **Documentation**: [Lianki Docs](https://www.lianki.com)

---

## Summary

Using Lianki on Android is straightforward with the right browser setup:

1. ✅ **Install Firefox for Android** (recommended) or Kiwi Browser
2. ✅ **Add Violentmonkey or Tampermonkey** extension
3. ✅ **Install Lianki userscript** from lianki.com
4. ✅ **Start reviewing** cards on the go!

The mobile experience is fully functional with all desktop features available on your Android device. Happy learning! 🎓📱

---

## Sources

This guide was researched using the following sources (February 2026):

- [Violentmonkey for Firefox Android](https://addons.mozilla.org/en-US/android/addon/violentmonkey/)
- [Tampermonkey for Firefox Android](https://addons.mozilla.org/en-US/android/addon/tampermonkey/)
- [Tampermonkey FAQ - Android Support](https://www.tampermonkey.net/faq.php?locale=en)
- [Firefox for Android Tampermonkey Support](https://www.ghacks.net/2023/02/19/firefox-for-android-adds-tampermonkey-support/)
- [Userscripts on Android with Violentmonkey](https://www.androidauthority.com/userscripts-android-firefox-violentmonkey-3610727/)
- [Kiwi Browser Status in 2025](https://www.quetta.net/blog/the-best-alternatives-to-kiwi-browser)
- [ViolentMonkey for Kiwi Browser Guide](https://yunharla.wixsite.com/softwaremmm/post/user-scripting-in-browser-in-android)
- [Tampermonkey for Android - OpenUserJS](https://openuserjs.org/about/Tampermonkey-for-Android)
- [Best Tampermonkey Alternatives 2026](https://alternativeto.net/software/tampermonkey/)

---

*Last updated: February 25, 2026*
