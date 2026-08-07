# TeeBoard mobile

Two things ship from the same source: an installable web app (PWA) that works
today, and native iOS/Android wrappers built with Capacitor.

There is no separate mobile codebase. `index.html`, `app.js` and `config.js`
are the app; Capacitor packages those exact files.

## What already works, with no build step

The site at teeboardgolf.com is installable:

- **iPhone** — Safari → Share → *Add to Home Screen*
- **Android** — Chrome offers *Install app*
- **Desktop** — install icon in the address bar

Installed, it opens full screen with no browser chrome, keeps its own icon,
and **works with no signal**.

### Offline scoring

Golf courses have terrible reception, so a lost connection must not cost
someone their card. Scores entered offline are stored on the phone and
replayed when the signal returns. The header shows an "Offline · N to sync"
pill while anything is pending.

Two details worth knowing:

- Correcting the same hole **replaces** the queued entry rather than stacking,
  so a flaky connection doesn't replay every keystroke.
- Only genuine network failures are retried. A rejection from the server —
  closed tournament, signed card — is surfaced immediately, because retrying
  it would block the queue forever.

The service worker never caches Supabase or Stripe. A stale leaderboard would
be worse than no leaderboard.

## Building the native apps

Requires **full Xcode** (not just Command Line Tools) and **CocoaPods** for
iOS, and **Android Studio** for Android.

```bash
npm install
npm run ios       # builds www/, syncs, opens Xcode
npm run android   # same, opens Android Studio
```

`npm run build` collects the static files into `www/`, which is what Capacitor
packages. The repo root stays plain static files so GitHub Pages keeps serving
the site directly.

### Icons

`npm run icons` regenerates the source icons with no dependencies — it encodes
the PNGs directly rather than pulling in a canvas library, so it runs anywhere
node does. `npx @capacitor/assets generate` then produces every native size
from `assets/icon.png`.

## Before submitting to the App Store

**Apple requires In-App Purchase for digital subscriptions consumed in an
app**, at 15–30%. TeeBoard sells a $30/month organizer subscription through
Stripe, so this needs a decision before submission:

1. **Ship without in-app purchasing.** Organizers who already subscribed on
   the web sign in and use everything; the app neither sells nor links to the
   subscription. This is the usual pattern for cross-platform SaaS.
2. **Add StoreKit** and let Apple take its cut on mobile sign-ups.

Rules on linking out to an external purchase changed after the 2025 Epic
ruling and differ by region, so check the current guidelines rather than
relying on any summary — including this one.

Players are unaffected either way: they never pay and never sign up, so the
player half of the app raises no IAP question at all.

### Also needed for submission

- Apple Developer account ($99/yr) and Google Play ($25 once)
- Privacy policy URL — https://teeboardgolf.com/#/privacy
- App Privacy disclosures: TeeBoard collects email and name for organizers,
  player names entered by organizers, and page views with no identifiers
- Screenshots per device size, and a support URL
