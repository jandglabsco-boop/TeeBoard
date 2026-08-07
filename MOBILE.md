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

To get a signed build **and have it land in TestFlight automatically**, create
one App Store Connect API key and add four repository secrets.

Xcode then issues and renews the certificate and provisioning profile itself.
There is no CSR to generate, no `.p12` to export, no profile to download, and
no Transporter step.

**Create the key** — [App Store Connect](https://appstoreconnect.apple.com/access/integrations/api)
→ *Users and Access* → *Integrations* → *App Store Connect API* → **+**

- Name it anything ("GitHub Actions")
- Role: **App Manager**
- Download the `.p8` — **Apple only lets you download it once**
- Note the **Key ID** and the **Issuer ID** shown on that page

**Add the secrets.** Easiest way — one command, from the repo root:

```bash
bash tools/setup-appstore-secrets.sh
```

It finds the `.p8` in your Downloads, reads the Key ID out of Apple's
filename, asks for the Issuer ID and Team ID, and sets all four secrets. The
key is piped straight from the file into GitHub — never printed, never put on
the clipboard, never copied elsewhere on disk.

Or do it by hand under *Settings → Secrets and variables → Actions*:

| Secret | Where it comes from |
|---|---|
| `APPSTORE_API_KEY_P8` | `openssl base64 -A -in AuthKey_XXXX.p8 \| pbcopy` |
| `APPSTORE_API_KEY_ID` | Key ID from that page |
| `APPSTORE_API_ISSUER_ID` | Issuer ID — top of the page, above the key list, not per-key |
| `APPSTORE_TEAM_ID` | 10 characters, top right of developer.apple.com |

Until those exist the workflow still passes and simply notes it built
unsigned — a missing key never masks a real compile error.

The key is written to the runner, used, and deleted in a cleanup step that
runs even if the build fails.

### What happens after that

Every push to `main` builds, signs, and uploads to App Store Connect. The
build shows up under **TestFlight** within about ten minutes, where you can
install it on your own phone and add your league as testers.

The `.ipa` is also kept as a workflow artifact, so you can still drag it into
Transporter by hand if you ever prefer.

You'll need the app record to exist first: App Store Connect → *My Apps* → **+**
→ *New App*, with bundle ID `com.jandglabs.teeboard`.

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
