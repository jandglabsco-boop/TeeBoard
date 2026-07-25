# TeeBoard

Live scoring and leaderboards for scrambles and small tournaments — built for a weekly 4-player league, works for anyone.

Plain HTML/JS front end (`index.html`, `app.js`, `config.js`) backed by [Supabase](https://supabase.com) (free tier) for the database and live sync. No build step, no server to run — it's static files plus a database.

## How it works

- **Course/organizer** opens the site, taps **Create a Tournament**, sets holes and par, gets a 5-character join code (and a QR code) to share.
- **Players** open the site (link, QR code, or bookmark), tap **Join a Tournament**, enter the code, then either create a team (gets a 4-character team code to share with teammates) or join an existing team with that code.
- Any player on a team can enter that team's scramble score per hole from their own phone — one shared scorecard per team.
- Anyone with the tournament link can open **Leaderboard** — no login needed — and watch it update live as scores come in.

No passwords. Access is by knowing the code, same as a real scorecard — appropriate for a casual private league, not for anything sensitive.

## 1. Create your Supabase project (5 min, free)

1. Go to [supabase.com](https://supabase.com) → sign up → **New project**.
2. Pick a name/password/region, wait ~2 min for it to spin up.
3. In the left sidebar, open **SQL Editor** → **New query**, paste the contents of `schema.sql` from this folder, and run it. This creates the tables and turns on live updates.
4. In the left sidebar, open **Project Settings → API**. Copy the **Project URL** and the **anon public** key.

## 2. Configure the app

Open `config.js` and paste in the two values:

```js
window.TEEBOARD_CONFIG = {
  SUPABASE_URL: "https://xxxxxxxx.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOi...",
};
```

## 3. Run it locally to try it out

From this folder:

```
python3 -m http.server 8000
```

Then open `http://localhost:8000` in your browser (or your phone, if it's on the same wifi — use your computer's local IP instead of `localhost`).

## 4. Put it online so it works from any phone

Any static host works. Easiest options:

- **Netlify Drop**: go to [app.netlify.com/drop](https://app.netlify.com/drop) and drag this whole folder in. You get a public URL instantly, no account needed to try it (free account to keep it permanently).
- **Vercel**: `npx vercel` from this folder (needs a free Vercel account).
- **GitHub Pages**: push this folder to a repo and enable Pages in repo settings.

Once it's live, that URL is what you share, print on a card, or turn into a QR code at the pro shop.

### Make it feel like an app

Once it's hosted, players can open it in their phone browser and use **Add to Home Screen** (Safari/Chrome) to get an icon on their home screen that opens straight to the site, full-screen, no browser bar. That covers "join via the app" without needing an App Store submission. A true native iOS/Android app is a bigger separate project (Xcode/Android Studio, app store accounts, review time) — this gets you 90% of the feel today.

## Files

| File | Purpose |
|---|---|
| `index.html` | Page shell, loads Tailwind (styling), Supabase JS, QR code library |
| `app.js` | All app logic: routing, create/join flow, scorecard, live leaderboard |
| `config.js` | Your Supabase URL + key (only file you edit to connect it) |
| `schema.sql` | Database tables + realtime + access policies — run once in Supabase |

## Notes on the MVP scope

- **Scramble format**: one team score per hole (not per-player strokes). Best-ball or stroke-play-per-player would need a small schema change — ask if you want that next.
- **No formal login**: players just type a name; "my team" is remembered on that phone via browser storage. Good enough for a weekly league; swappable for real accounts (Supabase Auth) later if you open this up more broadly.
- **Par defaults to 4** on every hole if you don't enter your course's actual pars when creating the tournament.
- **Realtime + 15s fallback polling** on the leaderboard, since course wifi/cell signal can be spotty.

## Ideas for next iterations

- Individual (non-scramble) stroke play and net/handicap scoring
- Season-long standings across multiple Thursday nights
- Photos/highlights per hole, side games (closest to pin, skins)
- Real accounts + push notifications ("you're up!" or "you just took the lead")
