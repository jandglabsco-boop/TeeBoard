# TeeBoard

Live scoring and leaderboards for scrambles and small tournaments — built for a weekly 4-player league, works for anyone.

Plain HTML/JS front end (`index.html`, `app.js`, `config.js`) backed by [Supabase](https://supabase.com) (free tier) for the database and live sync. No build step, no server to run — it's static files plus a database.

## How it works

- **Course/organizer** opens the site, taps **Create a Tournament** — this needs a free organizer account (sign up with email + password, right there in the flow) so only you can manage what you create. Then search for your course (real par-by-hole data auto-fills from [OpenGolfAPI](https://opengolfapi.org), free & keyless), and get a 5-character join code (and a QR code) to share.
- **Players never need an account.** They open the site (link, QR code, or bookmark), tap **Join a Tournament**, enter the code, then either create a team (gets a 4-character team code to share with teammates) or join an existing team with that code.
- **Organizers can also skip manual sign-ups**: upload a CSV roster from the admin dashboard (columns `team`, `player`, or just a list of names) to bulk-create teams ahead of time, then hand out each team's code.
- Any player on a team can enter that team's scramble score per hole from their own phone — one shared scorecard per team.
- Anyone with the tournament link can open **Leaderboard** — no login needed — and watch it update live as scores come in.

Players: access is by knowing the code, same as a real scorecard. Organizers: real Supabase-backed accounts, so only the person who created a tournament can close it or import a roster into it.

## 1. Create your Supabase project (5 min, free)

1. Go to [supabase.com](https://supabase.com) → sign up → **New project**.
2. Pick a name/password/region, wait ~2 min for it to spin up.
3. In the left sidebar, open **SQL Editor** → **New query**, paste the contents of `schema.sql` from this folder, and run it. This creates the tables, turns on live updates, and sets up organizer accounts (email/password sign-up is on by default in every Supabase project — nothing extra to enable).
   - **Already set up TeeBoard before this file had the migration block at the bottom?** Just run that bottom block again (it's safe to re-run) to add accounts to your existing project.
4. In the left sidebar, open **Project Settings → API**. Copy the **Project URL** and the **anon public** key.
5. *(Optional, recommended for a casual league)* Under **Authentication → Sign In / Providers → Email**, turn off **"Confirm email"** so organizers can sign up and start creating tournaments immediately, without waiting on a confirmation email. Leave it on if you'd rather have that extra check.

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
| `index.html` | Page shell + the whole design system (CSS variables and components), loads Tailwind, Supabase JS, QR code library |
| `app.js` | All app logic: routing, create/join flow, scorecard, live leaderboard |
| `config.js` | Your Supabase URL + key (only file you edit to connect it) |
| `schema.sql` | Database tables + realtime + access policies — run once in Supabase |

## Design notes

The look is "tour broadcast": near-black panels with condensed caps for anything
scoreboard-ish, plain high-contrast light surfaces for anything you have to read
or tap outdoors in the sun.

Worth knowing before you change colours:

- **Under par is red, not green.** `--under` is used for negative scores and for
  birdie circles, because that's how golf leaderboards have shown it for decades.
  Green (`--grass-*`) is the brand and interaction colour, never a score colour.
- **Red vs green status pills.** A red `LIVE` pill means scoring is happening
  right now (a broadcast live bug). A green `OPEN` pill means a tournament is
  accepting entries. They mean different things — don't merge them.
- **Two typefaces.** `Barlow Condensed` for numbers, scores, and small caps
  labels; `Archivo` for everything you read as prose. Numbers use tabular
  figures so columns of scores stay aligned.
- **Scorecards use real card notation.** Circle a birdie, double-circle an
  eagle, square a bogey, double-square anything worse — see `holeMarkClass()`
  and `scorecardGridHtml()` in `app.js`. Cards split into nines with OUT/IN
  totals so 18 holes fit a phone without sideways scrolling.

All tokens live in the `:root` block at the top of `index.html`; changing a
variable there restyles the whole app.

## Notes on the MVP scope

- **Scramble format**: one team score per hole (not per-player strokes). Best-ball or stroke-play-per-player would need a small schema change — ask if you want that next.
- **Organizer accounts, no player login**: creating/managing a tournament needs a Supabase Auth account (email + password); joining and scoring doesn't — players just type a name, and "my team" is remembered on that phone via browser storage.
- **No password reset flow built in yet.** If an organizer forgets their password, they'd need to reset it from the Supabase dashboard (Authentication → Users) for now.
- **Tournaments created before accounts existed** (created_by is empty) stay manageable by anyone with the admin link, so nothing you already made breaks.
- **Par defaults to 4** on every hole if you don't enter your course's actual pars when creating the tournament (or the course search comes up empty — not every course is in OpenGolfAPI's database yet).
- **Realtime + 15s fallback polling** on the leaderboard, since course wifi/cell signal can be spotty.
- **CSV import** matches teams by exact name if you re-upload (won't duplicate), and only supports the scramble one-score-per-team-per-hole model — not per-player rosters with individual handicaps.

## Ideas for next iterations

- Individual (non-scramble) stroke play and net/handicap scoring
- Season-long standings across multiple Thursday nights
- Photos/highlights per hole, side games (closest to pin, skins)
- Password reset flow, and optional player accounts + push notifications ("you're up!" or "you just took the lead")
