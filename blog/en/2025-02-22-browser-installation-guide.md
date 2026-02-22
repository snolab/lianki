---
title: "Installing Lianki on Desktop Browsers: Complete Setup Guide"
date: 2025-02-22
tags: [installation, userscript, scriptcat, violentmonkey, tampermonkey, chrome, edge, browser]
summary: "Step-by-step guide to install Lianki on Chrome/Edge desktop browsers using ScriptCat, Violentmonkey, or Tampermonkey."
---

# Installing Lianki on Desktop Browsers: Complete Setup Guide

Lianki works through a userscript that runs in your browser, adding a floating button to every page you visit. To use it, you'll need two things:

1. **A userscript manager extension** (ScriptCat, Violentmonkey, or Tampermonkey)
2. **The Lianki userscript** itself

This guide covers installation on **Chrome and Edge desktop browsers**. The process takes about 2-3 minutes.

---

## Step 1: Choose Your Userscript Manager

A userscript manager is a browser extension that runs userscripts — small JavaScript programs that enhance websites. You need one installed before you can use Lianki.

### Which One Should You Choose?

We recommend them in this order:

1. **ScriptCat** (Recommended) — Modern, fast, good privacy defaults
2. **Violentmonkey** — Open source, lightweight, respects user privacy
3. **Tampermonkey** — Most popular, feature-rich, but includes some telemetry

**For most users**: Install **ScriptCat**. It has the best balance of performance, privacy, and compatibility.

**Already have one installed?** You can skip to [Step 2](#step-2-install-the-lianki-userscript).

---

## Step 2: Install Your Userscript Manager

### Option A: ScriptCat (Recommended)

**Chrome users:**
1. Open the [ScriptCat page on Chrome Web Store](https://chrome.google.com/webstore/detail/scriptcat/ndcooeababalnlpkfedmmbbbgkljhpjf)
2. Click **Add to Chrome**
3. Click **Add extension** in the popup

**Edge users:**
1. Open the [ScriptCat page on Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/scriptcat/liilgpjgabokdklappibcjfablkpcekh)
2. Click **Get**
3. Click **Add extension** in the popup

After installation, you'll see a cat icon (🐱) in your browser toolbar.

### Option B: Violentmonkey

**Chrome users:**
1. Open the [Violentmonkey page on Chrome Web Store](https://chrome.google.com/webstore/detail/violentmonkey/jinjaccalgkegednnccohejagnlnfdag)
2. Click **Add to Chrome**
3. Click **Add extension** in the popup

**Edge users:**
1. Open the [Violentmonkey page on Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/violentmonkey/eeagobfjdenkkddmbclomhiblgggliao)
2. Click **Get**
3. Click **Add extension** in the popup

After installation, you'll see a monkey icon in your browser toolbar.

### Option C: Tampermonkey

**Chrome users:**
1. Open the [Tampermonkey page on Chrome Web Store](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
2. Click **Add to Chrome**
3. Click **Add extension** in the popup

**Edge users:**
1. Open the [Tampermonkey page on Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd)
2. Click **Get**
3. Click **Add extension** in the popup

After installation, you'll see a Tampermonkey icon in your browser toolbar.

---

## Step 2: Install the Lianki Userscript

Now that you have a userscript manager installed, you can add the Lianki userscript.

### Installation from Greasy Fork (Recommended)

Greasy Fork is a trusted repository for userscripts with automatic update notifications.

1. **Open the Lianki script page on Greasy Fork:**
   [https://greasyfork.org/ja/scripts/567089-lianki](https://greasyfork.org/ja/scripts/567089-lianki)

2. **Click the green "Install this script" button**
   (The button text may vary depending on your userscript manager)

3. **Review the installation page**
   Your userscript manager will open a new tab showing the script details and permissions.

4. **Click "Install" or "Confirm installation"**
   ScriptCat/Violentmonkey/Tampermonkey will show an install button — click it to complete installation.

5. **Done!** The Lianki script is now active.

### Alternative: Direct Installation

If you prefer to install directly from lianki.com:

1. Visit: [https://www.lianki.com/lianki.user.js](https://www.lianki.com/lianki.user.js)
2. Your userscript manager should detect the `.user.js` file and show an install prompt
3. Click **Install** to add the script

---

## Step 3: Verify Installation

After installing the Lianki userscript, you should see the floating action button (FAB) on every HTTPS webpage you visit.

### What to Expect

1. **Open any HTTPS website** (e.g., https://www.wikipedia.org)
2. Look for a **circular floating button** in the bottom-right corner of the page
3. The button should be **draggable** — try moving it around
4. Press **Alt+F** or click the button to open the Lianki dialog

If you see the floating button, congratulations! Lianki is installed and working.

### First Time Setup

1. Click the floating button or press **Alt+F**
2. If you're not logged in, you'll see a login prompt
3. Sign in to your Lianki account at [www.lianki.com](https://www.lianki.com)
4. Return to any webpage and try adding a card by pressing **Alt+F**

---

## Troubleshooting

### I don't see the floating button

**Check if the userscript manager is enabled:**
- Look for the ScriptCat/Violentmonkey/Tampermonkey icon in your browser toolbar
- Click it and make sure the extension is active (not paused)

**Check if the script is installed:**
- Click the userscript manager icon
- Open the dashboard or settings
- Look for "Lianki" in your installed scripts list
- Make sure it's enabled (toggle should be on)

**Check if you're on an HTTPS page:**
- The Lianki script only runs on `https://*` URLs
- It won't work on `http://` pages or local files (`file://`)
- Try visiting https://www.wikipedia.org to test

**Check browser permissions:**
- Some browsers block extensions on certain pages (browser settings, extension store pages)
- Try a regular website like Wikipedia or GitHub

### The script is installed but not working

**Clear browser cache:**
1. Press `Ctrl+Shift+Delete` (Windows/Linux) or `Cmd+Shift+Delete` (Mac)
2. Select "Cached images and files"
3. Click "Clear data"
4. Reload the page

**Reinstall the script:**
1. Open your userscript manager dashboard
2. Find "Lianki" in the list
3. Delete/remove it
4. Reinstall from [Greasy Fork](https://greasyfork.org/ja/scripts/567089-lianki)

**Check for script conflicts:**
- If you have many userscripts installed, try disabling others temporarily
- Some scripts may conflict with Lianki's floating button

### I get a "not authenticated" error

This means you're not logged in to Lianki.

**Solution:**
1. Open [https://www.lianki.com](https://www.lianki.com) in a new tab
2. Sign in with your account (email, GitHub, or Google)
3. Return to the page where you want to add a card
4. Press **Alt+F** again — it should work now

The userscript uses cookies to authenticate, so make sure your browser allows cookies from `lianki.com`.

### Updates aren't working

**Manual update check:**
1. Open your userscript manager dashboard
2. Find the "Lianki" script
3. Look for a "Check for updates" button or option
4. Click it to manually check for new versions

Userscript managers typically check for updates every 24 hours automatically. If you installed from Greasy Fork, updates are detected faster.

---

## Using Lianki

Now that Lianki is installed, here's how to use it:

### Adding a Card

1. Visit any webpage you want to remember
2. Press **Alt+F** or click the floating button
3. The title and URL are auto-filled
4. Click **Add** to save the card to your review queue

### Reviewing Cards

When a card is due for review:
1. Visit the card's URL (or Lianki will auto-redirect you)
2. The floating button will **glow** to indicate a review is due
3. Click it to open the review dialog
4. Rate your memory: **Again** (1), **Hard** (2), **Good** (3), or **Easy** (4)
5. Use keyboard shortcuts: `1/D/L`, `2/W/K`, `3/S/J`, `4/A/H`

The dialog shows the next review interval for each rating, so you can choose based on how well you remember the content.

### Keyboard Shortcuts

- **Alt+F** — Open Lianki dialog (add or review)
- **1, D, L** — Rate as "Again" (forgot it)
- **2, W, K** — Rate as "Hard" (barely remembered)
- **3, S, J** — Rate as "Good" (remembered well)
- **4, A, H** — Rate as "Easy" (trivial to remember)

The shortcuts support both WASD and HJKL layouts, plus numpad 1-4.

---

## Next Steps

- **Learn how the algorithm works**: [Understanding the FSRS Algorithm](/blog/2025-01-15-fsrs-algorithm)
- **Read the userscript deep dive**: [How the Lianki Userscript Works](/blog/2025-02-10-userscript)
- **Check your review queue**: [lianki.com/list](https://www.lianki.com/list)

---

## Why These Recommendations?

### Why ScriptCat over others?

- **Privacy-first**: No telemetry or tracking by default
- **Modern codebase**: Actively developed with good Chrome/Edge support
- **Fast**: Optimized performance for running many scripts
- **Good defaults**: Works well out of the box without configuration

### Why Violentmonkey over Tampermonkey?

- **Open source**: Fully transparent, community-audited code
- **No telemetry**: Doesn't send any data to external servers
- **Lightweight**: Smaller memory footprint than Tampermonkey
- **Privacy-focused**: Designed with user privacy as a core principle

### Why Tampermonkey still works

- **Largest user base**: Most popular userscript manager
- **Mature and stable**: Has been around the longest
- **Rich features**: More advanced settings and debugging tools
- **Wide compatibility**: Works on every major browser

The privacy tradeoff is that Tampermonkey includes some telemetry (update checks, usage stats). For most users, this isn't a concern, but if privacy is important to you, choose ScriptCat or Violentmonkey instead.

---

## Summary

1. **Install a userscript manager**: ScriptCat (recommended) or Violentmonkey or Tampermonkey
2. **Install the Lianki userscript**: [greasyfork.org/ja/scripts/567089-lianki](https://greasyfork.org/ja/scripts/567089-lianki)
3. **Verify it works**: Look for the floating button on any HTTPS page
4. **Start learning**: Press Alt+F to add your first card!

You're now ready to use Lianki for spaced repetition learning. Every page you want to remember is just one keyboard shortcut away.
