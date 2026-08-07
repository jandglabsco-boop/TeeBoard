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

## Building without Xcode (GitHub Actions)

`.github/workflows/mobile.yml` builds both apps on GitHub's runners, which
have Xcode preinstalled. Push to `main`, or trigger it from the **Actions**
tab.

It always does two things with no setup at all:

- **iOS** — compiles unsigned, proving the app builds
- **Android** — produces a **debug APK** you can download and install on any
  Android phone immediately

To get a signed `.ipa` for the App Store, add these repository secrets under
*Settings → Secrets and variables → Actions*:

| Secret | What it is |
|---|---|
| `IOS_CERTIFICATE_P12` | Apple Distribution certificate, exported as .p12, base64-encoded |
| `IOS_CERTIFICATE_PASSWORD` | the password you set when exporting it |
| `IOS_PROVISIONING_PROFILE` | App Store provisioning profile, base64-encoded |
| `IOS_PROVISIONING_PROFILE_NAME` | its name exactly as shown in the Apple Developer portal |
| `IOS_TEAM_ID` | your 10-character Apple Team ID |

Base64-encode a file with:

```bash
base64 -i Certificates.p12 | pbcopy
```

Until those exist the workflow still passes and simply notes that it built
unsigned — a missing certificate never masks a real compile error.

### Getting it to the App Store

1. Run the workflow, download the **TeeBoard-ios-ipa** artifact
2. Open **Transporter** (free, Mac App Store), sign in, drag the `.ipa` in
3. Deliver — it appears in App Store Connect under TestFlight within minutes

The signing certificate and provisioning profile have to be created once in
the Apple Developer portal. They're credentials, so that part is yours.

## Building the native apps locally

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

**The native build ships with no purchasing at all.** `IS_NATIVE_APP` in
`app.js` is true only inside the Capacitor wrapper, and it removes the
pricing panel, the trial countdown, the Billing menu entry and the Subscribe
button. An organizer whose plan has lapsed is told their account isn't
active — with no price, no purchase and no link out.

That is deliberate: Apple requires In-App Purchase for digital subscriptions
consumed in an app, at 15–30%. Selling nothing in the app keeps it out of
that rule entirely. Organizers subscribe on the web and sign in here.

Players are unaffected — they never pay and never sign up.

If you later decide to sell inside the app, that means adding StoreKit and
accepting Apple's cut. Don't add a link to the website checkout instead:
that's the thing the guideline is aimed at, and the rules around it shifted
after the 2025 Epic ruling and vary by region.

### Also needed for submission

- Apple Developer account ($99/yr) and Google Play ($25 once)
- Privacy policy URL — https://teeboardgolf.com/#/privacy
- App Privacy disclosures: TeeBoard collects email and name for organizers,
  player names entered by organizers, and page views with no identifiers
- Screenshots per device size, and a support URL
