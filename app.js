// TeeBoard app logic. Plain JS, no build step. Talks directly to Supabase.

// Snapshot the URL before the Supabase client exists: with detectSessionInUrl
// on (the default) it consumes and clears #access_token= during startup, so by
// the time our own callback handler runs the evidence is gone.
const ENTRY_URL = { hash: location.hash, search: location.search };

const CFG = window.TEEBOARD_CONFIG || {};
const CONFIGURED = CFG.SUPABASE_URL && !CFG.SUPABASE_URL.includes("YOUR_SUPABASE_URL_HERE");
const sb = CONFIGURED ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY) : null;

// True only inside the Capacitor iOS/Android wrapper. Apple requires digital
// subscriptions consumed in an app to go through In-App Purchase, so the
// native build ships with no purchasing, no pricing and no links out to buy —
// organizers subscribe on the web and simply sign in here. Players are
// unaffected: they never pay.
const IS_NATIVE_APP = !!(
  typeof window !== "undefined" &&
  window.Capacitor &&
  typeof window.Capacitor.isNativePlatform === "function" &&
  window.Capacitor.isNativePlatform()
);

const app = document.getElementById("app");
const headerSub = document.getElementById("header-sub");

// A recovery link signs the user in like any other magic link, so without
// this flag we'd just drop them on the home page with no way to actually
// change their password. PKCE links carry no "type" in the URL, so the auth
// event is the only reliable signal — it has to be subscribed before the
// client finishes processing the URL.
let isPasswordRecovery = false;
// Declared up here because the auth listener below clears it, and that
// listener can fire synchronously while the client initialises.
let adminIsAdmin = null;
if (sb) {
  sb.auth.onAuthStateChange((event) => {
    if (event === "PASSWORD_RECOVERY") isPasswordRecovery = true;
    // Whoever is signed in has changed, so a cached "is this an admin" answer
    // now belongs to somebody else.
    if (event === "SIGNED_IN" || event === "SIGNED_OUT") adminIsAdmin = null;
  });
}

// ---------- small utilities ----------

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I to avoid confusion
function genCode(len) {
  let s = "";
  for (let i = 0; i < len; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function toParLabel(toPar) {
  if (toPar === 0) return "E";
  // Real minus sign (U+2212), not a hyphen — it matches the digit width in
  // tabular figures so columns of scores stay aligned.
  return toPar > 0 ? `+${toPar}` : `−${Math.abs(toPar)}`;
}

// Broadcast convention: under par is red, even/over is ink. Every golf
// leaderboard on TV reads this way, so the colour carries meaning before
// anyone parses the number.
function toParClass(toPar) {
  if (toPar < 0) return "under";
  return toPar === 0 ? "even" : "over";
}

// Internal hole numbers always run 1..num_holes (that's what's stored on
// scores.hole_number and what indexes the par/handicap arrays). What's
// displayed to people should reflect the real course hole, e.g. a back-nine
// 9-hole round starts at hole 10. tournament.start_hole (default 1) carries
// that offset.
function holeLabel(tournament, internalHole) {
  return (tournament.start_hole || 1) + internalHole - 1;
}

// ---------- inline icon set (no emoji, no icon-font dependency) ----------
// 24x24 grid, 1.75 stroke, drawn to sit on the dark icon tiles.
const ICONS = {
  flag: `<path d="M6 21V4M6 4l11 3.5L6 11" /><path d="M4 21h5" />`,
  trophy: `<path d="M7 4h10v5a5 5 0 0 1-10 0V4Z" /><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3" /><path d="M12 14v4M9 21h6" />`,
  board: `<rect x="3" y="4" width="18" height="14" rx="2" /><path d="M3 9h18M3 13.5h18M12 18v3M9 21h6" />`,
  card: `<rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M8 9v11" />`,
  arrow: `<path d="M5 12h13M13 6l6 6-6 6" />`,
  check: `<path d="M4 12.5 9 17.5 20 6.5" />`,
  qr: `<rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3h-3zM20 14v3M14 20h3M20 20h1" />`,
  users: `<path d="M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20" /><circle cx="9" cy="7" r="3.5" /><path d="M22 20v-1.5a4 4 0 0 0-3-3.87" /><path d="M16.5 3.6a3.5 3.5 0 0 1 0 6.8" />`,
  plus: `<path d="M12 5v14M5 12h14" />`,
  lock: `<rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" />`,
};

function icon(name, size = 20, extra = "") {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"
    class="${extra}" aria-hidden="true">${ICONS[name] || ""}</svg>`;
}

// Shared loading state — a shaped skeleton rather than the word "Loading…",
// so the page doesn't visibly jump when real content lands.
function loadingHtml() {
  return `
    <div class="mt-2" aria-busy="true" aria-label="Loading">
      <div class="skeleton-line w-1/3 mb-3" style="height:.8rem"></div>
      <div class="skeleton-line mb-2" style="height:5rem"></div>
      <div class="skeleton-line mb-2" style="height:3.5rem"></div>
      <div class="skeleton-line" style="height:3.5rem"></div>
    </div>`;
}

// Consistent "we couldn't find that" panel.
function notFoundHtml(what) {
  return `
    <div class="card p-6 mt-4 text-center">
      <div class="eyebrow mb-2">404</div>
      <p class="font-bold mb-1">${escapeHtml(what)} not found</p>
      <p class="text-sm muted mb-4">That link or code may have expired, or the tournament was deleted.</p>
      <a href="#/" class="btn-secondary">Back to start</a>
    </div>`;
}

// Classic scorecard marks: circle a birdie (double-circle an eagle+), square
// a bogey (double-square a double-bogey+). Used anywhere a hole's strokes
// are shown read-only.
function holeMarkClass(strokes, par) {
  if (strokes == null || !par) return "";
  const diff = strokes - par;
  if (diff <= -2) return "eagle";
  if (diff === -1) return "birdie";
  if (diff === 1) return "bogey";
  if (diff >= 2) return "double-bogey";
  return "";
}

// Renders a real scorecard grid — holes across the top, par and score
// beneath, OUT/IN/TOTAL columns — instead of a vertical list of rows. Splits
// into nines so 18 holes still fit a phone without sideways scrolling.
// `startHole` shifts the printed hole numbers to the real course holes (a
// back-nine round prints 10–18); the internal 1..n numbering used for lookups
// is unchanged. `yardage` and `handicap` are optional per-hole arrays — each
// gets its own row only when present, so a tournament with no course data
// still renders a clean HOLE/PAR/SCORE card.
function scorecardGridHtml(par, scoreMap, startHole = 1, yardage = null, handicap = null) {
  const hasYds = Array.isArray(yardage) && yardage.length === par.length;
  const hasHcp = Array.isArray(handicap) && handicap.length === par.length;
  const nines = [];
  for (let i = 0; i < par.length; i += 9) nines.push({ start: i, pars: par.slice(i, i + 9) });

  const totalLabel = (idx) => (par.length <= 9 ? "TOT" : idx === 0 ? "OUT" : idx === 1 ? "IN" : "TOT");

  const blocks = nines.map((nine, idx) => {
    // internal hole numbers, used to read par/scores
    const holeNums = nine.pars.map((_, j) => nine.start + j + 1);
    // what gets printed in the header row
    const printed = holeNums.map((h) => startHole + h - 1);
    const parSum = nine.pars.reduce((a, b) => a + b, 0);
    const played = holeNums.filter((h) => scoreMap[h] != null);
    const scoreSum = played.reduce((a, h) => a + scoreMap[h], 0);

    return `
      <table class="card-grid">
        <thead>
          <tr>
            <th class="lbl" style="width:2.7rem">Hole</th>
            ${printed.map((h) => `<th>${h}</th>`).join("")}
            <th class="tot" style="width:2.4rem">${totalLabel(idx)}</th>
          </tr>
        </thead>
        <tbody>
          ${hasYds ? `
            <tr class="yds-row">
              <td class="lbl">Yds</td>
              ${holeNums.map((h) => `<td>${yardage[h - 1] ?? "–"}</td>`).join("")}
              <td class="tot">${holeNums.reduce((a, h) => a + (yardage[h - 1] || 0), 0)}</td>
            </tr>` : ""}
          <tr class="par-row">
            <td class="lbl">Par</td>
            ${nine.pars.map((p) => `<td>${p}</td>`).join("")}
            <td class="tot">${parSum}</td>
          </tr>
          ${hasHcp ? `
            <tr class="hcp-row">
              <td class="lbl">Hcp</td>
              ${holeNums.map((h) => `<td>${handicap[h - 1] ?? "–"}</td>`).join("")}
              <td class="tot"></td>
            </tr>` : ""}
          <tr>
            <td class="lbl">Score</td>
            ${holeNums.map((h, j) => `
              <td style="padding:.3rem 0">
                <span class="hole-mark hole-mark-sm ${holeMarkClass(scoreMap[h], nine.pars[j])}">${scoreMap[h] ?? "·"}</span>
              </td>`).join("")}
            <td class="tot">${played.length ? scoreSum : "–"}</td>
          </tr>
        </tbody>
      </table>`;
  });

  return blocks.join(`<div style="height:1px;background:var(--line-2)"></div>`);
}

// ---------- formats ----------
// scoring: "team"   = one score per team per hole (one ball in play)
//          "player" = every player records their own ball
// ranks:   what a row on the leaderboard represents
// metric:  "toPar" (lowest wins) | "points" (highest wins) | "skins" (highest wins)
const FORMATS = {
  scramble: {
    label: "Scramble", scoring: "team", ranks: "team", metric: "toPar",
    blurb: "Everyone tees off, you play the best ball, and repeat. One score per team.",
  },
  alt_shot: {
    label: "Alternate Shot", scoring: "team", ranks: "team", metric: "toPar",
    blurb: "Foursomes. One ball per team, players alternate shots until it's holed.",
  },
  best_ball: {
    label: "Best Ball", scoring: "player", ranks: "team", metric: "toPar",
    blurb: "Everyone plays their own ball. The team counts the lowest score on each hole.",
  },
  stroke: {
    label: "Stroke Play", scoring: "player", ranks: "player", metric: "toPar",
    blurb: "Individual. Count every shot; lowest total wins.",
  },
  stableford: {
    label: "Stableford", scoring: "player", ranks: "player", metric: "points",
    blurb: "Individual. Points per hole against par — a bad hole costs you little.",
  },
  skins: {
    label: "Skins", scoring: "player", ranks: "player", metric: "skins",
    blurb: "Each hole is a skin. Lowest score wins it outright; ties carry it to the next hole.",
  },

  // Match play. Two sides, decided hole by hole on net score rather than by a
  // total, so these carry ranks: "match" and are read by buildMatch below.
  // `sideSize` is how many players are on each side, which the setup screen
  // uses to lay out the right number of name fields.
  match_singles: {
    label: "Singles Match", scoring: "player", ranks: "match", metric: "match",
    match: true, sideSize: 1,
    blurb: "One against one. Each hole is won, lost or halved on net score — the match ends when it can't be caught.",
  },
  match_fourball: {
    label: "Four-Ball Match", scoring: "player", ranks: "match", metric: "match",
    match: true, sideSize: 2,
    blurb: "Two against two, everyone plays their own ball. Each side takes its better net score on the hole.",
  },
  match_foursomes: {
    label: "Foursomes Match", scoring: "team", ranks: "match", metric: "match",
    match: true, sideSize: 2,
    blurb: "Two against two, one ball per side, alternating shots. A single score per side per hole.",
  },

  // The same three shapes played for a total instead of hole by hole. Two
  // sides, lowest net round wins — head-to-head stroke play.
  stroke_singles: {
    label: "Singles Stroke Play", scoring: "player", ranks: "player", metric: "toPar",
    headToHead: true, sideSize: 1,
    blurb: "One against one, counting every shot. Lowest net total over the round wins.",
  },
  stroke_fourball: {
    label: "Four-Ball Stroke Play", scoring: "player", ranks: "team", metric: "toPar",
    headToHead: true, sideSize: 2,
    blurb: "Two a side, own ball, the side counting its better net score on each hole. Lowest total wins.",
  },
  stroke_foursomes: {
    label: "Foursomes Stroke Play", scoring: "team", ranks: "team", metric: "toPar",
    headToHead: true, sideSize: 2,
    blurb: "Two a side, one ball, alternating shots. Lowest net total over the round wins.",
  },
};

// Everything the match screen can set up: two sides, either decided hole by
// hole or on a total.
const isTwoSidedFormat = (t) => { const f = formatOf(t); return !!(f.match || f.headToHead); };

const isMatchFormat = (t) => !!formatOf(t).match;

function formatOf(tournament) {
  return FORMATS[tournament?.format] || FORMATS.scramble;
}
const isPlayerScored = (t) => formatOf(t).scoring === "player";

// Strokes a player receives on a given hole.
//
// Holes are ranked by their stroke index (1 = hardest), then shots are spread
// evenly: everyone gets floor(HC / holes) on every hole, and the hardest
// (HC mod holes) holes get one more. A 9-hole round uses half the handicap,
// which is the usual convention.
function strokeAllocation(tournament, handicap) {
  const n = tournament.num_holes;
  const alloc = Array(n).fill(0);
  // A player at or better than scratch receives nothing and is charged
  // nothing. The strict convention has a plus handicap give strokes back, so
  // a par would be recorded as a bogey — which is not how these rounds are
  // played, and made a +2 round read as +7. A plus handicap still matters in
  // a match, where it sets the mark everyone else takes their shots from:
  // matchAllocations passes the DIFFERENCE, which is never negative.
  if (handicap == null || handicap <= 0) return alloc;

  const playing = Math.round(n === 9 ? handicap / 2 : handicap);
  if (playing <= 0) return alloc;
  const magnitude = playing;

  const si = tournament.handicap && tournament.handicap.length === n
    ? tournament.handicap
    : Array.from({ length: n }, (_, i) => i + 1);

  // rank[holeIndex] = 1 for the hardest hole played, 2 for the next, ...
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => si[a] - si[b]);
  const rank = Array(n);
  order.forEach((holeIdx, position) => { rank[holeIdx] = position + 1; });

  const base = Math.floor(magnitude / n);
  const extra = magnitude % n;
  for (let i = 0; i < n; i++) alloc[i] = base + (rank[i] <= extra ? 1 : 0);
  return alloc;
}

// Skins payout.
//
// Everyone antes the same buy-in, and the whole pot is shared between the
// skins actually won. A hole that ties carries over, so if the last holes are
// halved those skins are never awarded — dividing by skins WON rather than
// holes played means that money rolls into the skins that were won, instead of
// vanishing. If nobody wins a skin outright, nothing is paid and the pot is
// returned.
function skinsPayout(tournament, rows) {
  const buyIn = Number(tournament.skins_buy_in) || 0;
  const entrants = rows.length;
  const pot = buyIn * entrants;
  const skinsWon = rows.reduce((sum, r) => sum + (r.skins || 0), 0);
  const perSkin = skinsWon > 0 ? pot / skinsWon : 0;
  return { buyIn, entrants, pot, skinsWon, perSkin };
}

function money(n) {
  return `$${(Math.round(n * 100) / 100).toFixed(2).replace(/\.00$/, "")}`;
}

// Stableford: 2 points for a net par, one more per shot better, one fewer per
// shot worse, never below zero.
function stablefordPoints(netStrokes, par) {
  if (netStrokes == null) return 0;
  return Math.max(0, 2 + (par - netStrokes));
}

// A round is over once every card that was started has been signed, whether
// or not the organizer remembered to close it. Showing LIVE next to a
// finished round is how a board ends up with a dozen "live" tournaments that
// all ended weeks ago.
//
// Teams that registered but never put a score in are ignored: a no-show
// shouldn't keep a completed round pinned to the live board forever. A
// tournament nobody has scored in is not finished — it hasn't begun.
function allCardsSigned(teams) {
  const played = (teams || []).filter((t) => (t.scores || []).length > 0);
  if (!played.length) return false;
  return played.every((t) => !!t.signed_at);
}

// A round of golf happens in one sitting. Scoring that stopped a day ago
// means it's over, whatever the status column says — otherwise a tournament
// somebody abandoned on the 4th tee in July is still advertised as live in
// September, which is exactly what the board was doing.
const LIVE_WINDOW_MS = 12 * 60 * 60 * 1000;

function lastScoreAt(teams) {
  let latest = 0;
  (teams || []).forEach((t) => (t.scores || []).forEach((s) => {
    const ts = s.updated_at ? new Date(s.updated_at).getTime() : 0;
    if (ts > latest) latest = ts;
  }));
  return latest || null;
}

/**
 * "live"         — being scored right now
 * "completed"    — closed by the organizer, or every started card signed
 * "unfinished"   — was scored, never signed, and has gone quiet
 * "never_started"— created and abandoned without a single score
 */
function tournamentState(tournament, teams) {
  if (!tournament) return "never_started";
  if (tournament.status !== "active") return "completed";

  // A match ends when it can no longer be caught, not when the organizer
  // closes it. One that was won 6 & 5 was still reading PLAYING NOW because
  // nothing had told this function the match was decided.
  if (isMatchFormat(tournament)) {
    const m = buildMatch(tournament, teams || []);
    if (!m.incomplete && m.done) return "completed";
  }

  const played = (teams || []).filter((t) => (t.scores || []).length > 0);
  if (!played.length) {
    const age = Date.now() - new Date(tournament.created_at).getTime();
    return age < LIVE_WINDOW_MS ? "live" : "never_started";
  }
  if (played.every((t) => !!t.signed_at)) return "completed";
  return Date.now() - (lastScoreAt(teams) || 0) < LIVE_WINDOW_MS ? "live" : "unfinished";
}

function tournamentFinished(tournament, teams) {
  return tournamentState(tournament, teams) !== "live";
}

// Every tournament column except join_code. Anonymous visitors have no read
// privilege on the code — that's what stops the public board from handing
// out entry to every round — so `select("*")` is refused for them. Name the
// columns instead.
const TOURNAMENT_COLS =
  "id, name, course_name, num_holes, par, status, created_at, created_by, " +
  "start_hole, handicap, yardage, tee_name, course_id, format, skins_buy_in, is_public, single_scorer, bet_unit, bet_amount";

// Same list for an embedded select — `teams(*, tournaments(...))`. PostgREST
// wants no spaces inside the parentheses.
const TOURNAMENT_COLS_EMBED = TOURNAMENT_COLS.replace(/,\s+/g, ",");

// Course logos, matched on a loose key so "Turtleback mountain" and
// "Turtleback Mountain Golf Resort" both resolve to the same badge. Falls
// back to initials when a course has no logo on file.
const COURSE_LOGOS = [
  { match: /turtleback/i, src: "img/courses/turtleback-mountain.png" },
];

function courseLogo(courseName) {
  if (!courseName) return null;
  const hit = COURSE_LOGOS.find((c) => c.match.test(courseName));
  return hit ? hit.src : null;
}

function initialsOf(name) {
  return String(name || "").split(/\s+/).filter(Boolean)
    .slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join("");
}

function tournamentPar(tournament) {
  return tournament.par && tournament.par.length === tournament.num_holes
    ? tournament.par
    : Array(tournament.num_holes).fill(4);
}

// Turns raw team rows into a sorted leaderboard with place/tied set. Shared by
// the live leaderboard and the admin top-3 export, so the two can never
// disagree about who actually won.
// What the group agreed to play for. A record, not a transaction — no money
// moves through TeeBoard, which the wording is careful to keep true.
function betLabel(tournament) {
  if (!tournament?.bet_unit || !tournament?.bet_amount) return null;
  const amt = Number(tournament.bet_amount);
  const money = Number.isInteger(amt) ? `$${amt}` : `$${amt.toFixed(2)}`;
  return { hole: `${money} a hole`, nine: `${money} a nine`, round: `${money} the round` }[tournament.bet_unit] || null;
}

// Golfers say "plus 2", not "minus 2" — a handicap better than scratch is
// stored negative but never shown that way.
function handicapLabel(h) {
  if (h == null) return null;
  const v = Number(h);
  if (!Number.isFinite(v)) return null;
  const n = Number.isInteger(v) ? v : Number(v.toFixed(1));
  if (n === 0) return "Scratch";
  return n < 0 ? `Plus ${Math.abs(n)}` : `Handicap ${n}`;
}
// Compact form for a list of partners: "Bill (12)", "Pro (+2)".
function handicapShort(h) {
  if (h == null) return "";
  const v = Number(h);
  if (!Number.isFinite(v)) return "";
  const n = Number.isInteger(v) ? v : Number(v.toFixed(1));
  return n < 0 ? ` (+${Math.abs(n)})` : ` (${n})`;
}

// A short tag for a side — "GH", or "G&B" for a pair — so a standing can name
// who it belongs to instead of relying on the reader remembering an arrow.
function sideTag(side) {
  const names = side.players.length ? side.players.map((p) => p.name) : [side.name];
  if (names.length === 1) {
    const parts = String(names[0]).trim().split(/\s+/).filter(Boolean);
    return parts.slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join("");
  }
  return names.map((n) => String(n).trim().charAt(0).toUpperCase()).join("&");
}

// ---------- MATCH PLAY ----------
//
// A match is two sides playing each other hole by hole. Unlike the stroke
// formats there is no field and no total worth ranking: what matters is who is
// up, by how many, and whether enough holes are left to catch it.
//
// Pops come from the DIFFERENCE between the sides, not from full handicaps.
// The lowest handicap in the match plays off scratch and everyone else
// receives the difference, which is how match play is actually played — giving
// both sides their full allowance would cancel out and misallocate the holes.

// Strokes each player receives relative to the lowest handicap in the match.
function matchAllocations(tournament, sides) {
  const all = sides.flatMap((s) => s.players);
  const caps = all.map((p) => Number(p.handicap) || 0);
  const lowest = caps.length ? Math.min(...caps) : 0;
  const alloc = new Map();
  all.forEach((p) => {
    alloc.set(p.id, strokeAllocation(tournament, (Number(p.handicap) || 0) - lowest));
  });
  return alloc;
}

// One side's net score on a hole, or null when the side hasn't finished it.
function sideNetOnHole(side, hole, alloc, fmt) {
  if (fmt.scoring === "team") {
    // Foursomes: a single ball, so a single score, carrying the side's own
    // allowance (the combined difference, halved, per convention).
    const gross = side.teamScoreMap[hole];
    if (gross == null) return null;
    return { net: gross - (side.teamAlloc ? side.teamAlloc[hole - 1] : 0), gross };
  }
  // Singles and four-ball: each player's own ball. A side needs at least one
  // player through the hole; the better net counts, and the gross carried
  // alongside it is that same player's — the card should show the ball that
  // actually won the hole, not the lower of two unrelated numbers.
  let best = null;
  for (const p of side.players) {
    const gross = p.scoreMap[hole];
    if (gross == null) continue;
    const net = gross - (alloc.get(p.id)?.[hole - 1] ?? 0);
    if (best == null || net < best.net) best = { net, gross };
  }
  return best;
}

// "3 & 2", "1 up", "A/S" — the way a match result is actually written.
function matchResultLabel(up, holesLeft, done) {
  if (up === 0) return done ? "A/S" : "All square";
  const lead = Math.abs(up);
  if (done || lead > holesLeft) {
    // Closed out: "3 & 2" means three up with two to play. Won on the last
    // hole is "1 up", never "1 & 0".
    return holesLeft > 0 ? `${lead} & ${holesLeft}` : `${lead} up`;
  }
  return `${lead} up`;
}

function buildMatch(tournament, teams) {
  const fmt = formatOf(tournament);
  const n = tournament.num_holes;

  // Exactly two sides make a match. More or fewer is a setup the organizer
  // still has to finish, so say so rather than inventing an opponent.
  const list = (teams || []).slice(0, 2);
  if (list.length < 2) return { incomplete: true, sides: list.length };

  const sides = list.map((t) => {
    const members = t.team_members || [];
    const scores = t.scores || [];
    const players = members.map((m) => {
      const scoreMap = {};
      scores.forEach((sc) => { if (sc.team_member_id === m.id) scoreMap[sc.hole_number] = sc.strokes; });
      return { id: m.id, name: m.player_name, handicap: m.handicap, scoreMap };
    });
    const teamScoreMap = {};
    scores.forEach((sc) => { if (sc.team_member_id == null) teamScoreMap[sc.hole_number] = sc.strokes; });
    return {
      id: t.id, name: t.name, players, teamScoreMap,
      signed: !!t.signed_at,
    };
  });

  const alloc = matchAllocations(tournament, sides);

  // Foursomes plays one ball, so the side's allowance is its own, taken as
  // half the combined difference — the standard foursomes convention.
  if (fmt.scoring === "team") {
    const sideCaps = sides.map((s) =>
      s.players.reduce((a, p) => a + (Number(p.handicap) || 0), 0) / Math.max(1, s.players.length));
    const low = Math.min(...sideCaps);
    sides.forEach((s, i) => { s.teamAlloc = strokeAllocation(tournament, (sideCaps[i] - low)); });
  }

  // ---- walk the holes ----
  let up = 0;                 // positive: side A ahead
  let played = 0;
  let closedOnHole = null;
  const holes = [];

  for (let h = 1; h <= n; h++) {
    const a = sideNetOnHole(sides[0], h, alloc, fmt);
    const b = sideNetOnHole(sides[1], h, alloc, fmt);
    if (a == null || b == null) { holes.push({ hole: h, played: false }); continue; }

    const winner = a.net < b.net ? 0 : b.net < a.net ? 1 : null;

    // Holes after the close are still shown — people play them, and the card
    // should show the round that was played — but they cannot move a result
    // that is already decided. Only holes before the close count.
    const dead = closedOnHole != null;
    if (!dead) {
      played++;
      if (winner === 0) up++;
      else if (winner === 1) up--;
    }

    holes.push({
      hole: h, played: true, dead,
      netA: a.net, netB: b.net, grossA: a.gross, grossB: b.gross,
      winner: dead ? null : winner,
      holeWinner: winner,          // who had the better ball, decided or not
      standing: up,
    });

    // Once the lead exceeds the holes remaining the match is over. Recording
    // where it closed is what makes "3 & 2" mean anything.
    if (!dead && Math.abs(up) > n - h) closedOnHole = h;
  }

  const holesLeft = closedOnHole != null ? n - closedOnHole : n - played;
  const done = closedOnHole != null || played === n || sides.every((s) => s.signed);
  const leaderIdx = up > 0 ? 0 : up < 0 ? 1 : null;

  return {
    incomplete: false,
    sides, holes, up, played, holesLeft, done,
    closedOnHole,
    leader: leaderIdx == null ? null : sides[leaderIdx],
    label: matchResultLabel(up, holesLeft, done),
    alloc,
  };
}

function buildLeaderboard(tournament, teams) {
  const par = tournamentPar(tournament);
  const n = tournament.num_holes;
  const fmt = formatOf(tournament);
  const perPlayer = fmt.scoring === "player";

  // Stroke index per hole (1 = hardest). Drives both the countback tiebreak
  // and, for net formats, which holes a handicap gives shots on.
  const si = tournament.handicap && tournament.handicap.length === n
    ? tournament.handicap
    : Array.from({ length: n }, (_, i) => i + 1);
  const countbackOrder = Array.from({ length: n }, (_, i) => i + 1)
    .sort((a, b) => si[a - 1] - si[b - 1]);

  // ---- gather raw scores into competitors ----
  // A competitor is a team or a player depending on the format, but from here
  // down everything works the same way.
  const competitors = [];

  (teams || []).forEach((t) => {
    const members = t.team_members || [];
    const teamScores = (t.scores || []);

    if (!perPlayer) {
      const scoreMap = {};
      teamScores.forEach((s) => { if (s.team_member_id == null) scoreMap[s.hole_number] = s.strokes; });
      competitors.push({
        id: t.id, teamId: t.id, name: t.name,
        players: members.map((m) => m.player_name),
        scoreMap, alloc: Array(n).fill(0),
        signed: !!t.signed_at,
      });
      return;
    }

    // Per-player formats: one competitor per player, each with their own ball.
    members.forEach((m) => {
      const scoreMap = {};
      teamScores.forEach((s) => { if (s.team_member_id === m.id) scoreMap[s.hole_number] = s.strokes; });
      competitors.push({
        id: m.id, teamId: t.id, memberId: m.id,
        name: m.player_name, teamName: t.name,
        players: [],
        handicap: m.handicap,
        alloc: strokeAllocation(tournament, m.handicap),
        scoreMap,
        signed: !!t.signed_at,
      });
    });
  });

  // ---- per-competitor totals ----
  competitors.forEach((c) => {
    let strokes = 0, parSum = 0, thru = 0, points = 0, netStrokes = 0;
    for (let h = 1; h <= n; h++) {
      const gross = c.scoreMap[h];
      if (gross == null) continue;
      const holePar = par[h - 1] ?? 4;
      const net = gross - (c.alloc[h - 1] || 0);
      strokes += gross;
      netStrokes += net;
      parSum += holePar;
      points += stablefordPoints(net, holePar);
      thru++;
    }
    c.strokes = strokes;
    c.netStrokes = netStrokes;
    c.thru = thru;
    c.toPar = netStrokes - parSum;      // net where handicaps are set, gross otherwise
    c.grossToPar = strokes - parSum;
    c.points = points;
    c.skins = 0;
  });

  // ---- Best Ball: collapse each team's players into one team row ----
  let rows = competitors;
  if (fmt.ranks === "team" && perPlayer) {
    const byTeam = new Map();
    competitors.forEach((c) => {
      if (!byTeam.has(c.teamId)) {
        byTeam.set(c.teamId, {
          id: c.teamId, teamId: c.teamId, name: c.teamName,
          players: [], scoreMap: {}, alloc: Array(n).fill(0),
          signed: c.signed, members: [],
        });
      }
      const row = byTeam.get(c.teamId);
      row.players.push(c.name);
      row.members.push(c);
    });
    byTeam.forEach((row) => {
      // The team's score on a hole is its best player's net score there.
      for (let h = 1; h <= n; h++) {
        let best = null;
        row.members.forEach((m) => {
          const gross = m.scoreMap[h];
          if (gross == null) return;
          const net = gross - (m.alloc[h - 1] || 0);
          if (best == null || net < best) best = net;
        });
        if (best != null) row.scoreMap[h] = best;
      }
      let strokes = 0, parSum = 0, thru = 0, points = 0;
      for (let h = 1; h <= n; h++) {
        if (row.scoreMap[h] == null) continue;
        strokes += row.scoreMap[h];
        parSum += par[h - 1] ?? 4;
        points += stablefordPoints(row.scoreMap[h], par[h - 1] ?? 4);
        thru++;
      }
      row.strokes = strokes; row.netStrokes = strokes; row.thru = thru;
      row.toPar = strokes - parSum; row.grossToPar = row.toPar;
      row.points = points; row.skins = 0;
    });
    rows = [...byTeam.values()];
  }

  // ---- Skins: lowest net score on a hole wins it outright; ties carry over ----
  if (fmt.metric === "skins") {
    let carry = 0;
    for (let h = 1; h <= n; h++) {
      const played = rows.filter((r) => r.scoreMap[h] != null);
      carry += 1;
      if (!played.length) continue;
      const nets = played.map((r) => ({ r, net: r.scoreMap[h] - (r.alloc[h - 1] || 0) }));
      const low = Math.min(...nets.map((x) => x.net));
      const winners = nets.filter((x) => x.net === low);
      // Only an outright low takes the skin; otherwise it rolls to the next hole.
      if (winners.length === 1) { winners[0].r.skins += carry; carry = 0; }
    }
  }

  // ---- ordering ----
  function countbackKey(row) {
    let cum = 0;
    return countbackOrder.map((h) => (cum += row.scoreMap[h] ?? 0));
  }

  // Unstarted last; then the format's own metric; then a scorecard playoff on
  // the hardest holes once both have completed the round.
  function compareRows(a, b) {
    if ((a.thru === 0) !== (b.thru === 0)) return a.thru === 0 ? 1 : -1;

    if (fmt.metric === "points" && a.points !== b.points) return b.points - a.points;
    if (fmt.metric === "skins" && a.skins !== b.skins) return b.skins - a.skins;
    if (fmt.metric === "toPar" && a.toPar !== b.toPar) return a.toPar - b.toPar;

    if (a.thru === n && b.thru === n) {
      const ak = countbackKey(a), bk = countbackKey(b);
      for (let i = 0; i < ak.length; i++) if (ak[i] !== bk[i]) return ak[i] - bk[i];
    }
    return b.thru - a.thru;
  }

  rows.sort(compareRows);

  // Places skip after ties (1, 2, 2, 4 ...). "T" shows only when two rows are
  // still genuinely inseparable after the countback.
  let place = 0;
  rows.forEach((r, i) => {
    const prev = rows[i - 1];
    const same = prev && r.thru > 0 && prev.thru > 0 && compareRows(prev, r) === 0;
    place = same ? place : i + 1;
    r.place = place;
  });
  rows.forEach((r, i) => {
    r.tied = r.thru > 0 && rows.some((o, j) => j !== i && o.place === r.place);
  });

  return rows;
}

// ---------- top-3 podium image ----------
// Draws a shareable 1080x1350 card on a canvas rather than screenshotting the
// DOM, so the output is the same everywhere and doesn't need a library.

const PODIUM_METAL = [
  { fill: "#E3B23C", edge: "#A97C10", ink: "#3A2900", label: "1ST" },
  { fill: "#C2CBD1", edge: "#8B979E", ink: "#2B3237", label: "2ND" },
  { fill: "#C08552", edge: "#8A5B2E", ink: "#331E08", label: "3RD" },
];

function drawRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Shrinks text until it fits `max` px wide, so long team names never overflow.
function fitText(ctx, text, max, weight, startPx, family) {
  let px = startPx;
  do {
    ctx.font = `${weight} ${px}px ${family}`;
    if (ctx.measureText(text).width <= max) break;
    px -= 2;
  } while (px > 16);
  return px;
}

function renderPodiumCanvas(tournament, rows) {
  const W = 1080, H = 1350;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");
  const COND = "'Barlow Condensed', sans-serif";
  const SANS = "'Archivo', sans-serif";

  // background — the same near-black panel as the app, with a soft glow
  ctx.fillStyle = "#08110C";
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W / 2, -180, 0, W / 2, -180, 1100);
  glow.addColorStop(0, "rgba(38,72,53,.95)");
  glow.addColorStop(1, "rgba(8,17,12,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // faint contour texture
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,.028)";
  ctx.lineWidth = 2;
  for (let x = -H; x < W + H; x += 70) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + H, H); ctx.stroke();
  }
  ctx.restore();

  // top light-bar
  const bar = ctx.createLinearGradient(0, 0, W, 0);
  bar.addColorStop(0, "#23883F"); bar.addColorStop(.45, "#4CCB78"); bar.addColorStop(1, "#23883F");
  ctx.fillStyle = bar;
  ctx.fillRect(0, 0, W, 8);

  // header
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "rgba(255,255,255,.5)";
  ctx.font = `600 30px ${COND}`;
  ctx.letterSpacing = "6px";
  // Don't claim a result is final while scoring is still open.
  ctx.fillText(tournament.status === "active" ? "CURRENT STANDINGS" : "FINAL RESULTS", 80, 130);
  ctx.letterSpacing = "0px";

  ctx.fillStyle = "#fff";
  const namePx = fitText(ctx, tournament.name.toUpperCase(), W - 160, 700, 92, COND);
  ctx.font = `700 ${namePx}px ${COND}`;
  ctx.fillText(tournament.name.toUpperCase(), 80, 130 + namePx * 0.92);

  let y = 130 + namePx * 0.92 + 20;
  if (tournament.course_name) {
    ctx.fillStyle = "rgba(255,255,255,.55)";
    ctx.font = `400 34px ${SANS}`;
    ctx.fillText(tournament.course_name, 80, y + 34);
    y += 52;
  }

  ctx.strokeStyle = "rgba(255,255,255,.12)";
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(80, y + 34); ctx.lineTo(W - 80, y + 34); ctx.stroke();

  // podium rows
  let top = y + 96;
  const rowH = 250, gap = 26;

  rows.slice(0, 3).forEach((r, i) => {
    const m = PODIUM_METAL[i];
    const ry = top + i * (rowH + gap);

    ctx.fillStyle = i === 0 ? "rgba(227,178,60,.10)" : "rgba(255,255,255,.045)";
    drawRoundRect(ctx, 80, ry, W - 160, rowH, 26);
    ctx.fill();
    ctx.strokeStyle = i === 0 ? "rgba(227,178,60,.5)" : "rgba(255,255,255,.10)";
    ctx.lineWidth = 2;
    ctx.stroke();

    // medal chip
    const cx = 80 + 92, cy = ry + rowH / 2;
    ctx.beginPath(); ctx.arc(cx, cy, 58, 0, Math.PI * 2);
    ctx.fillStyle = m.fill; ctx.fill();
    ctx.lineWidth = 5; ctx.strokeStyle = m.edge; ctx.stroke();
    ctx.fillStyle = m.ink;
    ctx.font = `700 46px ${COND}`;
    ctx.textAlign = "center";
    ctx.fillText(`${r.tied ? "T" : ""}${r.place}`, cx, cy + 16);
    ctx.textAlign = "left";

    // team name + players
    const textX = 80 + 190;
    const scoreW = 250;
    const availW = W - 160 - 190 - scoreW;
    ctx.fillStyle = "#fff";
    const tnPx = fitText(ctx, r.name, availW, 700, 62, COND);
    ctx.font = `700 ${tnPx}px ${COND}`;
    ctx.fillText(r.name.toUpperCase(), textX, cy + (r.players.length ? -6 : 18));

    if (r.players.length) {
      let who = r.players.join(" · ");
      ctx.font = `400 28px ${SANS}`;
      while (ctx.measureText(who).width > availW && who.length > 4) who = who.slice(0, -2);
      if (who !== r.players.join(" · ")) who += "…";
      ctx.fillStyle = "rgba(255,255,255,.5)";
      ctx.fillText(who, textX, cy + 44);
    }

    // score — red under par, the same convention as the app
    ctx.textAlign = "right";
    ctx.fillStyle = r.toPar < 0 ? "#FF5A5F" : "#fff";
    ctx.font = `700 96px ${COND}`;
    ctx.fillText(r.thru ? toParLabel(r.toPar) : "—", W - 120, cy + 20);
    ctx.fillStyle = "rgba(255,255,255,.45)";
    ctx.font = `600 26px ${COND}`;
    ctx.letterSpacing = "3px";
    ctx.fillText(`${r.strokes} STROKES`, W - 120, cy + 62);
    ctx.letterSpacing = "0px";
    ctx.textAlign = "left";
  });

  // footer wordmark
  const fy = H - 74;
  ctx.strokeStyle = "rgba(255,255,255,.12)";
  ctx.beginPath(); ctx.moveTo(80, fy - 46); ctx.lineTo(W - 80, fy - 46); ctx.stroke();
  ctx.font = `700 40px ${COND}`;
  ctx.fillStyle = "#4CCB78";
  ctx.fillText("TEE", 80, fy);
  const teeW = ctx.measureText("TEE").width;
  ctx.fillStyle = "#fff";
  ctx.fillText("BOARD", 80 + teeW, fy);

  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(255,255,255,.45)";
  ctx.font = `600 28px ${COND}`;
  ctx.letterSpacing = "3px";
  ctx.fillText(`${tournament.num_holes} HOLES · ${new Date().toLocaleDateString()}`.toUpperCase(), W - 80, fy - 4);
  ctx.letterSpacing = "0px";
  ctx.textAlign = "left";

  return cv;
}

// Preview sheet with the rendered card, plus download / native share.
function showPodiumSheet(tournament, rows) {
  const canvas = renderPodiumCanvas(tournament, rows);
  const fileName = `${tournament.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-top3.png`;

  const wrap = document.createElement("div");
  wrap.className = "sheet-backdrop";
  wrap.innerHTML = `
    <div class="sheet" role="dialog" aria-label="Top 3 result card">
      <div class="flex items-center justify-between mb-3">
        <span class="eyebrow">Top 3 result card</span>
        <button class="btn-ghost" data-close>Close</button>
      </div>
      <div class="sheet-img"></div>
      <div class="grid grid-cols-2 gap-2 mt-3">
        <button class="btn-secondary text-sm" data-share>Share</button>
        <button class="btn-primary text-sm" data-save>Save image</button>
      </div>
      <p class="text-xs muted-2 text-center mt-2">1080 × 1350 — sized for a phone screen or a story post.</p>
    </div>`;
  canvas.style.cssText = "width:100%;height:auto;display:block;border-radius:12px";
  wrap.querySelector(".sheet-img").appendChild(canvas);
  document.body.appendChild(wrap);

  const close = () => wrap.remove();
  wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });
  wrap.querySelector("[data-close]").addEventListener("click", close);

  const toBlob = () => new Promise((res) => canvas.toBlob(res, "image/png"));

  wrap.querySelector("[data-save]").addEventListener("click", async () => {
    const blob = await toBlob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
    toast("Image saved");
  });

  const shareBtn = wrap.querySelector("[data-share]");
  shareBtn.addEventListener("click", async () => {
    const blob = await toBlob();
    const file = new File([blob], fileName, { type: "image/png" });
    // navigator.share only accepts files on some browsers, so check first and
    // fall back to a plain download rather than throwing at the user.
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: tournament.name });
      } catch { /* user dismissed the share sheet */ }
    } else {
      wrap.querySelector("[data-save]").click();
    }
  });
}

function toast(msg, isError) {
  let t = document.createElement("div");
  t.textContent = msg;
  t.className = `toast${isError ? " error" : ""}`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

function shareLink(hash) {
  return `${location.origin}${location.pathname}#${hash}`;
}

function store(key, val) {
  localStorage.setItem(key, JSON.stringify(val));
}
function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

// track my teams: { [tournamentId]: {teamId, teamName, teamCode, tournamentCode} }
function myTeams() { return load("bb_my_teams", {}); }
function saveMyTeam(tournamentId, info) {
  const t = myTeams();
  t[tournamentId] = info;
  store("bb_my_teams", t);
}
// "Tournaments I created" is derived solely from the database, filtered by
// created_by = the signed-in user. It used to be backed by a localStorage list
// that every admin-page visit appended to, which meant any tournament ever
// opened on a device showed up as yours — including other people's, and ones
// belonging to a different account on a shared phone.
// One-time cleanup of that stale list so it stops surfacing anywhere.
try { localStorage.removeItem("bb_my_tournaments"); } catch { /* private mode */ }

let realtimeChannel = null;
function clearRealtime() {
  if (realtimeChannel) {
    sb.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
}

// ---------- auth (organizer accounts) ----------
// Only needed to CREATE/manage a tournament. Players never sign in — they
// just use a join code.
async function getUser() {
  const { data: { user } } = await sb.auth.getUser();
  return user;
}

// Persistent profile control in the header, present on every page. Shows
// nothing for anonymous players; shows an avatar + "Sign out" menu for any
// signed-in organizer, regardless of which view is currently open.
async function renderHeaderProfile() {
  const el = document.getElementById("header-profile");
  if (!el) return;
  const user = await getUser();
  if (!user) {
    el.innerHTML = "";
    return;
  }
  const meta = user.user_metadata || {};
  const fullName = [meta.first_name, meta.last_name].filter(Boolean).join(" ") || meta.full_name || "";
  // Initials from the name when we have one, falling back to the email for
  // accounts created before sign-up collected names.
  const initial = escapeHtml(
    fullName
      ? fullName.split(/\s+/).slice(0, 2).map((p) => p.charAt(0)).join("").toUpperCase()
      : user.email.charAt(0).toUpperCase()
  );
  el.innerHTML = `
    <div class="relative">
      <button id="profile-btn" aria-label="Account menu"
        class="h-8 rounded-lg text-white font-bold text-sm flex items-center justify-center px-2"
        style="min-width:2rem;background:var(--grass-600);border:1px solid rgba(255,255,255,.15);">${initial}</button>
      <div id="profile-menu" class="hidden absolute right-0 mt-2 w-60 card p-3 z-40">
        <div class="eyebrow mb-1">Signed in as</div>
        ${fullName ? `<div class="text-sm font-bold">${escapeHtml(fullName)}</div>` : ""}
        <div class="text-sm ${fullName ? "muted" : "font-semibold"} mb-3 break-all">${escapeHtml(user.email)}</div>
        ${IS_NATIVE_APP ? "" : `<a href="#/billing" class="btn-secondary w-full text-sm mb-2">Billing</a>`}
        <a href="#/stats" class="btn-secondary w-full text-sm mb-2">Site traffic</a>
        ${(await isTeeboardAdmin())
          ? `<a href="#/users" class="btn-secondary w-full text-sm mb-2">Users &amp; tournaments</a>`
          : ""}
        <button id="profile-signout" class="btn-secondary w-full text-sm">Sign out</button>
      </div>
    </div>
  `;
  const btn = document.getElementById("profile-btn");
  const menu = document.getElementById("profile-menu");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.classList.toggle("hidden");
  });
  document.addEventListener("click", () => menu.classList.add("hidden"), { once: true });
  document.getElementById("profile-signout").addEventListener("click", async () => {
    billingCache = null;
    await sb.auth.signOut();
    if (location.hash === "#/" || location.hash === "") {
      // hashchange won't fire since the hash isn't actually changing, so
      // force a re-render manually to drop the stale signed-in view.
      route();
    } else {
      location.hash = "#/";
    }
  });
}

// ---------- router ----------

const routes = [
  { re: /^#\/$/, view: viewHome },
  { re: /^#\/create$/, view: () => viewCreate() },
  // Same screen, opened on a match format. A match is a round with two
  // sides, so it shares the whole create flow rather than forking it.
  { re: /^#\/match$/, view: () => viewCreate({ match: true }) },
  { re: /^#\/mine$/, view: viewMine },
  // Wrapped so the regex match array isn't passed in as prefillCode — bare
  // `view: viewJoin` handed it the match ("#/join"), which pre-filled the code
  // box with that string and auto-fired a doomed lookup on arrival.
  { re: /^#\/join$/, view: () => viewJoin() },
  { re: /^#\/reset$/, view: () => viewResetPassword() },
  { re: /^#\/billing/, view: () => viewBilling() },
  { re: /^#\/tournaments$/, view: () => viewTournaments("current") },
  { re: /^#\/tournaments\/(current|results)$/, view: (m) => viewTournaments(m[1]) },
  { re: /^#\/players$/, view: () => viewPlayers() },
  { re: /^#\/players\/(scramble|individual)$/, view: (m) => viewPlayers(m[1]) },
  { re: /^#\/player\/(.+)$/, view: (m) => viewPlayer(m[1]) },
  { re: /^#\/users$/, view: () => viewUsers() },
  { re: /^#\/stats$/, view: () => viewStats() },
  { re: /^#\/terms$/, view: () => viewLegal("terms") },
  { re: /^#\/privacy$/, view: () => viewLegal("privacy") },
  { re: /^#\/refunds$/, view: () => viewLegal("refunds") },
  { re: /^#\/join\/([A-Za-z0-9]+)$/, view: (m) => viewJoin(m[1]) },
  { re: /^#\/admin\/([0-9a-fA-F-]+)$/, view: (m) => viewAdmin(m[1]) },
  { re: /^#\/team\/([0-9a-fA-F-]+)$/, view: (m) => viewTeam(m[1]) },
  { re: /^#\/score\/([0-9a-fA-F-]+)$/, view: (m) => viewMatchScore(m[1]) },
  { re: /^#\/leaderboard\/([0-9a-fA-F-]+)$/, view: (m) => viewLeaderboard(m[1]) },
  { re: /^#\/scorecard\/([0-9a-fA-F-]+)$/, view: (m) => viewScorecard(m[1]) },
];

// ---------- offline score queue ----------
// Golf courses have terrible signal. A score that fails to send is kept on the
// phone and replayed when the connection returns, so a dead spot on the 7th
// never costs someone their card.

const OFFLINE_KEY = "bb_pending_scores";
const pendingScores = () => load(OFFLINE_KEY, []);

// Worth retrying (the request never reached the server) as opposed to the
// server having considered it and said no. Only the former should be queued;
// a closed tournament will never start succeeding.
function isConnectionError(error) {
  const m = (error && (error.message || error.msg)) || String(error || "");
  return /fetch|network|Failed to send|Load failed|timeout|ECONN/i.test(m);
}

function queueScore(entry) {
  const list = pendingScores();
  // Only the latest value for a given hole/player matters, so replace rather
  // than pile up — otherwise a flaky connection replays every correction.
  const i = list.findIndex(
    (p) => p.p_team_code === entry.p_team_code &&
           p.p_hole === entry.p_hole &&
           (p.p_member_id ?? null) === (entry.p_member_id ?? null));
  if (i >= 0) list[i] = entry; else list.push(entry);
  store(OFFLINE_KEY, list);
  updateOfflineBadge();
}

let flushing = false;
async function flushScoreQueue() {
  // Deliberately not gated on navigator.onLine. Inside the native WebView that
  // flag can read false while the network is perfectly fine, and gating on it
  // meant a queued score was never retried again — the card stayed on the
  // phone and never reached the leaderboard. Just try the write: if there is
  // genuinely no signal the request fails fast and the entry stays queued.
  if (flushing || !sb) return;
  const list = pendingScores();
  if (!list.length) return;

  flushing = true;
  const remaining = [];
  for (const entry of list) {
    let error = null;
    try {
      ({ error } = await sb.rpc("player_set_score", entry));
    } catch (e) {
      error = e;
    }
    // Keep only genuine connection failures. A rejection from the server
    // (closed tournament, signed card) will never succeed on retry, so
    // holding it would block the queue forever.
    if (error && isConnectionError(error)) remaining.push(entry);
  }
  store(OFFLINE_KEY, remaining);
  flushing = false;
  updateOfflineBadge();

  if (list.length !== remaining.length) {
    toast(remaining.length ? "Some scores synced" : "Scores synced");
    route();
  }
}

function updateOfflineBadge() {
  const el = document.getElementById("offline-badge");
  if (!el) return;
  const n = pendingScores().length;
  const offline = !navigator.onLine;
  if (!n && !offline) { el.innerHTML = ""; return; }
  // Tappable when something is waiting, so a stuck card is always recoverable
  // by hand rather than only by whatever event we happened to listen for.
  el.innerHTML = `<span class="pill" ${n ? 'id="offline-retry" role="button" tabindex="0" style="cursor:pointer;' : 'style="'}background:rgba(214,37,43,.12);border-color:rgba(214,37,43,.25);color:#FF6B6B">
    ${offline ? "Offline" : ""}${n ? `${offline ? " · " : ""}${n} to sync · tap to retry` : ""}</span>`;
  const retry = document.getElementById("offline-retry");
  if (retry) retry.addEventListener("click", () => { toast("Syncing…"); flushScoreQueue(); });
}

if (typeof window !== "undefined") {
  window.addEventListener("online", flushScoreQueue);
  window.addEventListener("online", updateOfflineBadge);
  window.addEventListener("offline", updateOfflineBadge);

  // The `online` event alone is not enough. A phone that was in a dead spot
  // during the round and is reopened on the clubhouse wifi never fires it,
  // because as far as the WebView is concerned it was online the whole time.
  // Retry when the app comes back to the foreground, and on a slow timer.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { flushScoreQueue(); updateOfflineBadge(); }
  });
  window.addEventListener("focus", flushScoreQueue);
  setInterval(() => { if (pendingScores().length) flushScoreQueue(); }, 20000);
}

// ---------- page views ----------
// Self-hosted and deliberately minimal: which screen, a random per-browser id
// so repeat views collapse into one visitor, and the referring host. No IP, no
// user agent, no link to an account, nothing identifying — which is why this
// needs no cookie banner.

// Random id kept in localStorage. Identifies a browser, not a person, and
// clearing site data resets it.
function viewerSession() {
  let id = load("bb_session_id", null);
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) ||
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    store("bb_session_id", id);
  }
  return id;
}

// Collapse ids out of the route so the stats show "#/leaderboard/:id" rather
// than one row per tournament.
function normalisedPath(hash) {
  const h = (hash || "#/").split("?")[0];
  return h
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id")
    .replace(/#\/join\/[A-Za-z0-9]+/, "#/join/:code")
    .slice(0, 120);
}

let lastTrackedPath = null;
function trackPageView() {
  if (!sb) return;
  const path = normalisedPath(location.hash);
  if (path === lastTrackedPath) return;   // ignore re-renders of the same screen
  lastTrackedPath = path;

  let referrer = null;
  try {
    // Host only — never the full URL, which can carry someone else's query.
    if (document.referrer && !document.referrer.includes(location.host)) {
      referrer = new URL(document.referrer).host.slice(0, 120);
    }
  } catch { /* malformed referrer */ }

  // Fire and forget: analytics must never delay or break a screen.
  sb.from("page_views")
    .insert({ path, session_id: viewerSession(), referrer })
    .then(() => {}, () => {});
}

function route() {
  clearRealtime();
  flushScoreQueue();
  headerSub.innerHTML = "";
  renderHeaderProfile();
  trackPageView();
  const hash = location.hash || "#/";

  // Highlight whichever nav entry owns this screen.
  document.querySelectorAll("#mainnav .navlink").forEach((a) => {
    const target = a.dataset.nav;
    const on = target === "#/"
      ? hash === "#/" || hash === ""
      : hash.startsWith(target) || (target === "#/players" && hash.startsWith("#/player"));
    a.classList.toggle("is-on", on);
  });

  for (const r of routes) {
    const m = hash.match(r.re);
    if (m) return r.view(m);
  }
  viewHome();
}

window.addEventListener("hashchange", route);
window.addEventListener("DOMContentLoaded", async () => {
  if (!CONFIGURED) {
    app.innerHTML = `
      <div class="card p-6 mt-4">
        <div class="eyebrow mb-2">Setup required</div>
        <h2 class="text-lg mb-2">Not connected yet</h2>
        <p class="text-sm muted mb-3">TeeBoard needs a free Supabase project to store tournaments and scores.</p>
        <p class="text-sm muted">Open <code class="px-1 rounded" style="background:var(--paper)">config.js</code>, fill in your
        <code class="px-1 rounded" style="background:var(--paper)">SUPABASE_URL</code> and
        <code class="px-1 rounded" style="background:var(--paper)">SUPABASE_ANON_KEY</code>, then reload.
        See README.md for step-by-step setup.</p>
      </div>`;
    return;
  }
  if (await handleAuthCallback()) return;
  initHeaderMenu();
  route();
  updateOfflineBadge();
  flushScoreQueue();

  // Service worker: makes the app installable and keeps the shell available
  // with no signal. Skipped on file:// and anywhere it isn't supported.
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("sw.js").catch(() => { /* not fatal */ });
  }
});

// Where Supabase should send someone back to after they click the link in a
// confirmation email. Must also be listed under Authentication → URL
// Configuration → Redirect URLs in the Supabase dashboard, or Supabase falls
// back to the project's Site URL and the link appears to "not work".
function authRedirectTo() {
  return location.origin + location.pathname;
}

// Finishes the email-confirmation round trip. Supabase's /verify endpoint
// bounces back here with either ?code= (PKCE) or #access_token= (implicit),
// which is meaningless to the hash router — without this the link lands on a
// page that silently ignores it and the account stays unconfirmed.
async function handleAuthCallback() {
  const rawHash = ENTRY_URL.hash.replace(/^#/, "");
  const hashParams = new URLSearchParams(rawHash.includes("=") ? rawHash : "");
  const qs = new URLSearchParams(ENTRY_URL.search);

  const errDesc = hashParams.get("error_description") || qs.get("error_description");
  const code = qs.get("code");
  const hasToken = hashParams.has("access_token");
  if (!errDesc && !code && !hasToken) return false;

  const base = location.origin + location.pathname;

  if (errDesc) {
    // Expired or already-used links land here rather than dumping raw
    // querystring at someone.
    history.replaceState(null, "", base + "#/create");
    route();
    toast(decodeURIComponent(errDesc.replace(/\+/g, " ")), true);
    return true;
  }

  if (code) {
    const { error } = await sb.auth.exchangeCodeForSession(code);
    if (error) {
      history.replaceState(null, "", base + "#/create");
      route();
      toast("That link didn't work: " + error.message, true);
      return true;
    }
  } else {
    // Implicit flow — supabase-js parses the hash itself on startup; this just
    // waits for it to have finished before we redraw.
    await sb.auth.getSession();
  }

  // A recovery link lands here too. Sending them to the home page signed in
  // would technically "work" while leaving them no way to set a new password,
  // which is exactly what makes the reset email feel broken.
  if (isPasswordRecovery || hashParams.get("type") === "recovery") {
    history.replaceState(null, "", base + "#/reset");
    route();
    return true;
  }

  history.replaceState(null, "", base + "#/");
  route();
  toast("Email confirmed — you're signed in");
  return true;
}

// ---------- HOME ----------

async function viewHome() {
  app.innerHTML = loadingHtml();

  const user = await getUser();
  const teams = myTeams();
  const teamEntries = Object.entries(teams);

  // The landing page shows golf, not a logo. Whatever is being played right
  // now — or was played last — is the most useful thing to put in front of
  // somebody opening the site.
  const { data: recent } = await sb
    .from("tournaments")
    .select("id, name, course_name, format, num_holes, start_hole, status, created_at, par, handicap, skins_buy_in, " +
            "teams(id, name, signed_at, team_members(id, player_name, handicap), scores(hole_number, strokes, team_member_id, updated_at))")
    // The hero is the public face of the site — a private round must never
    // surface here, however recent it is.
    .eq("is_public", true)
    .order("created_at", { ascending: false })
    .limit(6);
  const candidates = (recent || []).filter((t) => tournamentState(t, t.teams) !== "never_started");

  // Every round from the past week gets its own banner, newest first — a week
  // with a match and a scramble in it deserves two, not one and a footnote.
  // Capped so a busy week doesn't turn the page into an endless scroll.
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const MAX_BANNERS = 3;
  const banners = candidates
    .filter((t) => Date.now() - new Date(t.created_at).getTime() < WEEK_MS)
    // Anything still being played leads, then newest first.
    .sort((a, b) => {
      const liveA = tournamentState(a, a.teams) === "live" ? 1 : 0;
      const liveB = tournamentState(b, b.teams) === "live" ? 1 : 0;
      return liveB - liveA || new Date(b.created_at) - new Date(a.created_at);
    })
    .map((t) => {
      if (isMatchFormat(t)) t.match = buildMatch(t, t.teams || []);
      else t.rows = buildLeaderboard(t, t.teams || []);
      return t;
    })
    .filter((t) => (t.match ? !t.match.incomplete : (t.rows || []).some((r) => r.thru > 0)))
    .slice(0, MAX_BANNERS);

  // Anything older, or past the cap, stays as a compact card below.
  const weekRounds = candidates
    .filter((t) => !banners.some((b) => b.id === t.id)
      && Date.now() - new Date(t.created_at).getTime() < WEEK_MS)
    .map((t) => {
      if (isMatchFormat(t)) t.match = buildMatch(t, t.teams || []);
      else t.rows = buildLeaderboard(t, t.teams || []);
      return t;
    })
    .filter((t) => (t.match ? !t.match.incomplete : (t.rows || []).some((r) => r.thru > 0)));

  // Only ever what this account actually created. Nothing device-local feeds
  // this list, so signing in on someone else's phone shows you your own
  // tournaments and nothing of theirs.
  let owned = [];
  let billing = null;
  if (user) {
    const { data } = await sb
      .from("tournaments")
      .select("id, name, join_code")
      .eq("created_by", user.id)
      .order("created_at", { ascending: false });
    owned = data || [];
    billing = await getBilling();
  }

  const listRow = (href, title, meta, action) => `
    <a href="${href}" class="row-link">
      <div class="min-w-0 flex-1">
        <div class="font-semibold truncate">${title}</div>
        <div class="eyebrow mt-0.5">${meta}</div>
      </div>
      <span class="btn-ghost shrink-0">${action} ${icon("arrow", 14)}</span>
    </a>`;

  app.innerHTML = `
    ${trialBannerHtml(billing)}
    ${banners.map((t) => { const tState = tournamentState(t, t.teams); return `
      <section class="hero${banners.length > 1 ? " stacked" : ""}">
        <div class="hero-inner">
          <div class="hero-left">
            <div class="hero-pills">
              ${tState === "live"
                ? `<span class="pill onair"><span class="dot"></span>PLAYING NOW</span>`
                : `<span class="pill onair">FINAL</span>`}
              <span class="pill men">${escapeHtml(formatOf(t).label)}</span>
            </div>
            <div class="hero-row">
              ${courseLogo(t.course_name)
                ? `<img class="hero-logo" src="${courseLogo(t.course_name)}"
                        alt="${escapeHtml(t.course_name || "")}" />`
                : `<div class="hero-logo hero-logo-text">${escapeHtml(initialsOf(t.name))}</div>`}
              <div class="min-w-0">
                <h1 class="hero-name">${escapeHtml(t.name)}</h1>
                <div class="hero-meta">
                  ${escapeHtml(new Date(t.created_at).toLocaleDateString(undefined,
                    { month: "short", day: "numeric", year: "numeric" }))}
                  ${t.course_name ? ` &nbsp;|&nbsp; ${escapeHtml(t.course_name)}` : ""}
                </div>
                <a href="#/leaderboard/${t.id}" class="hero-link">${
                  isMatchFormat(t) ? "View match" : "View tournament"}</a>
              </div>
            </div>
          </div>

          <div class="hero-card">
            ${t.match ? `
              ${t.match.incomplete
                ? `<p class="text-sm muted text-center py-8">Waiting on the second side.</p>`
                : `<div class="heromatch">
                     ${t.match.sides.map((side, i) => {
                       const up = i === 0 ? t.match.up : -t.match.up;
                       const standing = up === 0 ? "A/S" : up > 0 ? `${up} up` : `${Math.abs(up)} dn`;
                       const won = t.match.done && up > 0;
                       return `<div class="hm-row${up > 0 ? " ahead" : up < 0 ? " behind" : ""}">
                                 <span class="hm-name">${escapeHtml(side.players.map((p) => p.name).join(" & ") || side.name)}${
                                   won ? `<span class="wintag">Winner</span>` : ""}</span>
                                 <span class="hm-st">${standing}</span>
                               </div>`;
                     }).join("")}
                     <div class="hm-foot">${t.match.done
                       ? (t.match.up === 0 ? "Match halved" : `Won ${escapeHtml(t.match.label)}`)
                       : `${t.match.played} of ${t.num_holes} played`}</div>
                   </div>`}
              <div style="padding:0 14px 14px">
                <a href="#/leaderboard/${t.id}" class="cardbtn" style="margin-top:0">View match</a>
              </div>
            ` : `
            <div class="seg">
              <span class="on">${formatOf(t).ranks === "player" ? "Players" : "Teams"}</span>
              <a href="#/leaderboard/${t.id}">Full board</a>
            </div>
            ${(t.rows || []).length ? `
              <table class="dtable">
                <thead>
                  <tr>
                    <th class="l" style="width:2.6rem">#</th>
                    <th class="l">${formatOf(t).ranks === "player" ? "Player" : "Team"}</th>
                    <th class="rule" style="width:4rem">Total</th>
                    <th class="rule" style="width:3.4rem">Thru</th>
                  </tr>
                </thead>
                <tbody>
                  ${t.rows.slice(0, 5).map((r) => `
                    <tr class="tap" onclick="location.hash='#/leaderboard/${t.id}'">
                      <td class="l pos">${r.tied ? "T" : ""}${r.place}</td>
                      <td class="l" style="max-width:0"><div class="nm truncate">${escapeHtml(r.name)}</div></td>
                      <td class="rule"><span class="chip ${r.toPar < 0 ? "under" : "even"}">${r.thru ? toParLabel(r.toPar) : "–"}</span></td>
                      <td class="rule num" style="color:var(--ink-2)">${r.thru || "–"}/${t.num_holes}</td>
                    </tr>`).join("")}
                </tbody>
              </table>` : `<p class="text-sm muted text-center py-6">No scores yet.</p>`}
            <div style="padding:0 14px 14px">
              <a href="#/leaderboard/${t.id}" class="cardbtn" style="margin-top:0">View leaderboard</a>
            </div>`}
          </div>
        </div>
      </section>
    `; }).join("")}

    ${weekRounds.length ? `
      <div class="sectionbar" style="margin-top:26px">
        <span class="t">Earlier this week</span><span class="rule"></span>
        <span class="n">${weekRounds.length}</span>
      </div>
      <div class="weekgrid">
        ${weekRounds.map((t) => {
          const state = tournamentState(t, t.teams);
          const day = escapeHtml(new Date(t.created_at)
            .toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }));
          const head = `
            <div class="wk-top">
              <span class="pill ${state === "live" ? "onair" : ""}">${state === "live" ? "PLAYING" : "FINAL"}</span>
              <span class="wk-fmt">${escapeHtml(formatOf(t).label)}</span>
            </div>`;
          if (t.match) {
            const mm = t.match;
            return `
              <a href="#/leaderboard/${t.id}" class="weekcard">
                ${head}
                ${mm.sides.map((side, i) => {
                  const up = i === 0 ? mm.up : -mm.up;
                  const won = mm.done && up > 0;
                  return `
                    <div class="wk-side${up > 0 ? " ahead" : up < 0 ? " behind" : ""}">
                      <span class="wk-name">${escapeHtml(side.players.map((pl) => pl.name).join(" & ") || side.name)}</span>
                      <span class="wk-st">${up === 0 ? "A/S" : up > 0 ? `${up} up` : `${Math.abs(up)} dn`}${
                        won ? `<span class="wintag">Won</span>` : ""}</span>
                    </div>`;
                }).join("")}
                <div class="wk-foot">${mm.done
                  ? (mm.up === 0 ? "Halved" : `Won ${escapeHtml(mm.label)}`)
                  : `${mm.played} of ${t.num_holes} played`} · ${day}</div>
              </a>`;
          }
          const top = (t.rows || []).slice(0, 3);
          return `
            <a href="#/leaderboard/${t.id}" class="weekcard">
              ${head}
              <div class="wk-name" style="margin-bottom:8px">${escapeHtml(t.name)}</div>
              ${top.map((r, i) => `
                <div class="wk-side${i === 0 ? " ahead" : ""}">
                  <span class="wk-name">${r.tied ? "T" : ""}${r.place}. ${escapeHtml(r.name)}</span>
                  <span class="wk-st">${r.thru ? escapeHtml(toParLabel(r.toPar)) : "–"}</span>
                </div>`).join("")}
              <div class="wk-foot">${(t.teams || []).length} ${formatOf(t).ranks === "player" ? "players" : "teams"} · ${day}</div>
            </a>`;
        }).join("")}
      </div>
    ` : ""}

    <div id="news-slot"></div>

    ${!user && !IS_NATIVE_APP ? marketingHtml() : ""}

    ${teamEntries.length ? `
      <div class="flex items-center gap-3 mt-7 mb-2.5">
        <h2 class="eyebrow">My teams</h2>
        <div class="flex-1 hairline"></div>
      </div>
      <div class="grid grid-cols-1 gap-2">
        ${teamEntries.map(([tid, t]) => listRow(
          `#/team/${t.teamId}`,
          escapeHtml(t.teamName),
          `Team code ${escapeHtml(t.teamCode)}`,
          "Score",
        )).join("")}
      </div>
    ` : ""}

    ${owned.length ? `
      <div class="flex items-center gap-3 mt-7 mb-2.5">
        <h2 class="eyebrow">Tournaments I created</h2>
        <div class="flex-1 hairline"></div>
      </div>
      <div class="grid grid-cols-1 gap-2">
        ${owned.map((t) => listRow(
          `#/admin/${t.id}`, escapeHtml(t.name), `Code ${escapeHtml(t.join_code)}`, "Manage",
        )).join("")}
      </div>
    ` : ""}
  `;

  // After the page is up, not before — a slow feed must never hold up scores.
  renderNews();
}

// ---------- CREATE TOURNAMENT ----------

const COURSE_SEARCH_URL = "https://api.opengolfapi.org/v1/courses/search?q=";
const COURSE_DETAIL_URL = "https://api.opengolfapi.org/v1/courses/";
// The /api/v1/ path returns the full card — per-hole yardages by tee and
// handicap_index (stroke index) — where /v1/ only gives hole + par. We try the
// detailed one first and fall back, so a course missing from it still works.
const COURSE_FULL_URL = "https://api.opengolfapi.org/api/v1/courses/";
// Which tee's yardages to store. White is the common members' tee; the card
// records tee_name so it's clear which set the numbers came from.
const DEFAULT_TEE = "white";

async function viewCreate(opts = {}) {
  app.innerHTML = loadingHtml();
  const user = await getUser();
  if (!user) return renderAuthGate();
  const billing = await getBilling();
  // The real gate is the RLS policy on tournaments; this just avoids letting
  // someone fill in a whole form only to have the insert rejected.
  if (!billingHasAccess(billing)) return renderPaywall(billing, "create");
  renderCreateForm(user, billing, opts);
}

// ---------- billing ----------

// Cached per page load: the trial banner, the create screen and the admin
// dashboard all ask, and it doesn't change mid-session.
let billingCache = null;
async function getBilling(force) {
  if (billingCache && !force) return billingCache;
  const user = await getUser();
  if (!user) return null;
  const { data } = await sb
    .from("organizer_billing")
    .select("trial_ends_at, is_exempt, subscription_status, current_period_end, stripe_customer_id")
    .eq("user_id", user.id)
    .maybeSingle();
  billingCache = data || null;
  return billingCache;
}

// Mirrors public.has_teeboard_access() in the database. If these ever
// disagree, the database wins — this only decides what UI to show.
function billingHasAccess(b) {
  if (!b) return false;
  if (b.is_exempt) return true;
  if (["active", "trialing"].includes(b.subscription_status)) return true;
  return new Date(b.trial_ends_at).getTime() > Date.now();
}

function trialDaysLeft(b) {
  if (!b) return 0;
  return Math.max(0, Math.ceil((new Date(b.trial_ends_at).getTime() - Date.now()) / 86400000));
}

// Shown while on trial so the deadline isn't a surprise. Hidden for exempt
// accounts and anyone already subscribed.
function trialBannerHtml(b) {
  if (IS_NATIVE_APP) return "";
  if (!b || b.is_exempt) return "";
  if (["active", "trialing"].includes(b.subscription_status)) return "";
  const days = trialDaysLeft(b);
  if (days > 14) return "";
  const urgent = days <= 3;
  return `
    <a href="#/billing" class="card p-3.5 mb-2.5 flex items-center gap-3"
       style="background:${urgent ? "#FDF2F2" : "var(--grass-100)"};border-color:${urgent ? "#F1CFD0" : "var(--grass-200)"}">
      <span class="shrink-0" style="color:${urgent ? "var(--under)" : "var(--grass-700)"}">${icon("trophy", 18)}</span>
      <div class="min-w-0 flex-1">
        <div class="text-sm font-bold" style="color:${urgent ? "var(--under)" : "var(--grass-700)"}">
          ${days === 0 ? "Free trial ends today" : `${days} day${days === 1 ? "" : "s"} left in your free trial`}
        </div>
        <div class="text-xs" style="color:${urgent ? "var(--under)" : "var(--grass-600)"};opacity:.85">$9.99/month after that — tap to subscribe</div>
      </div>
      <span class="shrink-0" style="color:${urgent ? "var(--under)" : "var(--grass-700)"}">${icon("arrow", 16)}</span>
    </a>`;
}

// supabase-js puts the response body out of reach on a non-2xx: `data` is null
// and all you get is "Edge Function returned a non-2xx status code", which
// tells the user nothing. The real message is in error.context (a Response).
async function edgeErrorMessage(error, data, fallback) {
  if (data?.error) return data.error;
  try {
    const body = await error?.context?.json?.();
    if (body?.error) return body.error;
  } catch { /* body wasn't JSON */ }
  return error?.message || fallback;
}

async function startCheckout(btn, statusEl) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Opening checkout…";
  const { data, error } = await sb.functions.invoke("create-checkout", {
    body: { returnUrl: location.origin + location.pathname },
  });
  if (error || !data?.url) {
    btn.disabled = false;
    btn.textContent = original;
    const msg = await edgeErrorMessage(error, data, "Couldn't start checkout.");
    if (statusEl) {
      statusEl.className = "text-xs mt-3 status-err";
      statusEl.textContent = msg;
    } else {
      toast(msg, true);
    }
    return;
  }
  // Stripe Checkout is a full redirect; card details never touch TeeBoard.
  location.href = data.url;
}

async function openBillingPortal(btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Opening…";
  const { data, error } = await sb.functions.invoke("customer-portal", {
    body: { returnUrl: location.origin + location.pathname },
  });
  if (error || !data?.url) {
    btn.disabled = false;
    btn.textContent = original;
    return toast(await edgeErrorMessage(error, data, "Couldn't open billing portal."), true);
  }
  location.href = data.url;
}

// Blocks the create/admin screens once trial and subscription are both gone.
function renderPaywall(billing, context) {
  const ended = billing ? new Date(billing.trial_ends_at).toLocaleDateString() : "";

  // Native build: state the fact, offer no purchase and no link out. Scoring
  // and leaderboards keep working for players regardless.
  if (IS_NATIVE_APP) {
    app.innerHTML = `
      <section class="panel-dark px-5 pt-6 pb-6 mb-3">
        <div class="eyebrow on-dark mb-2">Organizer tools unavailable</div>
        <h1 class="display" style="font-size:2rem;color:#fff">This account isn't active</h1>
        <p class="mt-3 text-[15px]" style="color:rgba(255,255,255,.6)">
          ${context === "admin"
            ? "Managing tournaments needs an active organizer plan."
            : "Creating tournaments needs an active organizer plan."}
        </p>
      </section>
      <div class="card p-5">
        <p class="text-sm muted">
          Rounds already running are unaffected — players keep scoring and leaderboards stay live.
          You can still open and delete your existing tournaments.
        </p>
      </div>
      <a href="#/" class="btn-secondary w-full mt-3">Back to TeeBoard</a>`;
    return;
  }
  app.innerHTML = `
    <section class="panel-dark px-5 pt-6 pb-6 mb-3">
      <div class="eyebrow on-dark mb-2">Subscription needed</div>
      <h1 class="display" style="font-size:2.1rem;color:#fff">Your free trial has ended</h1>
      <p class="mt-3 text-[15px]" style="color:rgba(255,255,255,.6)">
        ${context === "admin"
          ? "Managing tournaments needs an active subscription."
          : "Creating tournaments needs an active subscription."}
        ${ended ? `Your trial ran out on ${escapeHtml(ended)}.` : ""}
      </p>
    </section>

    <div class="card p-5 mb-3">
      <div class="flex items-baseline gap-2 mb-1">
        <span class="num-display" style="font-size:2.6rem">$9.99</span>
        <span class="eyebrow">per month</span>
      </div>
      <p class="text-sm muted mb-4">Unlimited tournaments, unlimited players, live leaderboards. Cancel any time.</p>
      <button id="subscribe-btn" class="btn-green w-full">Subscribe</button>
      <div id="billing-status" class="text-xs mt-3"></div>
    </div>

    <div class="card p-4">
      <p class="text-xs muted">
        Rounds already running are unaffected — players keep scoring and leaderboards stay live.
        You can still open and delete your existing tournaments.
      </p>
    </div>`;

  document.getElementById("subscribe-btn").addEventListener("click", (e) =>
    startCheckout(e.currentTarget, document.getElementById("billing-status")));
}

// ---------- public landing content ----------
// Shown only to signed-out visitors. Beyond being useful, this is what a
// payment processor's review looks for: what's sold, what it costs, who
// operates it, and how to get hold of them.

// The legal/trading name registered with Stripe. Must match, or activation
// review flags the site as belonging to a different business.
const BUSINESS_NAME = "J&G Labs";
const CONTACT_EMAIL = "jandglabsco@gmail.com";

function marketingHtml() {
  const step = (n, title, body) => `
    <div class="flex gap-3">
      <span class="num-display shrink-0" style="font-size:1.5rem;width:1.6rem;color:var(--grass-600)">${n}</span>
      <div>
        <div class="font-bold text-sm">${title}</div>
        <div class="text-sm muted">${body}</div>
      </div>
    </div>`;

  return `
    <div class="flex items-center gap-3 mt-8 mb-3">
      <h2 class="eyebrow">How it works</h2>
      <div class="flex-1 hairline"></div>
    </div>
    <div class="card p-5 flex flex-col gap-4">
      ${step(1, "Create your tournament", "Search your course and we pull real par, yardage and stroke index. You get a 5-character join code and a QR to print.")}
      ${step(2, "Players join with the code", "No app, no account, no payment. They open the link, find their name or team, and enter scores from their own phone.")}
      ${step(3, "The leaderboard updates live", "Every phone refreshes the moment a score goes in. Ties are settled by scorecard playoff on the hardest holes.")}
    </div>

    <div class="flex items-center gap-3 mt-8 mb-3">
      <h2 class="eyebrow">Pricing</h2>
      <div class="flex-1 hairline"></div>
    </div>
    <div class="card p-5">
      <div class="flex items-baseline gap-2">
        <span class="num-display" style="font-size:2.6rem">$9.99</span>
        <span class="eyebrow">per month</span>
      </div>
      <p class="text-sm muted mt-2 mb-4">
        Billed monthly in USD to the tournament organizer. <b style="color:var(--ink)">First 30 days free</b> — no card
        needed to start. Cancel any time; you keep access until the end of the period you've paid for.
        <b style="color:var(--ink)">Players never pay.</b>
      </p>
      <a href="#/create" class="btn-green w-full">Start your 30-day free trial</a>
    </div>

    <div class="flex items-center gap-3 mt-8 mb-3">
      <h2 class="eyebrow">Contact</h2>
      <div class="flex-1 hairline"></div>
    </div>
    <div class="card p-5">
      <p class="text-sm muted">
        TeeBoard is operated by <b style="color:var(--ink)">${escapeHtml(BUSINESS_NAME)}</b>.
        Questions, billing problems or refund requests:
        <a href="mailto:${CONTACT_EMAIL}" class="link-underline font-semibold" style="color:var(--grass-700)">${CONTACT_EMAIL}</a>
      </p>
      <div class="flex gap-2 mt-4">
        <a href="#/terms" class="btn-secondary flex-1 text-sm">Terms</a>
        <a href="#/privacy" class="btn-secondary flex-1 text-sm">Privacy</a>
        <a href="#/refunds" class="btn-secondary flex-1 text-sm">Refunds</a>
      </div>
    </div>`;
}

// ---------- legal pages ----------
// Plain-language starting points, written to match how TeeBoard actually
// behaves. NOT drafted by a lawyer — see README before taking real payments.

const LEGAL_UPDATED = "1 August 2026";

const LEGAL = {
  terms: {
    eyebrow: "Legal",
    title: "Terms of Service",
    body: `
      <h2>Who we are</h2>
      <p>TeeBoard, operated by J&G Labs ("we", "us"), provides live scoring and leaderboards for golf scrambles and small tournaments at teeboardgolf.com. By creating an account or using the service you agree to these terms.</p>

      <h2>Accounts</h2>
      <p>Organizers need an account. You're responsible for keeping your password secure and for everything done under your account. Players don't need accounts and never pay — they join with a code.</p>

      <h2>Free trial and subscription</h2>
      <p>New organizer accounts get <b>30 days free</b>, starting the day the account is created. No payment details are required to start the trial.</p>
      <p>After the trial, creating and managing tournaments requires an active subscription of <b>$9.99 USD per month</b>. The subscription renews automatically each month until cancelled. Prices are subject to change with at least 30 days' notice.</p>
      <p>If your trial or subscription lapses, tournaments already running keep working — players can still enter scores and leaderboards stay live. You can still view and delete your own tournaments.</p>

      <h2>Cancelling</h2>
      <p>You can cancel at any time from Billing, which opens Stripe's billing portal. Cancellation takes effect at the end of the period you've already paid for; you keep access until then. See our <a href="#/refunds" class="link-underline">Refund Policy</a>.</p>

      <h2>Payments</h2>
      <p>Payments are processed by Stripe. We never see or store your card details. You're responsible for any taxes that apply to you beyond those we're required to collect.</p>

      <h2>Acceptable use</h2>
      <p>Don't use TeeBoard to break the law, to gamble where gambling is illegal, to upload other people's personal data without their knowledge, or to attack or overload the service. We may suspend accounts that do.</p>

      <h2>Your data</h2>
      <p>You keep ownership of the tournaments, rosters and scores you create. We store them so the service works. Deleting a tournament deletes its teams, players and scores permanently.</p>
      <p>Anyone with a tournament's link or join code can view its leaderboard and enter scores for a team. That's how the product is designed to work — don't put anything confidential into team or player names.</p>

      <h2>Availability, and the honest bit</h2>
      <p>TeeBoard is a small product run by a small operation. We don't promise it will be available without interruption, and we don't guarantee it's free of bugs. It's provided "as is", without warranties of any kind.</p>
      <p>To the extent the law allows, our total liability to you for any claim is limited to what you paid us in the 12 months before the claim. We're not liable for indirect or consequential losses — including, to be concrete, a scoring error or outage affecting the result of your event. <b>Don't rely on TeeBoard as the sole record for anything that matters financially.</b> Keep a paper card.</p>

      <h2>Ending things</h2>
      <p>You can stop using TeeBoard and delete your tournaments at any time. We may suspend or end an account that breaks these terms. If we discontinue the service, we'll give reasonable notice so you can export or record your data.</p>

      <h2>Changes</h2>
      <p>We may update these terms. Material changes will be announced in the app before they take effect.</p>

      <h2>Contact</h2>
      <p>Questions about these terms: <a href="mailto:jandglabsco@gmail.com" class="link-underline">jandglabsco@gmail.com</a>.</p>
    `,
  },
  privacy: {
    eyebrow: "Legal",
    title: "Privacy Policy",
    body: `
      <h2>The short version</h2>
      <p>TeeBoard, operated by J&amp;G Labs, collects as little as it can get away with. Players don't have accounts. We don't sell data, we don't run ad networks, and we don't track you across other websites.</p>

      <h2>If you're a player</h2>
      <p>You never create an account. What exists about you is whatever name was typed into a team roster — by you or by your organizer — and the scores entered for your team. That's it.</p>
      <p><b>Anyone with the tournament link or join code can see that.</b> It's designed to work like a scorecard pinned to a clubhouse wall, not a private record. Don't put anything sensitive in a player or team name.</p>
      <p>Your phone also remembers which team you joined, stored locally in your own browser. That never leaves your device except as the team membership above, and clearing your browser data erases it.</p>

      <h2>If you're an organizer</h2>
      <p>We store your email, the first and last name you gave at sign-up, and an encrypted form of your password — we can't read your actual password. We also store the tournaments, rosters and scores you create.</p>
      <p>Email is used to confirm your account, reset your password, and contact you about billing or a problem with the service. We don't send marketing email.</p>

      <h2>Payments</h2>
      <p>Card details are handled entirely by <a href="https://stripe.com/privacy" target="_blank" class="link-underline">Stripe</a> and never reach TeeBoard. We store only Stripe's customer and subscription identifiers, your subscription status, and when the period ends — enough to know whether your account is active.</p>

      <h2>Analytics</h2>
      <p>We count page views to see which screens get used. For each view we record the screen (with tournament ids stripped out), the referring website's name, and a random identifier stored in your browser so repeat views can be counted as one visitor.</p>
      <p>We do <b>not</b> record IP addresses, device or browser details, or anything linking a view to your account. There's no Google Analytics, no advertising pixel, and nothing shared with third parties — which is also why you don't see a cookie banner. Clearing your browser data resets the random identifier.</p>

      <h2>Who else touches your data</h2>
      <ul>
        <li><b>Supabase</b> — hosts the database and accounts.</li>
        <li><b>Stripe</b> — processes payments.</li>
        <li><b>GitHub Pages</b> — serves the website.</li>
        <li><b>OpenGolfAPI</b> — course par, yardage and stroke index. We send it a course name you search for; it receives no information about you.</li>
      </ul>
      <p>Google Fonts and a few code libraries are loaded from public CDNs when the page opens, which necessarily exposes your IP address to them, as with any website.</p>

      <h2>How long we keep things</h2>
      <p>Tournaments, rosters and scores stay until deleted. Deleting a tournament permanently removes its teams, players and scores. Page-view records are kept for statistics and hold nothing identifying.</p>

      <h2>Your choices</h2>
      <p>Organizers can delete their own tournaments at any time from the admin page. To delete your account entirely, or to ask what's held about you, email us and we'll sort it out.</p>
      <p>Players: ask your organizer to remove you from a roster, or email us if that isn't possible.</p>

      <h2>Children</h2>
      <p>TeeBoard isn't aimed at children under 13 and organizer accounts aren't intended for them. A junior player's name may appear on a roster because an organizer entered it; contact us if you'd like it removed.</p>

      <h2>Changes and contact</h2>
      <p>If this policy changes materially we'll say so in the app. Questions, deletion requests or anything else: <a href="mailto:jandglabsco@gmail.com" class="link-underline">jandglabsco@gmail.com</a>.</p>
    `,
  },
  refunds: {
    eyebrow: "Legal",
    title: "Refund Policy",
    body: `
      <h2>The short version</h2>
      <p>You get <b>30 days free</b> before paying anything, so you can decide whether TeeBoard works for your league before spending money. Because of that, we don't routinely refund months you've already used.</p>

      <h2>Cancelling</h2>
      <p>Cancel any time from Billing. You keep full access until the end of the period you've already paid for, and you won't be charged again. We don't charge a cancellation fee.</p>

      <h2>When we will refund</h2>
      <ul>
        <li><b>Charged after cancelling.</b> If you were billed for a period after you cancelled, we'll refund it in full.</li>
        <li><b>Duplicate charges.</b> Billed twice for the same month? We'll refund the duplicate.</li>
        <li><b>Service badly broken.</b> If TeeBoard was substantially unusable for a stretch of a month you paid for, tell us and we'll refund or credit that month.</li>
        <li><b>Accidental renewal.</b> If you meant to cancel and got charged within the last 14 days without using the service in that period, ask and we'll refund it.</li>
      </ul>

      <h2>When we generally won't</h2>
      <ul>
        <li>Months you used normally and then changed your mind about.</li>
        <li>Partial months — we don't pro-rate mid-period cancellations.</li>
        <li>Your league's season ending, if you forgot to cancel beforehand.</li>
      </ul>
      <p>That said, if your situation feels unfair, ask. We'd rather sort it out than argue over $9.99.</p>

      <h2>How to request one</h2>
      <p>Email <a href="mailto:jandglabsco@gmail.com" class="link-underline">jandglabsco@gmail.com</a> from the address on the account, saying which charge you mean and why. We aim to reply within a few days. Approved refunds go back to the original card via Stripe and typically appear within 5–10 business days.</p>

      <h2>Chargebacks</h2>
      <p>Please contact us before disputing a charge with your bank — it's faster and we can usually fix it directly.</p>
    `,
  },
};

// #/stats — visitor numbers. Restricted to comped (owner) accounts by the
// teeboard_stats function itself, not just by hiding the link.
// ---------- CAREER STATS ----------
//
// Players never sign in, so identity here is the name on the roster, trimmed
// and lowercased. That merges "Gabe Herbst" and "gabe herbst" as intended,
// but it cannot tell two different Gabes apart, and it will not connect "Gabe"
// to "Gabe Herbst". Displayed spelling is whichever the player used most
// recently.
//
// Everything is derived by running buildLeaderboard over each tournament —
// the same function the live leaderboards use — so a profile can never
// disagree with the board it came from.

// Order-of-merit points by finishing position. Tied players split the points
// for the places they occupy, which is how real orders of merit handle it:
// two players tied for 1st share 1st and 2nd money, not 1st twice.
const PLACE_POINTS = [100, 75, 60, 50, 45, 40, 36, 32, 29, 26];
const PLACE_POINTS_TAIL = 20;

// The season starts here. Everything before this date was building and
// testing the app, and six weeks of real rounds in between were deleted, so
// counting any of it would produce a table nobody recognises.
const SEASON_START = "2026-09-24";

// Two separate orders of merit. Team-ranked formats (scramble, alternate
// shot, best ball) are one competition; formats where each golfer plays
// their own ball are another. A scramble win and a medal win are not the
// same achievement and shouldn't share a table.
const RANKING_MODES = {
  scramble:   { label: "Scramble",   ranks: "team",   blurb: "Team formats — scramble, alternate shot, best ball." },
  individual: { label: "Individual", ranks: "player", blurb: "Your own ball — stroke play, Stableford, skins." },
};

function pointsForPlace(place) {
  return PLACE_POINTS[place - 1] ?? PLACE_POINTS_TAIL;
}

// A top-three finish has to mean finishing ahead of somebody. Second of two
// is last, not a podium — and a 2-player match was counting the loser's
// second place as one. Requires a top-three place AND a field bigger than it.
function isPodium(place, fieldSize) {
  return place <= 3 && place < fieldSize;
}

function emptyModeStats() {
  return {
    rounds: 0, points: 0, wins: 0, podiums: 0, bestFinish: null, finishes: [],
    // Hole record kept per competition too. A birdie made by a scramble team
    // is not a birdie the individual made with their own ball, and showing
    // the career total on the Individual tab credited them as if it were.
    eagles: 0, birdies: 0, pars: 0, bogeys: 0, doubles: 0, holesPlayed: 0,
  };
}

function emptyPlayerStats(name) {
  return {
    name,
    rounds: 0,
    points: 0,
    wins: 0,
    podiums: 0,
    bestFinish: null,
    finishes: [],          // every place, for an average
    eagles: 0, birdies: 0, pars: 0, bogeys: 0, doubles: 0,
    holesPlayed: 0,
    toPar: 0,              // cumulative, across completed rounds
    history: [],           // one entry per tournament
    // The same record split by competition, so a scramble specialist and a
    // medal player are each rankable without one flattering the other.
    byMode: { scramble: emptyModeStats(), individual: emptyModeStats() },
  };
}

/**
 * Turns the nested tournament payload into per-player career records.
 * `tournaments` must include teams -> team_members and scores.
 */
function buildCareerStats(tournaments, since = SEASON_START) {
  const byKey = new Map();
  const displayName = new Map();
  const cutoff = since ? new Date(since + "T00:00:00Z").getTime() : -Infinity;

  function statsFor(rawName) {
    const key = String(rawName || "").trim().toLowerCase();
    if (!key) return null;
    if (!byKey.has(key)) byKey.set(key, emptyPlayerStats(rawName.trim()));
    // Latest spelling wins, so a tidied-up roster entry propagates.
    displayName.set(key, rawName.trim());
    return byKey.get(key);
  }

  (tournaments || []).forEach((t) => {
    if (new Date(t.created_at).getTime() < cutoff) return;   // before the season
    const teams = t.teams || [];

    // A match is won by winning holes, not by posting a total. Running one
    // through the stroke leaderboard sorted it on a metric that sort does not
    // understand, so the order was arbitrary — it credited the win to the
    // player who lost 6 & 5. Decide it from the match itself.
    if (formatOf(t).match) {
      const m = buildMatch(t, teams);
      if (m.incomplete || !m.played) return;

      const halved = m.up === 0;
      const winnerId = halved ? null : m.leader.id;
      m.sides.forEach((side) => {
        const place = halved || side.id === winnerId ? 1 : 2;
        // A halved match is two firsts, so the two places are shared.
        const points = halved
          ? (pointsForPlace(1) + pointsForPlace(2)) / 2
          : pointsForPlace(place);

        const names = side.players.length ? side.players.map((p) => p.name) : [side.name];
        names.forEach((rawName) => {
          const st = statsFor(rawName);
          if (!st) return;
          const mode = side.players.length > 1 ? "scramble" : "individual";
          const mm = st.byMode[mode];

          st.rounds += 1;
          st.points += points;
          st.finishes.push(place);
          if (st.bestFinish == null || place < st.bestFinish) st.bestFinish = place;
          // Only an outright winner has won something.
          if (!halved && place === 1) st.wins += 1;
          if (isPodium(place, m.sides.length)) st.podiums += 1;

          mm.rounds += 1;
          mm.points += points;
          mm.finishes.push(place);
          if (mm.bestFinish == null || place < mm.bestFinish) mm.bestFinish = place;
          if (!halved && place === 1) mm.wins += 1;
          if (isPodium(place, m.sides.length)) mm.podiums += 1;

          // Holes, where the player actually holed their own ball. Foursomes
          // is one ball between two, so there is no individual record to keep.
          const mine = side.players.find((pl) => pl.name === rawName);
          const mpar = tournamentPar(t);
          let gross = 0, parPlayed = 0, thru = 0;
          if (mine && mine.scoreMap) {
            for (let h = 1; h <= t.num_holes; h++) {
              const strokes = mine.scoreMap[h];
              if (strokes == null) continue;
              st.holesPlayed += 1;
              mm.holesPlayed += 1;
              gross += strokes;
              parPlayed += mpar[h - 1] ?? 4;
              thru += 1;
              switch (holeMarkClass(strokes, mpar[h - 1] ?? 4)) {
                case "eagle":        st.eagles += 1;  mm.eagles += 1;  break;
                case "birdie":       st.birdies += 1; mm.birdies += 1; break;
                case "bogey":        st.bogeys += 1;  mm.bogeys += 1;  break;
                case "double-bogey": st.doubles += 1; mm.doubles += 1; break;
                default:             st.pars += 1;    mm.pars += 1;    break;
              }
            }
          }

          // The round belongs in the player's history like any other, or it
          // simply is not there — which is how a match played today left no
          // trace on the profile of the person who played it.
          st.history.push({
            tournamentId: t.id,
            teamId: side.id,
            name: t.name,
            date: t.created_at,
            format: formatOf(t).label,
            mode,
            place,
            tied: halved,
            contested: true,
            toPar: gross - parPlayed,
            thru,
            numHoles: t.num_holes,
            points,
            matchResult: halved ? "Halved" : (place === 1 ? `Won ${m.label}` : `Lost ${m.label}`),
          });
        });
      });
      return;
    }

    const rows = buildLeaderboard(t, teams);
    const started = rows.filter((r) => r.thru > 0);
    if (!started.length) return;                 // nothing was ever scored

    // A "win" only means something against somebody. A solo outing is a
    // round played, not a title.
    const contested = started.length > 1;
    const par = tournamentPar(t);
    const fmt = formatOf(t);

    // How many rows share each place, so ties can split the points.
    const placeCounts = new Map();
    started.forEach((r) => placeCounts.set(r.place, (placeCounts.get(r.place) || 0) + 1));

    started.forEach((row) => {
      // Who does this row represent? Team formats credit every member;
      // per-player formats credit the one golfer.
      const names = fmt.ranks === "team"
        ? (row.players || [])
        : [row.name];

      const shareCount = placeCounts.get(row.place) || 1;
      // Sum the points for the block of places this tie occupies, then split.
      let blockTotal = 0;
      for (let i = 0; i < shareCount; i++) blockTotal += pointsForPlace(row.place + i);
      const points = contested ? blockTotal / shareCount : 0;

      names.forEach((rawName) => {
        const s = statsFor(rawName);
        if (!s) return;

        const mode = fmt.ranks === "team" ? "scramble" : "individual";
        const m = s.byMode[mode];

        s.rounds += 1;
        s.points += points;
        s.finishes.push(row.place);
        if (s.bestFinish == null || row.place < s.bestFinish) s.bestFinish = row.place;
        if (contested && row.place === 1) s.wins += 1;
        if (contested && isPodium(row.place, started.length)) s.podiums += 1;
        s.toPar += row.toPar;

        m.rounds += 1;
        m.points += points;
        m.finishes.push(row.place);
        if (m.bestFinish == null || row.place < m.bestFinish) m.bestFinish = row.place;
        if (contested && row.place === 1) m.wins += 1;
        if (contested && isPodium(row.place, started.length)) m.podiums += 1;

        for (let h = 1; h <= t.num_holes; h++) {
          const strokes = row.scoreMap[h];
          if (strokes == null) continue;
          s.holesPlayed += 1;
          m.holesPlayed += 1;
          switch (holeMarkClass(strokes, par[h - 1] ?? 4)) {
            case "eagle":        s.eagles += 1;  m.eagles += 1;  break;
            case "birdie":       s.birdies += 1; m.birdies += 1; break;
            case "bogey":        s.bogeys += 1;  m.bogeys += 1;  break;
            case "double-bogey": s.doubles += 1; m.doubles += 1; break;
            default:             s.pars += 1;    m.pars += 1;    break;
          }
        }

        s.history.push({
          tournamentId: t.id,
          teamId: row.teamId,
          name: t.name,
          date: t.created_at,
          format: fmt.label,
          mode,
          place: row.place,
          tied: row.tied,
          contested,
          toPar: row.toPar,
          thru: row.thru,
          numHoles: t.num_holes,
          points,
        });
      });
    });
  });

  const out = [...byKey.entries()].map(([key, s]) => ({
    ...s,
    key,
    name: displayName.get(key) || s.name,
    avgFinish: s.finishes.length
      ? s.finishes.reduce((a, b) => a + b, 0) / s.finishes.length
      : null,
    history: s.history.sort((a, b) => new Date(b.date) - new Date(a.date)),
  }));

  out.sort((a, b) =>
    b.points - a.points ||
    b.wins - a.wins ||
    a.toPar - b.toPar ||
    a.name.localeCompare(b.name));

  return out;
}

// One fetch feeds every career view. Nested so the scoring engine gets the
// same shape the leaderboard builds from.
const CAREER_SELECT =
  "id, name, course_name, format, num_holes, start_hole, status, par, handicap, yardage, skins_buy_in, created_at, " +
  "teams(id, name, signed_at, team_members(id, player_name, handicap), scores(hole_number, strokes, team_member_id))";

let careerCache = null;
async function loadCareerStats(force = false) {
  if (careerCache && !force) return careerCache;
  const { data, error } = await sb.from("tournaments").select(CAREER_SELECT);
  if (error) throw error;
  careerCache = buildCareerStats(data || []);
  return careerCache;
}

// Players who actually competed in this mode, ordered by its points, with
// genuine ties marked. Four players off the same winning team hold the same
// record, so listing them 1-2-3-4 invents an order that doesn't exist.
function rankedFor(players, mode) {
  const list = players
    .filter((p) => p.byMode[mode].rounds > 0)
    .map((p) => ({ ...p, m: p.byMode[mode] }))
    .sort((a, b) =>
      b.m.points - a.m.points ||
      b.m.wins - a.m.wins ||
      a.toPar - b.toPar ||
      a.name.localeCompare(b.name));

  // Same points and same wins is inseparable. Places skip afterwards, so a
  // four-way tie for 1st is followed by 5th, as a leaderboard does.
  const same = (a, b) => a.m.points === b.m.points && a.m.wins === b.m.wins;
  let place = 0;
  list.forEach((p, i) => {
    if (i === 0 || !same(list[i - 1], p)) place = i + 1;
    p.rank = place;
  });
  list.forEach((p, i) => {
    p.tiedRank = list.some((o, j) => j !== i && o.rank === p.rank);
  });
  return list;
}

// ---------- HEADER MENU ----------
// Wired once at load, not per render, so the listeners don't stack up as the
// router redraws the page.

function setMenuOpen(open) {
  const btn = document.getElementById("menu-btn");
  const panel = document.getElementById("menu-panel");
  if (!btn || !panel) return;
  panel.hidden = !open;
  btn.setAttribute("aria-expanded", open ? "true" : "false");
}

function initHeaderMenu() {
  const btn = document.getElementById("menu-btn");
  const panel = document.getElementById("menu-panel");
  if (!btn || !panel) return;

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    setMenuOpen(panel.hidden);
  });

  // A click anywhere else closes it, including on one of its own links —
  // those change the hash, and the panel should not still be hanging open
  // over the page it just navigated to.
  document.addEventListener("click", (e) => {
    if (panel.hidden) return;
    if (!panel.contains(e.target) || e.target.closest(".menuitem")) setMenuOpen(false);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) { setMenuOpen(false); btn.focus(); }
  });

  window.addEventListener("hashchange", () => setMenuOpen(false));
}

// ---------- GOLF NEWS ----------
// Headlines come from the golf-news Edge Function, which reads public feeds
// server side because browsers can't fetch them cross-origin. Rendered after
// the page so a slow or dead feed never delays the scores.

const NEWS_URL = (window.TEEBOARD_CONFIG?.SUPABASE_URL || "") + "/functions/v1/golf-news";

function newsTimeAgo(ts) {
  if (!ts) return "";
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

async function renderNews(slotId = "news-slot") {
  const slot = document.getElementById(slotId);
  if (!slot) return;
  let items = [];
  try {
    const res = await fetch(NEWS_URL, { headers: { apikey: window.TEEBOARD_CONFIG?.SUPABASE_ANON_KEY || "" } });
    if (!res.ok) throw new Error(String(res.status));
    items = (await res.json()).items || [];
  } catch {
    return;                       // no headlines is fine; an error box is not
  }
  if (!items.length) return;

  const [lead, ...rest] = items;
  // The picture is decoration, so it never blocks the headline: it loads
  // lazily and removes itself if it fails, leaving the card as it was.
  const card = (n, big) => `
    <a href="${escapeHtml(n.link)}" target="_blank" rel="noopener noreferrer"
       class="newscard${big ? " lead" : ""}${n.image ? " haspic" : ""}">
      ${n.image ? `<img class="newspic" src="${escapeHtml(n.image)}" alt="" loading="lazy"
                        referrerpolicy="no-referrer"
                        onerror="this.closest('.newscard').classList.remove('haspic'); this.remove();" />` : ""}
      <span class="newsbody">
        <span class="newssrc">${escapeHtml(n.source)}</span>
        <span class="newstitle">${escapeHtml(n.title)}</span>
        ${big && n.summary ? `<span class="newssum">${escapeHtml(n.summary)}</span>` : ""}
        <span class="newsdate">${escapeHtml(newsTimeAgo(n.publishedAt))}</span>
      </span>
    </a>`;

  slot.innerHTML = `
    <div class="sectionbar" style="margin-top:26px">
      <span class="t">Latest news</span><span class="rule"></span>
    </div>
    <div class="newsgrid">
      ${card(lead, true)}
      <div class="newscol">${rest.slice(0, 4).map((n) => card(n, false)).join("")}</div>
    </div>`;
}

// ---------- TOURNAMENT DIRECTORY ----------
// A public board of every tournament, live and finished. Anyone can watch;
// anyone playing in a live one can check in from here rather than needing the
// code handed to them separately.

async function viewTournaments(tab) {
  app.innerHTML = loadingHtml();

  // teams(id) rides along so each row can show a field size without a second
  // round trip per tournament.
  const { data, error } = await sb
    .from("tournaments")
    // signed_at and the score ids are what decide whether a round is still
    // running, so they have to come back with the list.
    // Everything buildLeaderboard needs, so each card can show the top of
    // its own board without a second request per tournament.
    .select("id, name, course_name, format, num_holes, start_hole, status, created_at, par, handicap, skins_buy_in, " +
            "teams(id, name, signed_at, team_members(id, player_name, handicap), scores(hole_number, strokes, team_member_id, updated_at))")
    // Private rounds are unlisted: reachable by link or join code, absent here.
    .eq("is_public", true)
    .order("created_at", { ascending: false });

  if (error) {
    app.innerHTML = `
      <div class="card p-6 mt-4 text-center">
        <h2 class="text-lg mb-2">Couldn't load tournaments</h2>
        <p class="text-sm muted mb-4">${escapeHtml(error.message)}</p>
        <button class="btn-secondary" onclick="location.reload()">Try again</button>
      </div>`;
    return;
  }

  const all = data || [];
  // Tournaments nobody ever scored in are left off the public board
  // entirely. They are not rounds; they are abandoned drafts, and a board
  // full of them is what made a dozen dead tournaments look live.
  const shown = all.filter((t) => tournamentState(t, t.teams) !== "never_started");
  const live = shown.filter((t) => tournamentState(t, t.teams) === "live");
  const past = shown.filter((t) => tournamentState(t, t.teams) !== "live");

  // Card per tournament: navy head carrying the identity, white foot
  // carrying the top of the board — the shape the reference uses so you can
  // read a round without opening it.
  function card(t) {
    const fmt = formatOf(t);
    const teamCount = (t.teams || []).length;
    const state = tournamentState(t, t.teams);
    const isLive = state === "live";
    const when = new Date(t.created_at).toLocaleDateString(undefined,
      { month: "short", day: "numeric", year: "numeric" });

    const rows = (t.rows || []).slice(0, 5);

    return `
      <div class="tcard">
        <div class="tcard-head">
          <div class="flex items-center justify-between gap-2 mb-2.5">
            <span class="pill men">${escapeHtml(fmt.label)}</span>
            ${isLive
              ? `<span class="pill onair"><span class="dot"></span>LIVE</span>`
              : `<span class="pill on-dark">${state === "unfinished" ? "UNFINISHED" : "FINAL"}</span>`}
          </div>
          <a href="#/leaderboard/${t.id}" class="tcard-name block">${escapeHtml(t.name)}</a>
          <div class="tcard-date">
            ${escapeHtml(when)} &nbsp;•&nbsp; ${t.num_holes} holes
            ${t.course_name ? ` &nbsp;•&nbsp; ${escapeHtml(t.course_name)}` : ""}
          </div>
        </div>
        <div class="tcard-body">
          ${t.match ? `
            ${t.match.incomplete
              ? `<p class="text-sm muted text-center py-5">Waiting on the second side.</p>`
              : `<div class="matchmini">
                   <div class="mm-side${t.match.up > 0 ? " ahead" : t.match.up < 0 ? " behind" : ""}">${escapeHtml(
                     t.match.sides[0].players.map((p) => p.name).join(" & ") || t.match.sides[0].name)}</div>
                   <div class="mm-vs">vs</div>
                   <div class="mm-side${t.match.up < 0 ? " ahead" : t.match.up > 0 ? " behind" : ""}">${escapeHtml(
                     t.match.sides[1].players.map((p) => p.name).join(" & ") || t.match.sides[1].name)}</div>
                 </div>
                 <div class="mm-result">${t.match.up === 0
                   ? (t.match.done ? "Match halved" : "All square")
                   : `${escapeHtml(t.match.leader.players.map((p) => p.name).join(" & ") || t.match.leader.name)}
                      ${t.match.done ? "wins" : "leads"} ${escapeHtml(t.match.label)}`}</div>`}
            <a href="#/leaderboard/${t.id}" class="cardbtn">View match</a>
          ` : `
          <div class="seg mb-3">
            <span class="on">${fmt.ranks === "player" ? "Players" : "Teams"}</span>
            <a href="#/leaderboard/${t.id}">Full board</a>
          </div>
          ${rows.length ? `
            <table class="dtable" style="border-radius:8px;overflow:hidden">
              <thead>
                <tr>
                  <th class="l" style="width:2.2rem">#</th>
                  <th class="l">${fmt.ranks === "player" ? "Player" : "Team"}</th>
                  <th class="rule" style="width:4rem">Score</th>
                  <th class="rule" style="width:3.4rem">Thru</th>
                </tr>
              </thead>
              <tbody>
                ${rows.map((r) => `
                  <tr class="tap" onclick="location.hash='#/leaderboard/${t.id}'">
                    <td class="l pos">${r.tied ? "T" : ""}${r.place}</td>
                    <td class="l" style="max-width:0"><div class="nm truncate">${escapeHtml(r.name)}</div></td>
                    <td class="rule"><span class="chip ${r.toPar < 0 ? "under" : "even"}">${r.thru ? toParLabel(r.toPar) : "–"}</span></td>
                    <td class="rule num" style="color:var(--ink-2)">${r.thru || "–"}/${t.num_holes}</td>
                  </tr>`).join("")}
              </tbody>
            </table>
            <a href="#/leaderboard/${t.id}" class="cardbtn">View leaderboard</a>
          ` : `
            <p class="text-sm muted text-center py-6">No scores yet.</p>
            <a href="#/leaderboard/${t.id}" class="cardbtn">View participants</a>`}
          `}
        </div>
      </div>`;
  }

  // Top of each board, so a card can show the leaders without another fetch.
  // A match has no leaderboard — it has a result — so it carries that instead.
  shown.forEach((t) => {
    if (isMatchFormat(t)) t.match = buildMatch(t, t.teams || []);
    else t.rows = buildLeaderboard(t, t.teams || []);
  });

  const boards = { current: live, results: past };
  const active = boards[tab] ? tab : "current";
  const list = boards[active];

  app.innerHTML = `
    <div class="tabs pagetabs">
      <a href="#/tournaments" class="tab${active === "current" ? " is-on" : ""}">Current</a>
      <a href="#/tournaments/results" class="tab${active === "results" ? " is-on" : ""}">Results</a>
    </div>

    <div class="filters">
      <select id="filter-format">
        <option value="">All formats</option>
        ${Object.entries(FORMATS).map(([k, f]) =>
          `<option value="${k}">${escapeHtml(f.label)}</option>`).join("")}
      </select>
      <input id="filter-search" type="search" placeholder="Search" aria-label="Search tournaments" autocomplete="off" />
    </div>

    <div id="tcards" class="cardgrid">
      ${list.length
        ? list.map(card).join("")
        : `<div class="panel p-8 text-center" style="grid-column:1/-1">
             <p class="text-sm muted">${active === "current"
               ? "Nothing underway. Rounds appear here as they're scored."
               : "No completed rounds yet."}</p>
           </div>`}
    </div>
    <p id="tfilter-empty" class="hidden text-sm muted text-center p-6">Nothing matches that.</p>
  `;

  // Filtering happens in the page — everything shown is already loaded, and
  // the list is short enough that a round trip per keystroke would be silly.
  const q = document.getElementById("filter-search");
  const fmtSel = document.getElementById("filter-format");
  const cards = [...app.querySelectorAll("#tcards .tcard")];
  const empty = document.getElementById("tfilter-empty");

  function applyFilters() {
    const text = (q.value || "").trim().toLowerCase();
    const want = fmtSel.value;
    let shownN = 0;
    cards.forEach((el, i) => {
      const t = list[i];
      const hay = `${t.name} ${t.course_name || ""}`.toLowerCase();
      const hit = (!text || hay.includes(text)) && (!want || t.format === want);
      el.style.display = hit ? "" : "none";
      if (hit) shownN++;
    });
    if (empty) empty.classList.toggle("hidden", shownN > 0 || !cards.length);
  }
  if (q) q.addEventListener("input", applyFilters);
  if (fmtSel) fmtSel.addEventListener("change", applyFilters);
}

// ---------- WHAT I RUN ----------
//
// Everything this account created, with the codes and a way in to manage it.
// Derived from created_by alone — nothing device-local feeds it, so signing in
// on someone else's phone shows your rounds and not theirs.

async function viewMine() {
  app.innerHTML = loadingHtml();
  const user = await getUser();
  if (!user) return renderAuthGate();

  const { data, error } = await sb
    .from("tournaments")
    .select("id, name, join_code, format, num_holes, status, created_at, course_name, is_public")
    .eq("created_by", user.id)
    .order("created_at", { ascending: false });

  if (error) {
    app.innerHTML = `<div class="card p-6 mt-4 text-center">
      <h2 class="text-lg mb-2">Couldn't load your rounds</h2>
      <p class="text-sm muted">${escapeHtml(error.message)}</p></div>`;
    return;
  }

  const all = data || [];
  const matches = all.filter((t) => isTwoSidedFormat(t));
  const tournaments = all.filter((t) => !isTwoSidedFormat(t));

  const row = (t) => `
    <div class="ownrow">
      <div class="min-w-0 flex-1">
        <a href="#/leaderboard/${t.id}" class="own-name">${escapeHtml(t.name)}</a>
        <div class="own-meta">
          ${escapeHtml(formatOf(t).label)} · ${t.num_holes} holes
          ${t.course_name ? ` · ${escapeHtml(t.course_name)}` : ""}
          ${t.is_public === false ? ` · <span style="color:var(--ink-3)">Private</span>` : ""}
        </div>
      </div>
      <button class="own-code" data-copy="${escapeHtml(t.join_code)}"
              title="Copy the join code">${escapeHtml(t.join_code)}</button>
      <a href="#/admin/${t.id}" class="own-manage">Manage</a>
    </div>`;

  const block = (title, list, emptyText) => `
    <div class="sectionbar mt-5"><span class="t">${title}</span><span class="rule"></span></div>
    ${list.length ? list.map(row).join("") : `<p class="text-sm muted p-4 text-center">${emptyText}</p>`}`;

  app.innerHTML = `
    <div class="idband">
      <div class="idname" style="font-size:1.3rem">What I run</div>
      <div class="idsub">${all.length} round${all.length === 1 ? "" : "s"} created on this account</div>
    </div>

    ${block("Matches", matches, "No matches yet.")}
    ${block("Tournaments", tournaments, "No tournaments yet.")}

    <div class="flex gap-2 mt-5">
      <a href="#/match" class="btn-secondary flex-1 text-center">Create a match</a>
      <a href="#/create" class="btn-secondary flex-1 text-center">Create a tournament</a>
    </div>
    <p class="text-xs muted-2 text-center mt-3">Tap a code to copy it. Anyone with the code can score.</p>
  `;

  app.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        toast(`Copied ${btn.dataset.copy}`);
      } catch {
        toast("Couldn't copy — the code is on screen", true);
      }
    });
  });
}

// ---------- PLAYER RANKINGS ----------

async function viewPlayers(modeRaw) {
  const mode = RANKING_MODES[modeRaw] ? modeRaw : "scramble";
  app.innerHTML = loadingHtml();

  let players;
  try {
    players = await loadCareerStats();
  } catch (err) {
    app.innerHTML = `
      <div class="card p-6 mt-4 text-center">
        <h2 class="text-lg mb-2">Couldn't load rankings</h2>
        <p class="text-sm muted">${escapeHtml(err.message || String(err))}</p>
      </div>`;
    return;
  }

  const ranked = rankedFor(players, mode);
  const seasonLabel = new Date(SEASON_START + "T00:00:00Z")
    .toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

  app.innerHTML = `
    <div class="idband">
      <div class="idname" style="font-size:1.3rem">Order of merit</div>
      <div class="idsub">Season from ${escapeHtml(seasonLabel)}</div>
      <div class="tabs">
        ${Object.entries(RANKING_MODES).map(([key, m]) =>
          `<a href="#/players/${key}" class="tab${key === mode ? " is-on" : ""}">${m.label}</a>`).join("")}
      </div>
    </div>

    <div class="flex items-center gap-2 mt-3 mb-2">
      <input id="player-search" type="search" inputmode="search" autocomplete="off"
             placeholder="Search players" aria-label="Search players"
             style="flex:1;padding:.5rem .7rem;font-size:.85rem" />
    </div>
    <p class="text-xs muted-2 mb-2">${escapeHtml(RANKING_MODES[mode].blurb)}</p>

    ${ranked.length === 0 ? `
      <div class="panel p-6 text-center mt-2">
        <div class="font-semibold mb-1">No ${escapeHtml(RANKING_MODES[mode].label.toLowerCase())} rounds yet this season</div>
        <p class="text-sm muted">Rankings appear once scores go in.</p>
      </div>` : `
      <div class="panel mt-2">
        <table class="dtable">
          <thead>
            <tr>
              <th class="l" style="width:2.4rem">#</th>
              <th class="l">Player</th>
              <th class="rule" style="width:3.4rem">Pts</th>
              <th class="rule" style="width:2.8rem">W</th>
              <th class="rule" style="width:2.8rem">Rds</th>
            </tr>
          </thead>
          <tbody>
            ${ranked.map((p) => `
              <tr class="tap prow" data-name="${escapeHtml(p.name.toLowerCase())}"
                  onclick="location.hash='#/player/${encodeURIComponent(p.key)}'">
                <td class="l pos">${p.tiedRank ? "T" : ""}${p.rank}</td>
                <td class="l" style="max-width:0">
                  <div class="nm truncate">${escapeHtml(p.name)}</div>
                  <div class="sub truncate">
                    ${p.m.birdies} birdie${p.m.birdies === 1 ? "" : "s"}${p.m.eagles ? ` · ${p.m.eagles} eagle${p.m.eagles === 1 ? "" : "s"}` : ""}${
                      mode === "individual" ? "" : " (team)"}
                  </div>
                </td>
                <td class="rule"><span class="chip">${Math.round(p.m.points)}</span></td>
                <td class="rule num" style="font-weight:600">${p.m.wins || "–"}</td>
                <td class="rule num" style="color:var(--ink-2)">${p.m.rounds}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>

      <p id="search-empty" class="hidden text-sm muted text-center p-6">No player by that name.</p>

      <p class="text-xs muted-2 text-center mt-4 leading-relaxed">
        1st is worth ${PLACE_POINTS[0]} points, 2nd ${PLACE_POINTS[1]}, 3rd ${PLACE_POINTS[2]}, down to
        ${PLACE_POINTS_TAIL} for anyone outside the top ${PLACE_POINTS.length}.
        Ties split the points for the places they cover. A round with only one
        team on the board scores no points.
      </p>`}
  `;

  // Filtering in the page rather than refetching: the whole season is
  // already here, and a golfer looking for their own name expects it to
  // narrow as they type.
  const search = document.getElementById("player-search");
  if (search) {
    const rows = [...app.querySelectorAll(".prow")];
    const empty = document.getElementById("search-empty");
    search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      let shown = 0;
      rows.forEach((r) => {
        const hit = !q || r.dataset.name.includes(q);
        r.style.display = hit ? "" : "none";
        if (hit) shown++;
      });
      if (empty) empty.classList.toggle("hidden", shown > 0);
    });
  }
}

// ---------- PLAYER PROFILE ----------

async function viewPlayer(keyRaw) {
  app.innerHTML = loadingHtml();
  const key = decodeURIComponent(keyRaw || "").toLowerCase();

  let players;
  try {
    players = await loadCareerStats();
  } catch (err) {
    app.innerHTML = notFoundHtml("Player");
    return;
  }

  const p = players.find((x) => x.key === key);
  if (!p) {
    app.innerHTML = notFoundHtml("Player");
    return;
  }

  const scoringHoles = p.holesPlayed || 1;
  const pct = (n) => `${Math.round((n / scoringHoles) * 100)}%`;
  const rankIn = (mode) => {
    const row = rankedFor(players, mode).find((x) => x.key === key);
    return row ? { rank: row.rank, tied: row.tiedRank } : null;
  };
  const scrambleRank = rankIn("scramble");
  const individualRank = rankIn("individual");
  const best = [scrambleRank, individualRank].filter(Boolean)
    .sort((a, b) => a.rank - b.rank)[0] || null;
  const bestRank = best ? `${best.tied ? "T" : ""}${best.rank}` : null;


  app.innerHTML = `
    <div class="idband">
      <div class="idband-top">
        <div class="idband-meta">
          ${bestRank ? `<span class="pill on-dark">#${bestRank} THIS SEASON</span>` : ""}
          <div class="idname">${escapeHtml(p.name)}</div>
          <div class="idsub">${p.rounds} round${p.rounds === 1 ? "" : "s"} · ${p.holesPlayed} holes</div>
        </div>
      </div>
      <div class="statstrip">
        <div><div class="v" style="color:${p.wins ? "var(--gold)" : "#fff"}">${p.wins}</div><div class="k">Wins</div></div>
        <div><div class="v" style="color:#fff">${p.podiums}</div><div class="k">Top 3</div></div>
        <div><div class="v" style="color:#fff">${p.bestFinish ?? "–"}</div><div class="k">Best</div></div>
        <div><div class="v" style="color:#fff">${p.avgFinish ? p.avgFinish.toFixed(1) : "–"}</div><div class="k">Avg</div></div>
      </div>
      <div class="tabs">
        <a href="#/players" class="tab">Rankings</a>
        <span class="tab is-on">Card</span>
      </div>
    </div>

    <div class="sectionbar"><span class="t">Points</span><span class="rule"></span></div>
    <div class="panel">
      <table class="dtable">
        <tbody>
          ${Object.entries(RANKING_MODES).map(([key, m]) => {
            const ms = p.byMode[key];
            const rr = key === "scramble" ? scrambleRank : individualRank;
            const r = rr ? `${rr.tied ? "T" : ""}${rr.rank}` : null;
            return `
              <tr class="tap" onclick="location.hash='#/players/${key}'">
                <td class="l">
                  <div class="nm">${m.label}</div>
                  <div class="sub">${ms.rounds === 0 ? "No rounds yet"
                    : `${r ? `#${r} · ` : ""}${ms.wins} win${ms.wins === 1 ? "" : "s"} · ${ms.rounds} round${ms.rounds === 1 ? "" : "s"}`}</div>
                </td>
                <td class="rule" style="width:4rem">
                  ${ms.rounds === 0 ? `<span class="chip none">—</span>` : `<span class="chip">${Math.round(ms.points)}</span>`}
                </td>
              </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>

    <div class="sectionbar"><span class="t">Scoring</span><span class="rule"></span><span class="n">${p.holesPlayed} holes</span></div>
    <div class="panel">
      <table class="dtable">
        <tbody>
          ${[
            ["Eagles", p.eagles, "eagle"],
            ["Birdies", p.birdies, "birdie"],
            ["Pars", p.pars, ""],
            ["Bogeys", p.bogeys, "bogey"],
            ["Doubles+", p.doubles, "double-bogey"],
          ].map(([label, n, cls]) => `
            <tr>
              <td class="l" style="width:2.6rem">
                <span class="hole-mark ${cls}" style="width:26px;height:26px;line-height:26px;font-size:.8rem">${n}</span>
              </td>
              <td class="l nm">${label}</td>
              <td class="rule num" style="width:4rem;color:var(--ink-2)">${pct(n)}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>

    <div class="sectionbar"><span class="t">Rounds</span><span class="rule"></span><span class="n">${p.history.length}</span></div>
    <div class="panel">
      <table class="dtable">
        <tbody>
          ${p.history.map((h) => `
            <tr class="tap" onclick="location.hash='#/leaderboard/${h.tournamentId}'">
              <td class="l pos">${h.tied ? "T" : ""}${h.place}</td>
              <td class="l" style="max-width:0">
                <div class="nm truncate">${escapeHtml(h.name)}</div>
                <div class="sub truncate">
                  ${escapeHtml(h.format)} · ${new Date(h.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}${h.contested ? "" : " · unopposed"}${h.matchResult ? ` · ${escapeHtml(h.matchResult)}` : ""}
                </div>
              </td>
              <td class="rule" style="width:4rem">
                <span class="chip ${h.toPar < 0 ? "under" : h.toPar === 0 ? "even" : "over"}">${h.thru ? toParLabel(h.toPar) : "–"}</span>
              </td>
              <td class="rule num" style="width:3.4rem;color:var(--ink-2)">${Math.round(h.points)}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>

    <p class="text-xs muted-2 text-center mt-4 leading-relaxed">
      Players are matched by the name on the roster. Two people with the same
      name share a profile, and the same person entered differently counts twice.
    </p>
  `;
}

// ---------- ADMIN: USERS ----------
// Deleting a tournament lives here and nowhere else. There is no DELETE
// policy on the table, so even a forged client can't get at it — every
// delete goes through admin_delete_tournament, which checks the caller.

async function isTeeboardAdmin() {
  if (adminIsAdmin !== null) return adminIsAdmin;
  const { data } = await sb.rpc("is_teeboard_admin");
  adminIsAdmin = !!data;
  return adminIsAdmin;
}

async function viewUsers() {
  app.innerHTML = loadingHtml();

  const { data, error } = await sb.rpc("admin_list_organizers");
  if (error) {
    app.innerHTML = `
      <section class="panel-dark px-5 pt-6 pb-6 mb-3">
        <div class="eyebrow on-dark mb-2">Restricted</div>
        <h1 class="display" style="font-size:2rem;color:#fff">Admins only</h1>
        <p class="mt-3 text-[15px]" style="color:rgba(255,255,255,.6)">
          This page is for account administrators.
        </p>
      </section>
      <a href="#/" class="btn-secondary w-full">Back to TeeBoard</a>`;
    return;
  }

  const users = data || [];
  const totalTournaments = users.reduce((n, u) => n + Number(u.tournament_count || 0), 0);

  function tRow(t, email) {
    const scores = Number(t.scores || 0);
    const label = scores === 0
      ? `<span class="pill">NEVER STARTED</span>`
      : t.status !== "active"
        ? `<span class="pill">CLOSED</span>`
        : `<span class="pill">${scores} scores</span>`;
    return `
      <div class="flex items-center gap-2 py-2.5" style="border-top:1px solid var(--line)">
        <div class="min-w-0 flex-1">
          <div class="text-sm font-semibold truncate">${escapeHtml(t.name)}</div>
          <div class="text-[11px] muted-2">
            ${new Date(t.created_at).toLocaleDateString()} · ${t.teams} team${Number(t.teams) === 1 ? "" : "s"} · ${scores} score${scores === 1 ? "" : "s"}
          </div>
        </div>
        ${label}
        <a href="#/leaderboard/${t.id}" class="btn-ghost text-xs shrink-0">View</a>
        <button class="btn-danger text-xs shrink-0 admin-del"
                data-id="${escapeHtml(t.id)}"
                data-name="${escapeHtml(t.name)}"
                data-scores="${scores}"
                data-email="${escapeHtml(email || "")}">Delete</button>
      </div>`;
  }

  app.innerHTML = `
    <section class="panel-dark px-5 pt-6 pb-5 mb-4">
      <div class="eyebrow on-dark mb-2">Admin</div>
      <h1 class="display" style="font-size:2rem;color:#fff">Users</h1>
      <p class="mt-2 text-[15px]" style="color:rgba(255,255,255,.6)">
        ${users.length} account${users.length === 1 ? "" : "s"} · ${totalTournaments} tournament${totalTournaments === 1 ? "" : "s"}
      </p>
    </section>

    ${users.map((u) => `
      <div class="card p-4 mb-2.5">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="font-semibold text-sm truncate">${escapeHtml(u.full_name || u.email)}</div>
            <div class="text-[11px] muted-2 truncate">${escapeHtml(u.email)}</div>
            <div class="text-[11px] muted-2 mt-1">
              Joined ${new Date(u.created_at).toLocaleDateString()} ·
              ${u.tournament_count} tournament${Number(u.tournament_count) === 1 ? "" : "s"}
            </div>
          </div>
          <div class="flex flex-col items-end gap-1 shrink-0">
            ${u.is_admin ? `<span class="pill open">ADMIN</span>` : ""}
            ${u.is_exempt ? `<span class="pill">FREE</span>` : ""}
          </div>
        </div>
        ${(u.tournaments || []).length
          ? `<div class="mt-2">${(u.tournaments || []).map((t) => tRow(t, u.email)).join("")}</div>`
          : `<p class="text-xs muted-2 mt-2">No tournaments.</p>`}
      </div>`).join("")}

    <p class="text-xs muted-2 text-center mt-4 leading-relaxed">
      Deleting a tournament removes its teams, players and scores permanently,
      and takes those rounds out of the player rankings. There is no undo.
    </p>
  `;

  app.querySelectorAll(".admin-del").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const { id, name, scores } = btn.dataset;
      const n = Number(scores || 0);
      // Anything with scores in it is somebody's round. Make that explicit
      // rather than letting a stray tap erase a night of golf.
      const warning = n > 0
        ? `Delete "${name}"?\n\nThis round has ${n} score${n === 1 ? "" : "s"} recorded. Deleting removes its teams, players and scores permanently and takes it out of the rankings.\n\nThis cannot be undone.`
        : `Delete "${name}"?\n\nNothing was ever scored in it. This cannot be undone.`;
      if (!confirm(warning)) return;

      btn.disabled = true;
      btn.textContent = "Deleting…";
      const { data: deleted, error: delErr } = await sb.rpc("admin_delete_tournament", { p_id: id });
      if (delErr) {
        toast("Couldn't delete: " + (delErr.message || delErr), true);
        btn.disabled = false;
        btn.textContent = "Delete";
        return;
      }
      toast(`Deleted "${deleted || name}"`);
      careerCache = null;         // rankings no longer include it
      viewUsers();
    });
  });
}

async function viewStats() {
  app.innerHTML = loadingHtml();
  const user = await getUser();
  if (!user) return renderAuthGate();

  const days = parseInt(new URLSearchParams(location.hash.split("?")[1] || "").get("days"), 10) || 30;
  const { data, error } = await sb.rpc("teeboard_stats", { days });

  if (error || !data) {
    app.innerHTML = `
      <div class="card p-6 mt-4 text-center">
        <div class="eyebrow mb-2">Stats</div>
        <p class="font-bold mb-1">Not available</p>
        <p class="text-sm muted mb-4">${escapeHtml(error?.message || "Only the owner account can view these.")}</p>
        <a href="#/" class="btn-secondary">Back</a>
      </div>`;
    return;
  }

  const peak = Math.max(1, ...(data.by_day || []).map((d) => d.visitors));
  const bars = (data.by_day || []).slice(-30);

  app.innerHTML = `
    <section class="panel-dark px-5 pt-5 pb-5 mb-2.5">
      <div class="eyebrow on-dark mb-2">Last ${data.days} days</div>
      <h1 class="display" style="font-size:2rem;color:#fff">Site traffic</h1>
      <div class="grid grid-cols-3 gap-3 mt-4 pt-4" style="border-top:1px solid rgba(255,255,255,.09)">
        <div>
          <div class="num-display" style="font-size:2rem;color:#fff">${data.visitors}</div>
          <div class="eyebrow on-dark mt-1">Visitors</div>
        </div>
        <div>
          <div class="num-display" style="font-size:2rem;color:#fff">${data.views}</div>
          <div class="eyebrow on-dark mt-1">Views</div>
        </div>
        <div>
          <div class="num-display" style="font-size:2rem;color:var(--grass-400)">${data.today}</div>
          <div class="eyebrow on-dark mt-1">Today</div>
        </div>
      </div>
    </section>

    ${bars.length ? `
      <div class="card p-5 mb-2.5">
        <div class="eyebrow mb-3">Visitors per day</div>
        <div class="flex items-end gap-1" style="height:5rem">
          ${bars.map((d) => `
            <div class="flex-1 rounded-t" title="${escapeHtml(d.day)}: ${d.visitors}"
                 style="height:${Math.max(4, Math.round((d.visitors / peak) * 100))}%;background:var(--grass-500);min-width:3px"></div>
          `).join("")}
        </div>
        <div class="flex justify-between mt-2">
          <span class="eyebrow">${escapeHtml(bars[0]?.day || "")}</span>
          <span class="eyebrow">${escapeHtml(bars[bars.length - 1]?.day || "")}</span>
        </div>
      </div>` : `
      <div class="card p-6 text-center mb-2.5">
        <p class="font-semibold mb-1">No views recorded yet</p>
        <p class="text-sm muted">Tracking started just now — come back after some traffic.</p>
      </div>`}

    ${(data.top_pages || []).length ? `
      <div class="flex items-center gap-3 mt-6 mb-2.5">
        <h2 class="eyebrow">Most viewed screens</h2><span class="flex-1 hairline"></span>
      </div>
      <div class="card overflow-hidden">
        ${data.top_pages.map((p) => `
          <div class="flex items-center justify-between px-4 py-2.5" style="border-top:1px solid var(--line)">
            <span class="text-sm truncate" style="font-family:ui-monospace,monospace">${escapeHtml(p.path)}</span>
            <span class="shrink-0 ml-3"><span class="num-display">${p.views}</span>
              <span class="eyebrow ml-1">${p.visitors} ppl</span></span>
          </div>`).join("")}
      </div>` : ""}

    ${(data.referrers || []).length ? `
      <div class="flex items-center gap-3 mt-6 mb-2.5">
        <h2 class="eyebrow">Where they came from</h2><span class="flex-1 hairline"></span>
      </div>
      <div class="card overflow-hidden">
        ${data.referrers.map((r) => `
          <div class="flex items-center justify-between px-4 py-2.5" style="border-top:1px solid var(--line)">
            <span class="text-sm truncate">${escapeHtml(r.source)}</span>
            <span class="num-display shrink-0 ml-3">${r.visitors}</span>
          </div>`).join("")}
      </div>` : ""}

    <div class="grid grid-cols-3 gap-2 mt-4">
      ${[7, 30, 90].map((d) => `
        <a href="#/stats?days=${d}" class="btn-secondary text-sm ${d === data.days ? "" : ""}"
           style="${d === data.days ? "border-color:var(--ink);font-weight:700" : ""}">${d} days</a>`).join("")}
    </div>
    <a href="#/" class="btn-ghost block text-center mt-4">Back to TeeBoard</a>`;
}

function viewLegal(which) {
  const doc = LEGAL[which];
  if (!doc) return viewHome();
  app.innerHTML = `
    <div class="mb-4">
      <div class="eyebrow mb-1">${doc.eyebrow}</div>
      <h1 class="text-2xl">${doc.title}</h1>
      <p class="text-sm muted mt-1">Last updated ${LEGAL_UPDATED}</p>
    </div>
    <div class="card p-5 legal-doc">${doc.body}</div>
    <div class="grid grid-cols-3 gap-2 mt-3">
      ${["terms", "privacy", "refunds"].filter((k) => k !== which).map((k) => `
        <a href="#/${k}" class="btn-secondary text-sm">${LEGAL[k].title.replace(" of Service", "").replace(" Policy", "")}</a>
      `).join("")}
      <a href="#/" class="btn-secondary text-sm">Back</a>
    </div>`;
  window.scrollTo(0, 0);
}

// #/billing — subscribe, or manage an existing subscription.
async function viewBilling() {
  if (IS_NATIVE_APP) return viewHome();
  app.innerHTML = loadingHtml();
  const user = await getUser();
  if (!user) return renderAuthGate();

  // Coming back from Stripe: the webhook may not have landed yet, so re-read
  // once rather than showing a stale "not subscribed".
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  if (params.get("checkout") === "success") {
    await new Promise((r) => setTimeout(r, 1500));
  }
  const b = await getBilling(true);

  const active = ["active", "trialing"].includes(b?.subscription_status);
  const renews = b?.current_period_end ? new Date(b.current_period_end).toLocaleDateString() : null;

  app.innerHTML = `
    <div class="mb-4">
      <div class="eyebrow mb-1">Account</div>
      <h1 class="text-2xl">Billing</h1>
      <p class="text-sm muted mt-1">${escapeHtml(user.email)}</p>
    </div>

    ${b?.is_exempt ? `
      <div class="card p-5 text-center">
        <div class="mx-auto mb-3 flex items-center justify-center rounded-2xl"
             style="width:3rem;height:3rem;background:var(--grass-100);color:var(--grass-700)">${icon("check", 22)}</div>
        <p class="font-bold mb-1">No subscription needed</p>
        <p class="text-sm muted">This account has full access permanently.</p>
      </div>
    ` : active ? `
      <div class="card p-5 mb-3">
        <div class="flex items-center justify-between mb-3">
          <span class="eyebrow">Status</span>
          <span class="pill open"><span class="dot"></span>${escapeHtml(b.subscription_status)}</span>
        </div>
        <div class="flex items-baseline gap-2 mb-1">
          <span class="num-display" style="font-size:2.2rem">$9.99</span>
          <span class="eyebrow">per month</span>
        </div>
        ${renews ? `<p class="text-sm muted mt-2">Renews ${escapeHtml(renews)}.</p>` : ""}
      </div>
      <button id="portal-btn" class="btn-secondary w-full">Manage billing</button>
      <p class="text-xs muted-2 text-center mt-2">Update your card, view invoices or cancel — handled by Stripe.</p>
    ` : `
      ${params.get("checkout") === "success" ? `
        <div class="card p-3.5 mb-3 flex items-start gap-3" style="background:var(--grass-100);border-color:var(--grass-200)">
          <span class="shrink-0 mt-0.5" style="color:var(--grass-700)">${icon("check", 18)}</span>
          <p class="text-sm" style="color:var(--grass-700)">Payment received — if this page still says inactive, give it a few seconds and refresh.</p>
        </div>` : ""}
      <div class="card p-5 mb-3">
        <div class="eyebrow mb-2">${trialDaysLeft(b) > 0 ? `Free trial · ${trialDaysLeft(b)} days left` : "Trial ended"}</div>
        <div class="flex items-baseline gap-2 mb-1">
          <span class="num-display" style="font-size:2.6rem">$9.99</span>
          <span class="eyebrow">per month</span>
        </div>
        <p class="text-sm muted mb-4">Unlimited tournaments, unlimited players, live leaderboards. Cancel any time.</p>
        ${trialDaysLeft(b) > 0 ? `
          <div class="flex items-start gap-2.5 p-3 rounded-lg mb-4" style="background:var(--grass-100)">
            <span class="shrink-0 mt-0.5" style="color:var(--grass-700)">${icon("check", 16)}</span>
            <p class="text-sm" style="color:var(--grass-700)">
              <b>You won't be charged today.</b> Your free trial runs to
              ${escapeHtml(new Date(b.trial_ends_at).toLocaleDateString())} — the first $9.99 comes out then,
              and only if you haven't cancelled.
            </p>
          </div>` : ""}
        <button id="subscribe-btn" class="btn-green w-full">
          ${trialDaysLeft(b) > 0 ? "Add payment method" : "Subscribe"}
        </button>
        <div id="billing-status" class="text-xs mt-3"></div>
      </div>
    `}

    <a href="#/" class="btn-ghost block text-center mt-4">Back to TeeBoard</a>`;

  const sub = document.getElementById("subscribe-btn");
  if (sub) sub.addEventListener("click", (e) =>
    startCheckout(e.currentTarget, document.getElementById("billing-status")));
  const portal = document.getElementById("portal-btn");
  if (portal) portal.addEventListener("click", (e) => openBillingPortal(e.currentTarget));
}

// ---------- sign-up throttling ----------
// Client-side guard only. Supabase enforces the real limits server-side; this
// exists so someone hammering the button gets a clear countdown instead of a
// wall of "email rate limit exceeded" errors, and so we stop firing requests
// we already know will be rejected.
const SIGNUP_MAX_ATTEMPTS = 3;
const SIGNUP_WINDOW_MS = 15 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;

function authAttempts() {
  const cutoff = Date.now() - SIGNUP_WINDOW_MS;
  return load("bb_auth_attempts", []).filter((t) => t > cutoff);
}
function recordAuthAttempt() {
  const list = authAttempts();
  list.push(Date.now());
  store("bb_auth_attempts", list);
}
// Milliseconds until another sign-up is allowed, or 0 if one is allowed now.
function signupBlockedFor() {
  const list = authAttempts();
  if (list.length < SIGNUP_MAX_ATTEMPTS) return 0;
  return Math.max(0, list[0] + SIGNUP_WINDOW_MS - Date.now());
}
function humanDuration(ms) {
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s} second${s === 1 ? "" : "s"}`;
  const m = Math.ceil(s / 60);
  return `${m} minute${m === 1 ? "" : "s"}`;
}

function renderAuthGate() {
  // Default to Sign Up: most people hitting this gate are brand new
  // organizers who don't have an account yet. Returning organizers can
  // still tap "Sign In".
  let mode = "signup";       // "signup" | "signin" | "forgot"
  let pendingEmail = null;   // set once a confirmation email has gone out
  let resendAt = 0;          // timestamp the resend button unlocks
  let resetSentTo = null;    // set once a reset email has gone out

  function drawPending() {
    app.innerHTML = `
      <div class="mb-4">
        <div class="eyebrow mb-1">Almost there</div>
        <h1 class="text-2xl">Check your email</h1>
      </div>
      <div class="card p-6 text-center">
        <div class="mx-auto mb-4 flex items-center justify-center rounded-2xl"
             style="width:3.5rem;height:3.5rem;background:var(--grass-100);color:var(--grass-700)">${icon("check", 26)}</div>
        <p class="text-sm muted mb-1">We sent a confirmation link to</p>
        <p class="font-bold mb-4 break-all">${escapeHtml(pendingEmail)}</p>
        <p class="text-xs muted-2 mb-5">Open it on this device if you can — the link signs you straight in. It expires in 24 hours.</p>
        <button id="resend-btn" class="btn-secondary w-full mb-2">Resend email</button>
        <button id="back-to-auth" class="btn-ghost">Use a different email</button>
        <div id="auth-status" class="text-xs mt-3"></div>
      </div>
    `;

    const resendBtn = document.getElementById("resend-btn");
    const tick = () => {
      const left = resendAt - Date.now();
      if (left > 0) {
        resendBtn.disabled = true;
        resendBtn.textContent = `Resend in ${Math.ceil(left / 1000)}s`;
        setTimeout(tick, 500);
      } else {
        resendBtn.disabled = false;
        resendBtn.textContent = "Resend email";
      }
    };
    tick();

    resendBtn.addEventListener("click", async () => {
      const statusEl = document.getElementById("auth-status");
      resendBtn.disabled = true;
      statusEl.className = "text-xs mt-3 status-info";
      statusEl.textContent = "Sending…";
      const { error } = await sb.auth.resend({
        type: "signup",
        email: pendingEmail,
        options: { emailRedirectTo: authRedirectTo() },
      });
      if (error) {
        statusEl.className = "text-xs mt-3 status-err";
        statusEl.textContent = error.message;
        resendBtn.disabled = false;
        return;
      }
      resendAt = Date.now() + RESEND_COOLDOWN_MS;
      statusEl.className = "text-xs mt-3 status-ok";
      statusEl.textContent = "Sent — check your inbox and spam folder.";
      tick();
    });

    document.getElementById("back-to-auth").addEventListener("click", () => {
      pendingEmail = null;
      mode = "signup";
      draw();
    });
  }

  function drawForgot() {
    app.innerHTML = `
      <div class="mb-4">
        <div class="eyebrow mb-1">Password reset</div>
        <h1 class="text-2xl">Forgot your password?</h1>
      </div>
      <div class="card p-5">
        ${resetSentTo ? `
          <div class="flex items-start gap-3 p-3 rounded-lg mb-4" style="background:var(--grass-100)">
            <span class="shrink-0 mt-0.5" style="color:var(--grass-700)">${icon("check", 18)}</span>
            <p class="text-sm" style="color:var(--grass-700)">
              If an account exists for <b>${escapeHtml(resetSentTo)}</b>, a reset link is on its way.
              It lasts one hour and can only be used once.
            </p>
          </div>
        ` : `
          <p class="text-sm muted mb-4">Enter your email and we'll send a link to set a new one. Open it in this browser.</p>
        `}
        <label class="field-label">Email</label>
        <input id="forgot-email" type="email" autocomplete="email" placeholder="you@email.com" class="mb-4"
               value="${escapeHtml(resetSentTo || "")}" />
        <button id="send-reset" class="btn-primary w-full mb-2">${resetSentTo ? "Send again" : "Send reset link"}</button>
        <button id="back-to-signin" class="btn-ghost">Back to sign in</button>
        <div id="auth-status" class="text-xs mt-3"></div>
      </div>`;

    const btn = document.getElementById("send-reset");
    const statusEl = document.getElementById("auth-status");

    // Cooldown so repeat taps don't trip Supabase's own email rate limit.
    const tick = () => {
      const left = resendAt - Date.now();
      if (left > 0) {
        btn.disabled = true;
        btn.textContent = `Send again in ${Math.ceil(left / 1000)}s`;
        setTimeout(tick, 500);
      } else {
        btn.disabled = false;
        btn.textContent = resetSentTo ? "Send again" : "Send reset link";
      }
    };
    tick();

    btn.addEventListener("click", async () => {
      const email = document.getElementById("forgot-email").value.trim();
      if (!email) {
        statusEl.className = "text-xs mt-3 status-err";
        statusEl.textContent = "Enter your email address.";
        return;
      }
      btn.disabled = true;
      statusEl.className = "text-xs mt-3 status-info";
      statusEl.textContent = "Sending…";

      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: authRedirectTo() });
      if (error) {
        statusEl.className = "text-xs mt-3 status-err";
        statusEl.textContent = /rate limit/i.test(error.message)
          ? "Too many emails just now — give it a few minutes."
          : error.message;
        btn.disabled = false;
        return;
      }
      // Deliberately not revealing whether the address has an account.
      resetSentTo = email;
      resendAt = Date.now() + RESEND_COOLDOWN_MS;
      drawForgot();
    });

    document.getElementById("back-to-signin").addEventListener("click", () => {
      mode = "signin";
      resetSentTo = null;
      draw();
    });
  }

  function draw() {
    if (pendingEmail) return drawPending();
    if (mode === "forgot") return drawForgot();

    const blockedFor = signupBlockedFor();

    app.innerHTML = `
      <div class="mb-4">
        <div class="eyebrow mb-1">Organizer</div>
        <h1 class="text-2xl">${mode === "signup" ? "Start your 30-day free trial" : "Welcome back"}</h1>
      </div>

      ${mode === "signup" && !IS_NATIVE_APP ? `
        <section class="panel-dark px-5 pt-5 pb-5 mb-3">
          <div class="flex items-baseline gap-2">
            <span class="num-display" style="font-size:2.4rem;color:var(--grass-400)">30</span>
            <span class="eyebrow on-dark">days free</span>
          </div>
          <p class="text-sm mt-2" style="color:rgba(255,255,255,.62)">
            Then $9.99/month. No card needed to start, and you can cancel any time.
          </p>
          <ul class="mt-4 pt-4 flex flex-col gap-1.5" style="border-top:1px solid rgba(255,255,255,.09)">
            <li class="text-sm flex items-center gap-2" style="color:rgba(255,255,255,.75)">
              <span style="color:var(--grass-400)">${icon("check", 15)}</span> Unlimited tournaments and players
            </li>
            <li class="text-sm flex items-center gap-2" style="color:rgba(255,255,255,.75)">
              <span style="color:var(--grass-400)">${icon("check", 15)}</span> Live leaderboards on every phone
            </li>
            <li class="text-sm flex items-center gap-2" style="color:rgba(255,255,255,.75)">
              <span style="color:var(--grass-400)">${icon("check", 15)}</span> Players never pay or sign up
            </li>
          </ul>
        </section>
      ` : ""}

      <div class="card p-5">
        <div class="flex gap-2 mb-5 p-1 rounded-xl" style="background:var(--paper)">
          <button id="tab-signup" class="flex-1 py-2 rounded-lg text-sm font-bold transition"
            style="${mode === "signup" ? "background:var(--surface);box-shadow:0 1px 3px rgba(8,17,12,.12)" : "color:var(--ink-2)"}">Sign up</button>
          <button id="tab-signin" class="flex-1 py-2 rounded-lg text-sm font-bold transition"
            style="${mode === "signin" ? "background:var(--surface);box-shadow:0 1px 3px rgba(8,17,12,.12)" : "color:var(--ink-2)"}">Sign in</button>
        </div>

        ${mode === "signup" ? `
          <div class="grid grid-cols-2 gap-2 mb-4">
            <div>
              <label class="field-label">First name</label>
              <input id="auth-first" autocomplete="given-name" placeholder="Gabe" />
            </div>
            <div>
              <label class="field-label">Last name</label>
              <input id="auth-last" autocomplete="family-name" placeholder="Herbst" />
            </div>
          </div>
        ` : ""}

        <label class="field-label">Email</label>
        <input id="auth-email" type="email" autocomplete="email" placeholder="you@email.com" class="mb-4" />

        <label class="field-label">Password</label>
        <input id="auth-password" type="password" autocomplete="${mode === "signup" ? "new-password" : "current-password"}"
               placeholder="At least 6 characters" class="mb-4" />

        ${mode === "signup" ? `
          <label class="field-label">Confirm password</label>
          <input id="auth-password2" type="password" autocomplete="new-password" placeholder="Type it again" class="mb-4" />
        ` : ""}

        <button id="auth-submit" class="${mode === "signup" ? "btn-green" : "btn-primary"} w-full" ${mode === "signup" && blockedFor ? "disabled" : ""}>
          ${mode === "signup" ? "Start free trial" : "Sign in"}
        </button>

        ${mode === "signup" ? `
          <p class="text-xs muted-2 text-center mt-3 leading-relaxed">
            By creating an account you agree to our
            <a href="#/terms" class="link-underline">Terms</a> and
            <a href="#/refunds" class="link-underline">Refund Policy</a>.
          </p>
        ` : ""}

        ${mode === "signin" ? `
          <div class="text-center mt-3">
            <button id="forgot-link" class="btn-ghost">Forgot your password?</button>
          </div>
        ` : ""}
        <div id="auth-status" class="text-xs mt-3">${
          mode === "signup" && blockedFor
            ? `<span class="status-err">Too many sign-up attempts. Try again in ${humanDuration(blockedFor)}.</span>`
            : ""
        }</div>
      </div>
    `;

    document.getElementById("tab-signin").addEventListener("click", () => { mode = "signin"; draw(); });
    document.getElementById("tab-signup").addEventListener("click", () => { mode = "signup"; draw(); });

    const forgotLink = document.getElementById("forgot-link");
    if (forgotLink) {
      forgotLink.addEventListener("click", () => {
        mode = "forgot";
        resendAt = 0;
        draw();
      });
    }

    const submit = document.getElementById("auth-submit");
    app.querySelectorAll("input").forEach((inp) => {
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter") submit.click(); });
    });

    submit.addEventListener("click", async () => {
      const statusEl = document.getElementById("auth-status");
      const fail = (msg) => {
        statusEl.className = "text-xs mt-3 status-err";
        statusEl.textContent = msg;
      };

      const email = document.getElementById("auth-email").value.trim();
      const password = document.getElementById("auth-password").value;

      if (mode === "signup") {
        const waitMs = signupBlockedFor();
        if (waitMs) return fail(`Too many sign-up attempts. Try again in ${humanDuration(waitMs)}.`);

        const first = document.getElementById("auth-first").value.trim();
        const last = document.getElementById("auth-last").value.trim();
        const password2 = document.getElementById("auth-password2").value;

        if (!first || !last) return fail("Enter your first and last name.");
        if (!email) return fail("Enter your email address.");
        if (password.length < 6) return fail("Password needs to be at least 6 characters.");
        if (password !== password2) return fail("Those passwords don't match.");

        submit.disabled = true;
        statusEl.className = "text-xs mt-3 status-info";
        statusEl.textContent = "Creating account…";

        recordAuthAttempt();
        const { data, error } = await sb.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: authRedirectTo(),
            data: { first_name: first, last_name: last, full_name: `${first} ${last}` },
          },
        });
        submit.disabled = false;

        if (error) {
          return fail(/rate limit/i.test(error.message)
            ? "Too many emails sent to that address just now — give it a few minutes."
            : error.message);
        }
        // A session here means confirmation is switched off; otherwise they
        // need to click the link before they can do anything.
        if (data.session) { renderHeaderProfile(); return viewCreate(); }
        pendingEmail = email;
        resendAt = Date.now() + RESEND_COOLDOWN_MS;
        drawPending();
        return;
      }

      if (!email || !password) return fail("Enter your email and password.");
      submit.disabled = true;
      statusEl.className = "text-xs mt-3 status-info";
      statusEl.textContent = "Signing in…";
      const { error } = await sb.auth.signInWithPassword({ email, password });
      submit.disabled = false;
      if (error) {
        // Supabase reports an unconfirmed account as a generic failure, which
        // reads as "wrong password" — say what's actually wrong instead.
        return fail(/email not confirmed/i.test(error.message)
          ? "That email hasn't been confirmed yet — check your inbox for the link."
          : error.message);
      }
      renderHeaderProfile();
      viewCreate();
    });
  }

  draw();
}

// Where a password-recovery link lands. The link itself has already created a
// session by this point, so the only thing left is choosing a new password.
async function viewResetPassword() {
  app.innerHTML = loadingHtml();
  const user = await getUser();

  if (!user) {
    // Expired, already used, or opened in a different browser than the one
    // that requested it (PKCE keeps its verifier in local storage).
    app.innerHTML = `
      <div class="mb-4">
        <div class="eyebrow mb-1">Password reset</div>
        <h1 class="text-2xl">That link has expired</h1>
      </div>
      <div class="card p-5">
        <p class="text-sm muted mb-4">Reset links are single-use and last one hour. Open the newest email, and use the same browser you requested it from.</p>
        <a href="#/create" class="btn-primary w-full">Request a new link</a>
      </div>`;
    return;
  }

  app.innerHTML = `
    <div class="mb-4">
      <div class="eyebrow mb-1">Password reset</div>
      <h1 class="text-2xl">Choose a new password</h1>
      <p class="text-sm muted mt-1">for ${escapeHtml(user.email)}</p>
    </div>
    <div class="card p-5">
      <label class="field-label">New password</label>
      <input id="new-password" type="password" autocomplete="new-password" placeholder="At least 6 characters" class="mb-4" />
      <label class="field-label">Confirm new password</label>
      <input id="new-password2" type="password" autocomplete="new-password" placeholder="Type it again" class="mb-4" />
      <button id="save-password" class="btn-primary w-full">Save new password</button>
      <div id="reset-status" class="text-xs mt-3"></div>
    </div>`;

  const btn = document.getElementById("save-password");
  const statusEl = document.getElementById("reset-status");
  const fail = (msg) => {
    statusEl.className = "text-xs mt-3 status-err";
    statusEl.textContent = msg;
  };

  app.querySelectorAll("input").forEach((inp) => {
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") btn.click(); });
  });

  btn.addEventListener("click", async () => {
    const pw = document.getElementById("new-password").value;
    const pw2 = document.getElementById("new-password2").value;
    if (pw.length < 6) return fail("Password needs to be at least 6 characters.");
    if (pw !== pw2) return fail("Those passwords don't match.");

    btn.disabled = true;
    statusEl.className = "text-xs mt-3 status-info";
    statusEl.textContent = "Saving…";

    const { error } = await sb.auth.updateUser({ password: pw });
    if (error) {
      btn.disabled = false;
      return fail(/should be different/i.test(error.message)
        ? "That's already your current password — pick a different one."
        : error.message);
    }

    // Changing a password is pointless as a security measure if whoever
    // prompted it stays signed in elsewhere. Supabase does not reliably
    // revoke other sessions on a password change, so do it explicitly.
    // scope:"others" leaves this browser signed in and kills every other
    // device, which then has to sign in again with the new password.
    statusEl.textContent = "Signing out other devices…";
    const { error: revokeError } = await sb.auth.signOut({ scope: "others" });
    btn.disabled = false;
    if (revokeError) {
      // The password did change, so don't imply it failed — but don't claim
      // other devices were kicked out when they may not have been.
      toast("Password updated, but other devices may still be signed in", true);
    } else {
      toast("Password updated — other devices signed out");
    }

    isPasswordRecovery = false;
    renderHeaderProfile();
    location.hash = "#/";
  });
}

function renderCreateForm(user, billing, opts = {}) {
  app.innerHTML = `
    ${trialBannerHtml(billing)}
    <div class="mb-4">
      <div class="eyebrow mb-1">Organizer · ${escapeHtml(user.email)}</div>
      ${opts.match ? `
        <div class="formhead">
          <h1>Create a match</h1>
          <p>Two sides, your course, and who's playing. It's ready to score as soon as you're done.</p>
        </div>` : `<h1 class="text-2xl">Create a tournament</h1>`}
    </div>
    <form id="create-form" class="card p-5 flex flex-col gap-5">
      ${opts.match ? "" : `
      <div>
        <label class="field-label">Tournament name</label>
        <input name="name" required placeholder="Thursday Night Scramble" />
      </div>`}
      <div class="relative">
        <label class="field-label">Course</label>
        <input id="course-input" name="course" placeholder="Search your course… e.g. Pine Valley" autocomplete="off" />
        <div id="course-results" class="hidden absolute z-20 left-0 right-0 mt-1 card max-h-64 overflow-y-auto"></div>
        <p id="course-selected-note" class="hidden text-xs font-semibold mt-2 p-2 rounded-lg" style="color:var(--grass-700);background:var(--grass-100)"></p>
        <div id="course-unmatched" class="hidden text-xs mt-2 p-3 rounded-lg" style="color:var(--under);background:rgba(214,37,43,.08);border:1px solid rgba(214,37,43,.25)"></div>
      </div>
      <div>
        <label class="field-label">Format</label>
        <select id="format-select" name="format">
          ${Object.entries(FORMATS)
            .filter(([, f]) => (opts.match ? (f.match || f.headToHead) : !(f.match || f.headToHead)))
            .map(([k, f]) => `<option value="${k}">${f.label}</option>`).join("")}
        </select>
        <p id="format-blurb" class="text-xs muted-2 mt-1.5 leading-relaxed"></p>
      </div>
      <!-- Which tee the round is played from. Populated from the course once
           one is chosen; hidden until then, because an empty tee list is
           noise on a form you have not started filling in. -->
      <div id="tee-wrap" class="hidden">
        <label class="field-label" for="tee-select">Tees</label>
        <select id="tee-select" name="tee"></select>
        <p id="tee-note" class="text-xs muted-2 mt-1.5"></p>
      </div>

      <div>
        <label class="field-label" for="visibility-select">Visibility</label>
        <select id="visibility-select" name="visibility">
          <option value="public">Public — listed on the tournaments page</option>
          <option value="private">Private — unlisted, code still works</option>
        </select>
        <p class="text-xs muted-2 mt-1.5 leading-relaxed">
          Private rounds stay off the public list. Anyone with the join code or the
          link can still open and score them.
        </p>
      </div>

      <div id="buyin-wrap" class="hidden">
        <label class="field-label">Buy-in per player</label>
        <input id="buyin-input" name="buyin" type="number" min="0" max="10000" step="1"
               inputmode="decimal" placeholder="e.g. 20" />
        <p class="text-xs muted-2 mt-1.5 leading-relaxed">
          Optional. Everyone antes this much; the whole pot is split between the skins actually won,
          so carried-over holes make the remaining skins worth more. Leave blank to play for pride.
        </p>
      </div>
      <div class="${opts.match ? "frow" : ""}">
        <div>
          <label class="field-label" for="holes-select">Holes</label>
          <select id="holes-select" name="holes">
            <option value="18">18 holes</option>
            <option value="9">9 holes</option>
          </select>
        </div>
        <div id="nine-wrap" class="hidden">
          <label class="field-label" for="nine-select">Which nine?</label>
          <select id="nine-select" name="nine">
            <option value="front">Front nine (holes 1–9)</option>
            <option value="back">Back nine (holes 10–18)</option>
          </select>
        </div>
      </div>
      ${opts.match ? `
        <!-- Players are entered here rather than added afterwards: a match is
             two named sides, and there is nothing to manage before they exist.
             Team names are not asked for - a side is who is playing on it. -->
        <div id="match-players"></div>

        <label class="checkrow">
          <input type="checkbox" id="bet-on" />
          <span>
            <span class="cr-t">Playing for something</span>
            <span class="cr-s">Records what the group agreed so the card can settle it. No money moves through TeeBoard.</span>
          </span>
        </label>
        <div id="bet-wrap" class="hidden betrow">
          <div>
            <label class="field-label" for="bet-amount">Stake</label>
            <div class="inputprefix">
              <span>$</span>
              <input id="bet-amount" type="number" min="1" max="10000" step="1" placeholder="5" />
            </div>
          </div>
          <div>
            <label class="field-label" for="bet-unit">Per</label>
            <select id="bet-unit">
              <option value="hole">Hole</option>
              <option value="nine">Nine</option>
              <option value="round" selected>Round</option>
            </select>
          </div>
        </div>

        <label class="checkrow">
          <input type="checkbox" id="single-scorer" />
          <span>
            <span class="cr-t">One person keeps score for the group</span>
            <span class="cr-s">One phone enters every player's card, hole by hole. Leave this off and each side scores its own.</span>
          </span>
        </label>
      ` : ""}

      <button class="btn-primary w-full" type="submit">Create &amp; get code</button>
    </form>
  `;

  const formatSelect = document.getElementById("format-select");
  // Arriving from "Create a match" opens on singles; the other match formats
  // are in the same list, so switching to four-ball is one tap away.
  if (opts.match) formatSelect.value = "match_singles";

  // Player slots follow the format: two for singles, two a side otherwise.
  // Re-rendered on a format change, keeping whatever has been typed.
  function renderPlayerSlots() {
    const wrap = document.getElementById("match-players");
    if (!wrap) return;
    const perSide = FORMATS[formatSelect.value]?.sideSize || 1;
    const kept = [...wrap.querySelectorAll("[data-player]")].map((el) => ({
      name: el.querySelector("[data-pname]").value,
      hcp: el.querySelector("[data-phcp]").value,
    }));

    const slot = (i, label) => {
      const prior = kept[i] || { name: "", hcp: "" };
      return `
        <div class="prow" data-player="${i}">
          <span class="pnum">${i + 1}</span>
          <input data-pname placeholder="${escapeHtml(label)}" value="${escapeHtml(prior.name)}"
                 class="flex-1 min-w-0" aria-label="${escapeHtml(label)}" />
          <input data-phcp type="number" min="-10" max="54" step="0.1" placeholder="HCP"
                 value="${escapeHtml(prior.hcp)}" style="width:5rem"
                 aria-label="Handicap for ${escapeHtml(label)} — use a minus for a plus handicap" />
        </div>`;
    };

    if (perSide === 1) {
      wrap.innerHTML = `
        <label class="field-label">Players</label>
        ${slot(0, "Player 1")}
        ${slot(1, "Player 2")}
        <p class="text-xs muted-2 mt-1">Optional. The match plays off the difference, so the lower handicap gives shots. For a plus handicap enter a minus — a plus 2 is <b>-2</b>. A plus golfer plays off scratch: no shots given, none taken away.</p>`;
    } else {
      wrap.innerHTML = `
        <label class="field-label">Side one</label>
        ${slot(0, "Player 1")}
        ${slot(1, "Player 2")}
        <label class="field-label mt-3">Side two</label>
        ${slot(2, "Player 3")}
        ${slot(3, "Player 4")}
        <p class="text-xs muted-2 mt-1">Optional. Everyone plays off the lowest handicap in the match. For a plus handicap enter a minus — a plus 2 is <b>-2</b>. A plus golfer plays off scratch: no shots given, none taken away.</p>`;
    }
  }
  if (opts.match) {
    renderPlayerSlots();
    formatSelect.addEventListener("change", renderPlayerSlots);
    const betOn = document.getElementById("bet-on");
    const betWrap = document.getElementById("bet-wrap");
    betOn.addEventListener("change", () => betWrap.classList.toggle("hidden", !betOn.checked));
  }
  const formatBlurb = document.getElementById("format-blurb");
  const buyinWrap = document.getElementById("buyin-wrap");
  const refreshFormatBlurb = () => {
    const f = FORMATS[formatSelect.value];
    formatBlurb.textContent = f
      ? `${f.blurb}${f.scoring === "player" ? " Every player records their own score." : ""}`
      : "";
    buyinWrap.classList.toggle("hidden", formatSelect.value !== "skins");
  };
  formatSelect.addEventListener("change", refreshFormatBlurb);
  refreshFormatBlurb();

  const courseInput = document.getElementById("course-input");
  const resultsBox = document.getElementById("course-results");
  const holesSelect = document.getElementById("holes-select");
  const nineWrap = document.getElementById("nine-wrap");
  const nineSelect = document.getElementById("nine-select");
  const selectedNote = document.getElementById("course-selected-note");

  let debounceId = null;
  let searchToken = 0;
  // Holds the full scorecard fetched for the currently-selected course, if
  // any: { name, totalHoles, par: [...], summaryPar, website }. Par is no
  // longer editable as raw text — it's always derived from this (or defaults
  // to par 4 everywhere), based on the Holes / Which-nine selections below.
  let courseScorecard = null;
  // Set only when the organizer has been shown what a typed-but-unmatched
  // course costs them and chosen to go ahead regardless.
  let allowUnmatchedCourse = false;

  function hideResults() {
    resultsBox.classList.add("hidden");
    resultsBox.innerHTML = "";
  }

  function updateNineVisibility() {
    // Show the front/back picker any time 9 holes is selected — not only
    // when a course happens to be loaded — so it's never hidden/missing.
    // It only changes the actual par numbers when an 18-hole course card is
    // loaded; otherwise every hole defaults to par 4 either way.
    nineWrap.classList.toggle("hidden", holesSelect.value !== "9");
  }

  // Takes the same slice of a per-hole array that getCurrentPar() takes of
  // par, so yardage/handicap always line up with the holes being played.
  function sliceForSelection(arr) {
    if (!arr || !courseScorecard) return null;
    const numHoles = parseInt(holesSelect.value, 10);
    if (courseScorecard.totalHoles === numHoles) return arr.slice();
    if (numHoles === 9 && courseScorecard.totalHoles === 18) {
      return nineSelect.value === "back" ? arr.slice(9, 18) : arr.slice(0, 9);
    }
    return null;
  }

  function getCurrentPar() {
    const numHoles = parseInt(holesSelect.value, 10);
    if (courseScorecard) {
      if (courseScorecard.totalHoles === numHoles) return courseScorecard.par.slice();
      if (numHoles === 9 && courseScorecard.totalHoles === 18) {
        return nineSelect.value === "back" ? courseScorecard.par.slice(9, 18) : courseScorecard.par.slice(0, 9);
      }
    }
    return Array(numHoles).fill(4);
  }

  function refreshNoteForSelection() {
    if (!courseScorecard) return;
    const { name, totalHoles, par: fullPar, summaryPar, website } = courseScorecard;
    const numHoles = parseInt(holesSelect.value, 10);
    let label;
    if (totalHoles === numHoles) {
      label = `${numHoles} holes`;
    } else if (numHoles === 9 && totalHoles === 18) {
      label = nineSelect.value === "back" ? "back nine (holes 10–18)" : "front nine (holes 1–9)";
    } else {
      label = `${numHoles} holes (this course's card on file has ${totalHoles} — the rest default to par 4)`;
    }
    const usedPar = getCurrentPar();
    const totalPar = usedPar.reduce((a, b) => a + b, 0);
    const fullTotalPar = fullPar.reduce((a, b) => a + b, 0);
    const mismatchWarning = (summaryPar && totalHoles === fullPar.length && summaryPar !== fullTotalPar)
      ? ` Heads up: OpenGolfAPI's summary lists par ${summaryPar} for this course overall, which doesn't match the full card's total of ${fullTotalPar} — double check the numbers before sharing the join code.`
      : "";
    const siteLink = website ? ` <a href="${escapeHtml(website)}" target="_blank" class="link-underline">${escapeHtml(name)}'s site</a> ·` : "";
    // Offer the tees this course actually publishes. Switching tee swaps the
    // yardage row on the card; par and stroke index don't change with it.
    const teeWrap = document.getElementById("tee-wrap");
    const teeSelect = document.getElementById("tee-select");
    const teeNote = document.getElementById("tee-note");
    const teeKeys = Object.keys(courseScorecard.teeYardages || {});
    if (teeWrap && teeSelect) {
      if (teeKeys.length > 1) {
        const cap = (k) => k.charAt(0).toUpperCase() + k.slice(1);
        teeSelect.innerHTML = teeKeys.map((k) => {
          const row = sliceForSelection(courseScorecard.teeYardages[k]);
          const total = row ? row.reduce((a, b) => a + b, 0) : null;
          return `<option value="${escapeHtml(k)}"${k === courseScorecard.teeKey ? " selected" : ""}>` +
                 `${escapeHtml(cap(k))}${total ? ` — ${total} yds` : ""}</option>`;
        }).join("");
        teeWrap.classList.remove("hidden");
        if (teeNote) teeNote.textContent = "Par and stroke index are the same from every tee; only the yardage changes.";
        teeSelect.onchange = () => {
          const k = teeSelect.value;
          courseScorecard.teeKey = k;
          courseScorecard.yardage = courseScorecard.teeYardages[k];
          courseScorecard.teeName = k.charAt(0).toUpperCase() + k.slice(1);
          refreshNoteForSelection();
        };
      } else {
        teeWrap.classList.add("hidden");
      }
    }

    const yds = sliceForSelection(courseScorecard.yardage);
    const extras = [];
    if (yds) extras.push(`${yds.reduce((a, b) => a + b, 0)} yds off the ${escapeHtml(courseScorecard.teeName || "white")} tees`);
    if (sliceForSelection(courseScorecard.handicap)) extras.push("stroke indexes for tiebreaks");
    const extraText = extras.length ? ` Also pulled ${extras.join(" and ")}.` : "";
    selectedNote.innerHTML = `Using ${escapeHtml(name)}'s ${escapeHtml(label)}, par ${totalPar}.${extraText}${siteLink}${escapeHtml(mismatchWarning)}`;
    selectedNote.classList.remove("hidden");
  }

  function clearSelection() {
    selectedNote.classList.add("hidden");
    selectedNote.textContent = "";
    courseScorecard = null;
    // Editing the course name invalidates any previous "create anyway"
    // decision — the warning has to be earned again for the new text.
    allowUnmatchedCourse = false;
    document.getElementById("course-unmatched").classList.add("hidden");
    updateNineVisibility();
  }

  courseInput.addEventListener("input", () => {
    clearSelection();
    const q = courseInput.value.trim();
    clearTimeout(debounceId);
    if (q.length < 3) return hideResults();
    debounceId = setTimeout(() => runSearch(q), 300);
  });

  courseInput.addEventListener("blur", () => setTimeout(hideResults, 150));

  holesSelect.addEventListener("change", () => {
    updateNineVisibility();
    refreshNoteForSelection();
  });
  nineSelect.addEventListener("change", refreshNoteForSelection);

  async function runSearch(q) {
    const myToken = ++searchToken;
    try {
      const res = await fetch(COURSE_SEARCH_URL + encodeURIComponent(q));
      if (myToken !== searchToken) return;
      if (!res.ok) throw new Error("bad response");
      const data = await res.json();
      const courses = (data.courses || []).slice(0, 8);
      if (!courses.length) {
        resultsBox.innerHTML = `<div class="p-3 text-sm muted-2">No matches — that's okay, every hole will default to par 4.</div>`;
        resultsBox.classList.remove("hidden");
        return;
      }
      resultsBox.innerHTML = courses.map((c) => `
        <div class="search-result p-3 cursor-pointer" style="border-bottom:1px solid var(--line)" data-id="${escapeHtml(c.id)}" data-name="${escapeHtml(c.name)}">
          <div class="font-semibold text-sm">${escapeHtml(c.name)}</div>
          <div class="eyebrow mt-0.5">${escapeHtml([c.city, c.state].filter(Boolean).join(", ")) || "&nbsp;"}</div>
        </div>
      `).join("");
      resultsBox.classList.remove("hidden");
      resultsBox.querySelectorAll(".search-result").forEach((el) => {
        el.addEventListener("mousedown", (e) => {
          e.preventDefault();
          selectCourse(el.dataset.id, el.dataset.name);
        });
      });
    } catch {
      if (myToken !== searchToken) return;
      resultsBox.innerHTML = `<div class="p-3 text-sm muted-2">Couldn't reach course search right now — that's okay, every hole will default to par 4.</div>`;
      resultsBox.classList.remove("hidden");
    }
  }

  async function selectCourse(id, name) {
    hideResults();
    courseInput.value = name;
    try {
      const res = await fetch(COURSE_DETAIL_URL + encodeURIComponent(id));
      if (!res.ok) throw new Error("bad response");
      const course = await res.json();
      const rawScorecard = course.scorecard || [];
      if (!rawScorecard.length) {
        courseScorecard = null;
        updateNineVisibility();
        selectedNote.textContent = `Found ${name}, but no hole-by-hole scorecard on file — every hole will default to par 4.`;
        selectedNote.classList.remove("hidden");
        return;
      }
      // De-dupe by hole number (keep first) and sort, in case the source data
      // has repeated entries.
      const byHole = new Map();
      for (const h of rawScorecard) {
        if (!byHole.has(h.hole)) byHole.set(h.hole, h.par);
      }
      const holeNumbers = [...byHole.keys()].sort((a, b) => a - b);
      const parArr = holeNumbers.map((h) => byHole.get(h));

      // Trust the actual scorecard entries for the hole count — some records
      // in OpenGolfAPI have a summary "holes"/"par" field that disagrees with
      // the real per-hole card (confirmed: e.g. a course listed as par 70
      // overall whose scorecard array actually sums to 72). Using the summary
      // number here used to cause the par-count check on submit to silently
      // discard the fetched card and fall back to a flat par 4 on every hole.
      const totalHoles = parArr.length;

      courseScorecard = { name, totalHoles, par: parArr, summaryPar: course.par || null, website: course.website || null };

      // Best-effort: pull yardages and stroke indexes from the detailed
      // endpoint so cards can show YDS/HCP rows and ties resolve on the real
      // hardest holes. Purely additive — any failure just leaves them unset.
      try {
        const full = await fetch(COURSE_FULL_URL + encodeURIComponent(id)).then((r) => (r.ok ? r.json() : null));
        const holesData = full && Array.isArray(full.holes_data) ? full.holes_data : null;
        if (holesData) {
          const byNum = new Map();
          for (const h of holesData) if (!byNum.has(h.number)) byNum.set(h.number, h);
          const nums = [...byNum.keys()].sort((a, b) => a - b);
          // Only trust it if it lines up with the par card we're already using.
          if (nums.length === totalHoles && nums.every((n, i) => byNum.get(n).par === parArr[i])) {
            // Keep every tee the course publishes, not just the default, so
            // the organizer can pick the set they are actually playing.
            const teeNames = [...new Set(nums.flatMap((n) => Object.keys(byNum.get(n).yardages || {})))];
            const byTee = {};
            teeNames.forEach((tee) => {
              const row = nums.map((n) => (byNum.get(n).yardages || {})[tee] ?? null);
              if (row.every((v) => typeof v === "number")) byTee[tee] = row;
            });
            courseScorecard.teeYardages = byTee;

            const yds = byTee[DEFAULT_TEE] || byTee[Object.keys(byTee)[0]] || null;
            const hcp = nums.map((n) => byNum.get(n).handicap_index ?? null);
            if (yds) {
              const chosen = byTee[DEFAULT_TEE] ? DEFAULT_TEE : Object.keys(byTee)[0];
              courseScorecard.yardage = yds;
              courseScorecard.teeName = chosen.charAt(0).toUpperCase() + chosen.slice(1);
              courseScorecard.teeKey = chosen;
            }
            if (hcp.every((v) => typeof v === "number")) courseScorecard.handicap = hcp;
          }
        }
      } catch { /* detailed card unavailable — par-only is still fine */ }
      courseScorecard.courseId = id;

      if (totalHoles === 18 && holesSelect.value === "9") {
        // The organizer already chose a 9-hole round before searching for
        // their course — keep that choice instead of silently bumping them
        // back to 18. They can still pick front/back nine below.
      } else if (String(totalHoles) === "9" || String(totalHoles) === "18") {
        holesSelect.value = String(totalHoles);
      } else {
        let opt = holesSelect.querySelector(`option[value="${totalHoles}"]`);
        if (!opt) {
          opt = document.createElement("option");
          opt.value = String(totalHoles);
          opt.textContent = `${totalHoles} holes`;
          holesSelect.appendChild(opt);
        }
        holesSelect.value = String(totalHoles);
      }
      nineSelect.value = "front";
      updateNineVisibility();
      refreshNoteForSelection();
    } catch {
      courseScorecard = null;
      updateNineVisibility();
      selectedNote.textContent = `Found ${name}, but couldn't load its scorecard — every hole will default to par 4.`;
      selectedNote.classList.remove("hidden");
    }
  }

  document.getElementById("create-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);

    // A match names itself from who is playing — "Gabe vs Roland", or
    // "Gabe & Bill vs Roland & Drake" — so the form never asks for one.
    let matchPlayers = null;
    if (opts.match) {
      const rows = [...document.querySelectorAll("#match-players [data-player]")];
      matchPlayers = rows.map((el) => ({
        name: el.querySelector("[data-pname]").value.trim(),
        handicap: el.querySelector("[data-phcp]").value.trim(),
      }));
      const missing = matchPlayers.some((p) => !p.name);
      if (missing) {
        toast("Every player needs a name.", true);
        return;
      }
      const bad = matchPlayers.find((p) => {
        if (p.handicap === "") return false;
        const v = Number(p.handicap);
        return !Number.isFinite(v) || v < -10 || v > 54;
      });
      if (bad) {
        toast(`Handicap for ${bad.name} must be between -10 (plus 10) and 54, or left blank.`, true);
        return;
      }
    }

    const betOn = document.getElementById("bet-on");
    if (opts.match && betOn?.checked) {
      const amt = parseFloat(document.getElementById("bet-amount").value);
      if (!Number.isFinite(amt) || amt <= 0 || amt > 10000) {
        toast("Enter a stake between $1 and $10,000, or turn the bet off.", true);
        return;
      }
    }

    const perSide = opts.match ? (FORMATS[formatSelect.value]?.sideSize || 1) : 0;
    const sideLabel = (i) => matchPlayers
      .slice(i * perSide, i * perSide + perSide).map((p) => p.name).join(" & ");
    const name = opts.match
      ? `${sideLabel(0)} vs ${sideLabel(1)}`.slice(0, 80)
      : fd.get("name").trim();
    const course = fd.get("course").trim();
    const numHoles = parseInt(fd.get("holes"), 10);
    const par = getCurrentPar();
    // A 9-hole round played on the back nine is holes 10–18 on the actual
    // course, not 1–9 — carry that offset so it shows correctly everywhere.
    const startHole = numHoles === 9 && nineSelect.value === "back" ? 10 : 1;

    const btn = e.target.querySelector("button");

    // Typing a course name is not the same as picking one. Without a match
    // there is no scorecard to pull, so every hole silently becomes par 4
    // with no yardage and no stroke index — which nobody discovers until
    // they are standing on the first tee. Make it a decision, not a default.
    if (course && !courseScorecard && !allowUnmatchedCourse) {
      const warn = document.getElementById("course-unmatched");
      warn.innerHTML = `
        <div class="font-semibold mb-1">“${escapeHtml(course)}” wasn’t picked from the list</div>
        <p class="mb-2" style="color:var(--ink-600)">
          Nothing was matched, so this card will have <b>every hole at par 4</b>, no yardages
          and no stroke indexes — which also means ties can’t be broken on the hardest holes.
        </p>
        <div class="flex gap-2 flex-wrap">
          <button type="button" id="course-fix" class="btn-secondary text-xs px-3 py-1.5">Search for the course</button>
          <button type="button" id="course-anyway" class="btn-ghost text-xs px-3 py-1.5" style="color:var(--under)">Create anyway with par 4</button>
        </div>`;
      warn.classList.remove("hidden");
      warn.scrollIntoView({ behavior: "smooth", block: "center" });
      document.getElementById("course-fix").addEventListener("click", () => {
        warn.classList.add("hidden");
        courseInput.focus();
        courseInput.select();
      });
      document.getElementById("course-anyway").addEventListener("click", () => {
        allowUnmatchedCourse = true;
        warn.classList.add("hidden");
        e.target.requestSubmit();
      });
      return;
    }

    btn.disabled = true;
    btn.textContent = "Creating…";

    let tournament = null;
    for (let attempt = 0; attempt < 6 && !tournament; attempt++) {
      const code = genCode(5);
      const { data, error } = await sb
        .from("tournaments")
        .insert({
          name, course_name: course || null, join_code: code, num_holes: numHoles, par,
          format: formatSelect.value,
          skins_buy_in: formatSelect.value === "skins"
            ? (parseFloat(document.getElementById("buyin-input").value) || null)
            : null,
          start_hole: startHole,
          yardage: sliceForSelection(courseScorecard && courseScorecard.yardage),
          handicap: sliceForSelection(courseScorecard && courseScorecard.handicap),
          tee_name: (courseScorecard && courseScorecard.teeName) || null,
          course_id: (courseScorecard && courseScorecard.courseId) || null,
          is_public: document.getElementById("visibility-select").value !== "private",
          single_scorer: !!document.getElementById("single-scorer")?.checked,
          bet_unit: betOn?.checked ? document.getElementById("bet-unit").value : null,
          bet_amount: betOn?.checked ? (parseFloat(document.getElementById("bet-amount").value) || null) : null,
          created_by: user.id,
        })
        .select()
        .single();
      if (data) tournament = data;
      else if (error && error.code !== "23505") {
        toast("Couldn't create tournament: " + error.message, true);
        btn.disabled = false;
        btn.textContent = "Create & get code";
        return;
      }
    }
    if (!tournament) {
      toast("Couldn't generate a unique code, try again.", true);
      btn.disabled = false;
      btn.textContent = "Create & get code";
      return;
    }
    // A match already knows its sides, so build them now rather than sending
    // the organizer to a roster screen with nothing on it. Each side is a team
    // named after whoever is on it; the team name is never asked for.
    if (opts.match && matchPlayers) {
      const sides = [0, 1].map((i) => matchPlayers.slice(i * perSide, i * perSide + perSide));
      for (const side of sides) {
        const { data: team, error: teamErr } = await sb.rpc("organizer_add_team", {
          p_tournament_id: tournament.id,
          p_team_name: side.map((p) => p.name).join(" & ").slice(0, 60),
        });
        if (teamErr || !team) {
          toast("Match created, but a side could not be added: " + (teamErr?.message || "unknown error"), true);
          location.hash = `#/admin/${tournament.id}`;
          return;
        }
        for (const p of side) {
          const { error: memberErr } = await sb.rpc("organizer_add_player", {
            p_team_id: team.id,
            p_player_name: p.name,
            p_handicap: p.handicap === "" ? null : Number(p.handicap),
          });
          if (memberErr) toast(`Couldn't add ${p.name}: ${memberErr.message}`, true);
        }
      }
      // Straight to the match: it is ready to score.
      location.hash = `#/leaderboard/${tournament.id}`;
      return;
    }

    location.hash = `#/admin/${tournament.id}`;
  });
}

// ---------- ADMIN VIEW ----------

async function viewAdmin(tournamentId) {
  app.innerHTML = loadingHtml();

  const [{ data: tournament, error }, user] = await Promise.all([
    sb.from("tournaments").select(TOURNAMENT_COLS).eq("id", tournamentId).single(),
    getUser(),
  ]);
  if (error || !tournament) {
    app.innerHTML = notFoundHtml("Tournament");
    return;
  }
  // Strictly the account that created it. This used to also return true when
  // created_by was null, which let anyone holding the link edit or delete the
  // pre-accounts tournaments; those have since been assigned real owners.
  // Mirrored by RLS, so a forged client can't get past it either.
  const isOwner = !!user && tournament.created_by === user.id;

  // The join code is deliberately unreadable to anonymous visitors, so it
  // isn't in TOURNAMENT_COLS. The organizer needs it — for the code display,
  // the QR and the share link — and is signed in, so fetch it separately
  // once we know who they are.
  if (isOwner) {
    const { data: codeRow } = await sb
      .from("tournaments").select("join_code").eq("id", tournamentId).single();
    if (codeRow) tournament.join_code = codeRow.join_code;
  }

  // An owner whose trial and subscription have both lapsed sees the paywall
  // rather than a dashboard whose every control would be rejected by RLS.
  if (isOwner) {
    const billing = await getBilling();
    if (!billingHasAccess(billing)) return renderPaywall(billing, "admin");
  }

  // Which teams currently have their "manage" panel open — kept outside
  // render() so it survives re-renders (e.g. after adding another player,
  // the panel you were working in stays open for the next one).
  const expandedTeams = new Set();

  async function render() {
    const { data: teams } = await sb
      .from("teams")
      .select("id, name, join_code, signed_at, signed_by, team_members(id, player_name, handicap), scores(hole_number, team_member_id)")
      .eq("tournament_id", tournamentId)
      .order("created_at", { ascending: true });

    const joinUrl = shareLink(`/join/${tournament.join_code}`);

    const par = tournament.par && tournament.par.length === tournament.num_holes
      ? tournament.par
      : Array(tournament.num_holes).fill(4);
    const handicapArr = tournament.handicap && tournament.handicap.length === tournament.num_holes
      ? tournament.handicap
      : Array.from({ length: tournament.num_holes }, (_, i) => i + 1);

    const isActive = tournament.status === "active";
    const totalPlayers = (teams || []).reduce((n, t) => n + (t.team_members || []).length, 0);
    const signedCount = (teams || []).filter((t) => t.signed_at).length;

    app.innerHTML = `
      <section class="panel-dark px-5 pt-5 pb-4 mb-3">
        <div class="flex items-start justify-between gap-3 mb-3">
          <div class="eyebrow on-dark">Organizer dashboard</div>
          <span class="pill ${isActive ? "open" : "on-dark"}">${isActive ? '<span class="dot"></span>Open' : "Closed"}</span>
        </div>
        <h1 class="display" style="font-size:2rem;color:#fff">${escapeHtml(tournament.name)}</h1>
        <div class="grid grid-cols-3 gap-3 mt-4 pt-4" style="border-top:1px solid rgba(255,255,255,.09)">
          <div>
            <div class="num-display" style="font-size:1.7rem;color:#fff">${(teams || []).length}</div>
            <div class="eyebrow on-dark mt-1">Teams</div>
          </div>
          <div>
            <div class="num-display" style="font-size:1.7rem;color:#fff">${totalPlayers}</div>
            <div class="eyebrow on-dark mt-1">Players</div>
          </div>
          <div>
            <div class="num-display" style="font-size:1.7rem;color:#fff">${signedCount}</div>
            <div class="eyebrow on-dark mt-1">Signed</div>
          </div>
        </div>
        ${tournament.course_name ? `<p class="text-xs mt-3" style="color:rgba(255,255,255,.45)">${escapeHtml(tournament.course_name)} · ${tournament.num_holes} holes</p>` : ""}
      </section>

      <div id="qr-print-area" class="card overflow-hidden mb-3">
        <div class="px-5 pt-5 pb-4 text-center">
          <div class="eyebrow mb-2">Join code</div>
          <div class="display" style="font-size:3.2rem;letter-spacing:.14em;text-indent:.14em">${escapeHtml(tournament.join_code)}</div>
          <div class="mt-4 inline-block"><canvas id="qr" class="block rounded-lg"></canvas></div>
          <div class="eyebrow mt-3">Scan to join &amp; score</div>
        </div>
        <div class="grid grid-cols-3 gap-2 p-3 no-print" style="border-top:1px solid var(--line);background:#FBFCFB">
          <button id="copy-link" class="btn-secondary text-sm" style="padding:.7rem .4rem;white-space:nowrap">Copy link</button>
          <button id="print-qr" class="btn-secondary text-sm" style="padding:.7rem .4rem;white-space:nowrap">${icon("qr", 15)} Print</button>
          <a href="#/leaderboard/${tournament.id}" class="btn-primary text-sm" style="padding:.7rem .4rem;white-space:nowrap">Board</a>
        </div>
      </div>

      <button id="podium-btn" class="btn-green w-full mb-3 no-print">${icon("trophy", 17)} Top 3 result card</button>

      <div class="flex items-center gap-3 mt-6 mb-2.5">
        <h2 class="eyebrow">Teams (${(teams || []).length})</h2>
        <span class="flex-1 hairline"></span>
      </div>

      <div class="grid grid-cols-1 gap-2 mb-4">
        ${(teams || []).length === 0 ? `
          <div class="card p-8 text-center">
            <div class="mx-auto mb-3 flex items-center justify-center" style="color:var(--ink-3)">${icon("users", 30)}</div>
            <p class="font-semibold mb-1">No teams yet</p>
            <p class="text-sm muted">Share the code above, or add players below.</p>
          </div>` : ""}
        ${(teams || []).map((t) => {
          const expanded = expandedTeams.has(t.id);
          const entered = (t.scores || []).length;
          const pct = Math.round((entered / tournament.num_holes) * 100);
          return `
          <div class="card p-4">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="font-bold truncate">${escapeHtml(t.name)}${t.signed_at ? ` <span class="fin-badge" title="Signed by ${escapeHtml(t.signed_by || "")}">F</span>` : ""}</div>
                <div class="text-xs muted mt-0.5 truncate">${(t.team_members || []).map((m) => escapeHtml(m.player_name)).join(" · ") || "No players yet"}</div>
              </div>
              <span class="pill shrink-0">${escapeHtml(t.join_code)}</span>
            </div>

            <div class="flex items-center gap-2.5 mt-3">
              <div class="flex-1 rounded-full overflow-hidden" style="height:5px;background:var(--line)">
                <div style="width:${pct}%;height:100%;background:${t.signed_at ? "var(--grass-500)" : "var(--ink-600)"};transition:width .3s ease"></div>
              </div>
              <span class="eyebrow shrink-0">${entered}/${tournament.num_holes}${t.signed_at ? " · signed" : ""}</span>
            </div>

            ${isOwner ? `
              <button data-manage-team="${escapeHtml(t.id)}" class="btn-ghost mt-2.5">${expanded ? "Hide" : "Edit team"}</button>
              <div class="${expanded ? "" : "hidden"} mt-3 pt-3" style="border-top:1px solid var(--line)">
                <label class="field-label">Team name</label>
                <div class="flex gap-2 mb-4">
                  <input data-rename-input="${escapeHtml(t.id)}" value="${escapeHtml(t.name)}" class="flex-1" />
                  <button data-rename-btn="${escapeHtml(t.id)}" class="btn-secondary shrink-0">Save</button>
                </div>
                ${(t.team_members || []).length ? `
                  <label class="field-label">Players</label>
                  <div class="flex flex-col gap-1 mb-4">
                    ${(t.team_members || []).map((m) => `
                      <div class="flex items-center justify-between text-sm rounded-lg px-2.5 py-1.5" style="background:var(--paper)">
                        <span class="truncate">${escapeHtml(m.player_name)}</span>
                        <button data-remove-member="${escapeHtml(m.id)}" class="text-xs font-bold shrink-0 ml-2" style="color:var(--under)">Remove</button>
                      </div>
                    `).join("")}
                  </div>
                ` : ""}
                <label class="field-label">Add player</label>
                <div class="flex gap-2 mb-3">
                  <input data-quick-add-input="${escapeHtml(t.id)}" placeholder="Player name" class="flex-1" />
                  <button data-quick-add-btn="${escapeHtml(t.id)}" class="btn-primary shrink-0">Add</button>
                </div>
                ${t.signed_at ? `
                  <button data-reopen-team="${escapeHtml(t.id)}" class="btn-secondary text-sm w-full">Reopen scorecard (undo signing)</button>
                ` : ""}
              </div>
            ` : ""}
          </div>
        `; }).join("")}
      </div>

      ${isOwner ? `
        <div class="flex items-center gap-3 mt-6 mb-2.5">
          <h2 class="eyebrow">Roster</h2>
          <span class="flex-1 hairline"></span>
        </div>

        <div class="card p-5 mb-2.5">
          <div class="flex items-center gap-2 mb-1">
            <span style="color:var(--grass-600)">${icon("plus", 17)}</span>
            <h3 class="font-bold">Add a player</h3>
          </div>
          <p class="text-xs muted mb-4">One at a time — to an existing team, or a brand new one.</p>
          <label class="field-label">Team</label>
          <select id="add-team-select" class="mb-3">
            <option value="__new">+ New team</option>
            ${(teams || []).map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join("")}
          </select>
          <div id="new-team-name-wrap" class="mb-3">
            <input id="new-team-name" placeholder="New team name, e.g. The Duffers" />
          </div>
          <label class="field-label">Player name</label>
          <div class="flex gap-2 mb-4">
            <input id="add-player-name" placeholder="Player name" class="flex-1 min-w-0" />
            <!-- Course handicap. Optional everywhere, but it is what allocates
                 pops in a match, so the field sits next to the name rather
                 than behind another screen. -->
            <input id="add-player-hcp" type="number" min="-10" max="54" step="0.1"
                   placeholder="HCP" style="width:5.5rem"
                   aria-label="Course handicap — use a minus for a plus handicap" />
          </div>
          <button id="add-player-btn" class="btn-primary w-full">Add player</button>
          <div id="add-player-status" class="text-xs mt-2"></div>
        </div>

        <div class="card p-5 mb-4">
          <div class="flex items-center gap-2 mb-1">
            <span style="color:var(--grass-600)">${icon("users", 17)}</span>
            <h3 class="font-bold">Import roster (CSV)</h3>
          </div>
          <p class="text-xs muted mb-3 leading-relaxed">
            Columns <code class="px-1 rounded" style="background:var(--paper)">team</code> and
            <code class="px-1 rounded" style="background:var(--paper)">player</code>.
            No team column? Everyone is auto-grouped into fours, in file order.
            <a class="link-underline font-semibold" style="color:var(--grass-700)" download="teeboard-roster-template.csv" href="data:text/csv;charset=utf-8,${encodeURIComponent("team,player\nThe Duffers,Ben Herbst\nThe Duffers,Gabe Smith\nThe Duffers,Sam Lee\nThe Duffers,Pat Jordan\nBirdie Brigade,Alex Kim\nBirdie Brigade,Jordan Rivera\n")}">Download template</a>
          </p>
          <input type="file" id="csv-input" accept=".csv,text/csv" />
          <div id="csv-status" class="text-xs muted mt-2"></div>
        </div>

        <div class="flex items-center gap-3 mt-6 mb-2.5">
          <h2 class="eyebrow">Tiebreaks</h2>
          <span class="flex-1 hairline"></span>
        </div>

        <div class="card p-5 mb-4">
          <div class="flex items-center gap-2 mb-1">
            <span style="color:var(--grass-600)">${icon("card", 17)}</span>
            <h3 class="font-bold">Hole handicaps</h3>
          </div>
          <p class="text-xs muted mb-4 leading-relaxed">
            Only used to break ties. If two teams finish level, TeeBoard settles it on the
            hardest hole (stroke index 1), then the next hardest — a scorecard playoff.
            Enter each hole's stroke index from the course's real card; leave as-is to
            default to hole order.
          </p>
          <div class="grid grid-cols-2 gap-1.5 mb-4">
            ${Array.from({ length: tournament.num_holes }, (_, idx) => idx + 1).map((h) => `
              <div class="flex items-center justify-between gap-1.5 rounded-lg pl-2 pr-1 py-1" style="background:var(--paper)">
                <span class="eyebrow" style="letter-spacing:.06em">H${holeLabel(tournament, h)}
                  <span class="muted-2">P${par[h - 1]}</span>
                </span>
                <input data-handicap="${h}" type="number" min="1" max="${tournament.num_holes}"
                       value="${handicapArr[h - 1]}" aria-label="Stroke index for hole ${holeLabel(tournament, h)}"
                       class="num-display text-center" style="width:2.6rem;padding:.3rem 0;font-size:1rem" />
              </div>
            `).join("")}
          </div>
          <button id="save-handicaps-btn" class="btn-secondary w-full">Save handicaps</button>
          <div id="handicap-status" class="text-xs mt-2"></div>
        </div>

        ${formatOf(tournament).metric === "skins" ? `
          <div class="flex items-center gap-3 mt-6 mb-2.5">
            <h2 class="eyebrow">Skins pot</h2>
            <span class="flex-1 hairline"></span>
          </div>
          <div class="card p-5 mb-4">
            <label class="field-label">Buy-in per player</label>
            <div class="flex gap-2 mb-2">
              <input id="buyin-edit" type="number" min="0" max="10000" step="1" inputmode="decimal"
                     class="flex-1" placeholder="e.g. 20"
                     value="${tournament.skins_buy_in != null ? Number(tournament.skins_buy_in) : ""}" />
              <button id="save-buyin" class="btn-secondary shrink-0">Save</button>
            </div>
            <p class="text-xs muted">
              ${totalPlayers} player${totalPlayers === 1 ? "" : "s"} entered
              ${tournament.skins_buy_in ? `· pot is ${money(Number(tournament.skins_buy_in) * totalPlayers)}` : ""}.
              The whole pot splits between the skins actually won, so carried holes make the rest worth more.
            </p>
            <div id="buyin-status" class="text-xs mt-2"></div>
          </div>
        ` : ""}

        <div class="flex items-center gap-3 mt-6 mb-2.5">
          <h2 class="eyebrow">Settings</h2>
          <span class="flex-1 hairline"></span>
        </div>

        ${tournament.num_holes === 9 ? `
          <div class="card p-5 mb-2.5">
            <label class="field-label">Which nine is this?</label>
            <p class="text-xs muted mb-3">Only changes the hole numbers shown on cards and the leaderboard — scores already entered stay exactly where they are.</p>
            <select id="start-hole-select">
              <option value="1"${(tournament.start_hole || 1) === 1 ? " selected" : ""}>Front nine — holes 1–9</option>
              <option value="10"${(tournament.start_hole || 1) === 10 ? " selected" : ""}>Back nine — holes 10–18</option>
            </select>
            <div id="start-hole-status" class="text-xs mt-2"></div>
          </div>
        ` : ""}

        <button id="toggle-status" class="btn-secondary w-full mb-2.5">${isActive ? "Close tournament" : "Reopen tournament"}</button>

        <div class="card p-4 flex items-start gap-3">
          <span class="shrink-0 mt-0.5 muted-2">${icon("lock", 18)}</span>
          <p class="text-xs muted">
            Tournaments are kept permanently — six weeks of rounds were lost to
            deletion before this was removed. Close a finished one instead; it
            stays on the record and keeps counting toward player rankings.
          </p>
        </div>
      ` : `
        <div class="card p-4 flex items-start gap-3">
          <span class="shrink-0 mt-0.5 muted-2">${icon("lock", 18)}</span>
          <p class="text-xs muted">Only the organizer who created this tournament can edit its roster and settings.</p>
        </div>
      `}
    `;

    if (window.QRCode) QRCode.toCanvas(document.getElementById("qr"), joinUrl, { width: 200 });

    document.getElementById("copy-link").addEventListener("click", () => {
      navigator.clipboard.writeText(joinUrl).then(() => toast("Join link copied"));
    });
    document.getElementById("print-qr").addEventListener("click", () => {
      window.print();
    });

    document.getElementById("podium-btn").addEventListener("click", async () => {
      const btn = document.getElementById("podium-btn");
      btn.disabled = true;
      const label = btn.innerHTML;
      btn.textContent = "Building…";
      try {
        // Canvas draws with whatever fonts are ready, so wait for the webfonts
        // or the card comes out in a fallback face.
        if (document.fonts && document.fonts.ready) await document.fonts.ready;
        const { data: full } = await sb
          .from("teams")
          .select("id, name, signed_at, team_members(id, player_name, handicap), scores(hole_number, strokes, team_member_id)")
          .eq("tournament_id", tournamentId);
        const ranked = buildLeaderboard(tournament, full).filter((r) => r.thru > 0);
        if (!ranked.length) {
          toast("No scores in yet — nothing to put on a result card.", true);
          return;
        }
        showPodiumSheet(tournament, ranked);
      } finally {
        btn.disabled = false;
        btn.innerHTML = label;
      }
    });

    if (isOwner) {
      // Deleting a tournament is gone deliberately. Six weeks of Thursday
      // rounds — full fields, hundreds of scores — were destroyed by it, and
      // a cascade delete leaves nothing to recover. Closing a tournament does
      // everything an organizer actually wanted from it.
      const saveBuyin = document.getElementById("save-buyin");
      if (saveBuyin) {
        saveBuyin.addEventListener("click", async () => {
          const raw = document.getElementById("buyin-edit").value.trim();
          const statusEl = document.getElementById("buyin-status");
          const value = raw === "" ? null : parseFloat(raw);
          if (value != null && (isNaN(value) || value < 0)) {
            statusEl.className = "text-xs mt-2 status-err";
            statusEl.textContent = "Enter an amount, or leave blank to play for pride.";
            return;
          }
          saveBuyin.disabled = true;
          const { error } = await sb.from("tournaments")
            .update({ skins_buy_in: value }).eq("id", tournament.id);
          saveBuyin.disabled = false;
          if (error) {
            statusEl.className = "text-xs mt-2 status-err";
            statusEl.textContent = "Couldn't save: " + error.message;
            return;
          }
          tournament.skins_buy_in = value;
          toast(value ? `Buy-in set to ${money(value)}` : "Playing for pride");
          render();
        });
      }

      const startHoleSelect = document.getElementById("start-hole-select");
      if (startHoleSelect) {
        startHoleSelect.addEventListener("change", async () => {
          const val = parseInt(startHoleSelect.value, 10);
          const statusEl = document.getElementById("start-hole-status");
          startHoleSelect.disabled = true;
          const { error } = await sb.from("tournaments").update({ start_hole: val }).eq("id", tournament.id);
          startHoleSelect.disabled = false;
          if (error) {
            statusEl.className = "text-xs mt-2 status-err";
            statusEl.textContent = "Couldn't save: " + error.message;
            startHoleSelect.value = String(tournament.start_hole || 1);
            return;
          }
          tournament.start_hole = val;
          toast(val === 10 ? "Now showing holes 10–18" : "Now showing holes 1–9");
          render();
        });
      }

      document.getElementById("save-handicaps-btn").addEventListener("click", async () => {
        const inputs = app.querySelectorAll("[data-handicap]");
        const vals = Array.from({ length: tournament.num_holes }, () => null);
        let valid = true;
        inputs.forEach((inp) => {
          const h = parseInt(inp.dataset.handicap, 10);
          const v = parseInt(inp.value, 10);
          if (!v || v < 1) valid = false;
          vals[h - 1] = v;
        });
        const statusEl = document.getElementById("handicap-status");
        if (!valid) {
          statusEl.className = "text-xs mt-2 status-err";
          statusEl.textContent = "Enter a stroke index (1 or higher) for every hole.";
          return;
        }
        const btn = document.getElementById("save-handicaps-btn");
        btn.disabled = true;
        const { error } = await sb.from("tournaments").update({ handicap: vals }).eq("id", tournament.id);
        btn.disabled = false;
        if (error) {
          statusEl.className = "text-xs mt-2 status-err";
          statusEl.textContent = "Couldn't save: " + error.message;
          return;
        }
        tournament.handicap = vals;
        statusEl.className = "text-xs mt-2 status-ok";
        statusEl.textContent = "Saved — ties will now use these for scorecard-playoff countback.";
      });

      document.getElementById("toggle-status").addEventListener("click", async () => {
        const newStatus = tournament.status === "active" ? "closed" : "active";
        await sb.from("tournaments").update({ status: newStatus }).eq("id", tournament.id);
        tournament.status = newStatus;
        render();
      });
      document.getElementById("csv-input").addEventListener("change", async (e) => {
        const file = e.target.files[0];
        if (file) await importRosterCsv(file);
        e.target.value = "";
      });

      const addTeamSelect = document.getElementById("add-team-select");
      const newTeamWrap = document.getElementById("new-team-name-wrap");
      const updateNewTeamWrap = () => newTeamWrap.classList.toggle("hidden", addTeamSelect.value !== "__new");
      updateNewTeamWrap();
      addTeamSelect.addEventListener("change", updateNewTeamWrap);

      document.getElementById("add-player-btn").addEventListener("click", async () => {
        const teamChoice = addTeamSelect.value;
        const newTeamName = document.getElementById("new-team-name").value.trim();
        const playerName = document.getElementById("add-player-name").value.trim();
        const hcpRaw = document.getElementById("add-player-hcp").value.trim();
        const handicap = hcpRaw === "" ? null : Number(hcpRaw);
        const statusEl = document.getElementById("add-player-status");
        const btn = document.getElementById("add-player-btn");

        if (handicap != null && (!Number.isFinite(handicap) || handicap < -10 || handicap > 54)) {
          statusEl.className = "text-xs mt-2 status-err";
          statusEl.textContent = "Handicap must be between -10 (plus 10) and 54, or left blank.";
          return;
        }

        if (!playerName) {
          statusEl.className = "text-xs mt-2 status-err";
          statusEl.textContent = "Enter a player name.";
          return;
        }
        if (teamChoice === "__new" && !newTeamName) {
          statusEl.className = "text-xs mt-2 status-err";
          statusEl.textContent = "Enter a team name.";
          return;
        }

        btn.disabled = true;
        statusEl.className = "text-xs mt-2 status-info";
        statusEl.textContent = "Adding…";

        const result = await addPlayerManually(teamChoice, newTeamName, playerName, handicap);

        btn.disabled = false;
        if (result.error) {
          statusEl.className = "text-xs mt-2 status-err";
          statusEl.textContent = result.error;
          return;
        }
        toast(`Added ${playerName}${teamChoice === "__new" ? ` to new team "${newTeamName}"` : ""}`);
        render();
      });

      app.querySelectorAll("[data-manage-team]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const id = btn.dataset.manageTeam;
          if (expandedTeams.has(id)) expandedTeams.delete(id);
          else expandedTeams.add(id);
          render();
        });
      });

      app.querySelectorAll("[data-rename-btn]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const id = btn.dataset.renameBtn;
          const input = app.querySelector(`[data-rename-input="${id}"]`);
          const newName = input.value.trim();
          if (!newName) return toast("Enter a team name", true);
          btn.disabled = true;
          const { error } = await sb.rpc("organizer_rename_team", { p_team_id: id, p_name: newName });
          btn.disabled = false;
          if (error) return toast("Couldn't rename team: " + error.message, true);
          toast("Team renamed");
          render();
        });
      });

      app.querySelectorAll("[data-remove-member]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const id = btn.dataset.removeMember;
          btn.disabled = true;
          const { error } = await sb.rpc("organizer_remove_player", { p_member_id: id });
          if (error) {
            btn.disabled = false;
            return toast("Couldn't remove player: " + error.message, true);
          }
          render();
        });
      });

      app.querySelectorAll("[data-reopen-team]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const id = btn.dataset.reopenTeam;
          if (!confirm("Reopen this scorecard? The team will be able to edit scores again.")) return;
          btn.disabled = true;
          const { error } = await sb.rpc("organizer_reopen_card", { p_team_id: id });
          if (error) {
            btn.disabled = false;
            return toast("Couldn't reopen: " + error.message, true);
          }
          toast("Scorecard reopened");
          render();
        });
      });

      app.querySelectorAll("[data-quick-add-btn]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const id = btn.dataset.quickAddBtn;
          const input = app.querySelector(`[data-quick-add-input="${id}"]`);
          const playerName = input.value.trim();
          if (!playerName) return toast("Enter a player name", true);
          btn.disabled = true;
          const { error } = await sb.rpc("organizer_add_player", { p_team_id: id, p_player_name: playerName });
          btn.disabled = false;
          if (error) return toast("Couldn't add player: " + error.message, true);
          expandedTeams.add(id); // keep this team's panel open so you can keep adding players
          render();
        });
      });
    }
  }

  // Lets the organizer add a single player directly, without a CSV — either
  // onto an existing team or a brand new one.
  async function addPlayerManually(teamChoice, newTeamName, playerName, handicap = null) {
    let teamId = teamChoice;
    if (teamChoice === "__new") {
      // The join code is generated server-side now, so the client can't pick
      // one and collisions are retried inside the database.
      const { data: created, error: teamErr } = await sb.rpc("organizer_add_team", {
        p_tournament_id: tournamentId,
        p_team_name: newTeamName,
      });
      if (teamErr || !created) return { error: teamErr?.message || "Couldn't create team, try again." };
      teamId = created.id;
    }
    const { error: memberErr } = await sb.rpc("organizer_add_player", {
      p_team_id: teamId,
      p_player_name: playerName,
      p_handicap: handicap,
    });
    if (memberErr) return { error: memberErr.message };
    return { ok: true };
  }

  function findColumn(fields, candidates) {
    const norm = (s) => s.trim().toLowerCase();
    for (const field of fields) {
      if (candidates.includes(norm(field))) return field;
    }
    return null;
  }

  async function importRosterCsv(file) {
    const statusEl = document.getElementById("csv-status");
    statusEl.textContent = "Reading file…";

    if (!window.Papa) {
      statusEl.textContent = "CSV parser failed to load — check your connection and try again.";
      return;
    }

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (results) => {
        const fields = results.meta.fields || [];
        let playerCol = findColumn(fields, ["player", "player name", "name"]);
        const teamCol = findColumn(fields, ["team", "team name"]);

        if (!playerCol && fields.length === 1) playerCol = fields[0];
        if (!playerCol) {
          statusEl.textContent = "Couldn't find a player column — expected a header called \"player\" (and optionally \"team\").";
          return;
        }

        const rows = results.data
          .map((r) => ({ team: teamCol ? String(r[teamCol] || "").trim() : "", player: String(r[playerCol] || "").trim() }))
          .filter((r) => r.player);

        if (!rows.length) {
          statusEl.textContent = "No player names found in that file.";
          return;
        }

        // group into teams: use the team column if present, otherwise auto-chunk into groups of 4
        const groups = []; // [{ name, players: [] }]
        if (teamCol) {
          const byName = new Map();
          for (const r of rows) {
            const key = r.team || "Unassigned";
            if (!byName.has(key)) byName.set(key, { name: key, players: [] });
            byName.get(key).players.push(r.player);
          }
          groups.push(...byName.values());
        } else {
          for (let i = 0; i < rows.length; i += 4) {
            groups.push({ name: `Team ${Math.floor(i / 4) + 1}`, players: rows.slice(i, i + 4).map((r) => r.player) });
          }
        }

        statusEl.textContent = `Importing ${groups.length} team(s), ${rows.length} player(s)…`;

        const { data: existingTeams } = await sb
          .from("teams")
          .select("id, name, team_members(player_name)")
          .eq("tournament_id", tournamentId);

        let teamsCreated = 0, playersAdded = 0;

        for (const group of groups) {
          let team = (existingTeams || []).find((t) => t.name.trim().toLowerCase() === group.name.trim().toLowerCase());
          let existingPlayerNames = (team?.team_members || []).map((m) => m.player_name.trim().toLowerCase());

          if (!team) {
            const { data: created, error: teamErr } = await sb.rpc("organizer_add_team", {
              p_tournament_id: tournamentId,
              p_team_name: group.name,
            });
            if (teamErr || !created) {
              statusEl.textContent = `Error creating team "${group.name}": ${teamErr?.message || "try again"}`;
              return;
            }
            team = { id: created.id, name: created.name };
            existingPlayerNames = [];
            teamsCreated++;
          }

          for (const playerName of group.players) {
            if (existingPlayerNames.includes(playerName.trim().toLowerCase())) continue;
            const { error: memberErr } = await sb.rpc("organizer_add_player", {
              p_team_id: team.id,
              p_player_name: playerName,
            });
            if (!memberErr) playersAdded++;
          }
        }

        statusEl.textContent = "";
        toast(`Imported ${teamsCreated} new team(s), ${playersAdded} player(s) added.`);
        render();
      },
      error: (err) => {
        statusEl.textContent = "Couldn't read that file: " + err.message;
      },
    });
  }

  await render();

  realtimeChannel = sb
    .channel(`admin-${tournamentId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "teams" }, render)
    .on("postgres_changes", { event: "*", schema: "public", table: "scores" }, render)
    .on("postgres_changes", { event: "*", schema: "public", table: "team_members" }, render)
    .subscribe();
}

// ---------- JOIN FLOW ----------

function viewJoin(prefillCode) {
  app.innerHTML = `
    <div class="mb-4">
      <div class="eyebrow mb-1">Player</div>
      <h1 class="text-2xl">Join a tournament</h1>
    </div>
    <form id="code-form" class="card p-5">
      <label class="field-label text-center">Tournament code</label>
      <input name="code" required maxlength="8" autocapitalize="characters" autocomplete="off"
             class="code-input mb-4" value="${escapeHtml(prefillCode || "")}" />
      <button class="btn-primary w-full" type="submit">Find tournament</button>
    </form>
    <p class="text-xs muted-2 text-center mt-3">Your organizer hands out the 5-character code — or scan their QR.</p>
    <div id="join-body"></div>
  `;

  document.getElementById("code-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = new FormData(e.target).get("code").trim().toUpperCase();
    const btn = e.target.querySelector("button");
    btn.disabled = true;
    btn.textContent = "Searching…";
    // Looked up through the RPC rather than a filter on join_code: anonymous
    // visitors can't read that column at all, which is what keeps the public
    // board from being a list of ways into other people's rounds. Presenting
    // the right code is what returns the row.
    const { data, error } = await sb.rpc("player_find_tournament", { p_code: code });
    const tournament = Array.isArray(data) ? data[0] : data;
    btn.disabled = false;
    btn.textContent = "Find tournament";
    if (error || !tournament || !tournament.id) {
      toast("No tournament found with that code", true);
      return;
    }
    if (tournament.status !== "active") {
      toast("That tournament is closed", true);
      return;
    }
    renderTeamStep(tournament, code);
  });

  if (prefillCode) {
    document.getElementById("code-form").requestSubmit();
  }
}

async function renderTeamStep(tournament, enteredCode) {
  const savedName = load("bb_player_name", "");
  const body = document.getElementById("join-body");
  body.innerHTML = `
    <div class="flex items-center gap-3 mt-6 mb-2.5">
      <span class="eyebrow">Found it</span>
      <span class="flex-1 hairline"></span>
    </div>

    <div class="card overflow-hidden mb-3">
      <div class="px-5 py-4" style="background:var(--ink-900);color:#fff">
        <div class="eyebrow on-dark mb-1">Tournament</div>
        <div class="display" style="font-size:1.5rem">${escapeHtml(tournament.name)}</div>
      </div>

      <div class="p-5">
        <label class="field-label">Find your name</label>
        <input id="name-search" placeholder="Start typing your name…" autocomplete="off" class="mb-2" />
        <div id="name-search-loading" class="eyebrow mb-2">Loading roster…</div>
        <div id="name-results" class="flex flex-col gap-2 mb-2"></div>
        <p id="name-empty-note" class="hidden text-xs muted-2 mb-3">Nobody's on this tournament's roster yet — ask your organizer, or set up your own team below.</p>

        <button id="toggle-other-options" class="btn-ghost mt-1">Not on the list? Use a team code ${icon("arrow", 13)}</button>

        <div id="other-options" class="hidden mt-4 pt-4" style="border-top:1px solid var(--line)">
          <label class="field-label">Your name</label>
          <input id="player-name" placeholder="Your name" value="${escapeHtml(savedName)}" class="mb-4" />

          <div class="flex gap-2 mb-3">
            <button id="mode-new" class="btn-secondary flex-1 text-sm">Create a team</button>
            <button id="mode-existing" class="btn-secondary flex-1 text-sm">Join a team</button>
          </div>
          <div id="team-mode-body"></div>
        </div>
      </div>
    </div>
  `;

  document.getElementById("toggle-other-options").addEventListener("click", () => {
    document.getElementById("other-options").classList.toggle("hidden");
  });

  // ---- Find your name: search the full roster the organizer already set up ----
  let roster = [];
  const loadingEl = document.getElementById("name-search-loading");
  const emptyNote = document.getElementById("name-empty-note");
  const nameSearch = document.getElementById("name-search");
  const nameResults = document.getElementById("name-results");

  // Team codes are no longer readable from the table — knowing the tournament
  // code is what earns them, and this screen is only reached by entering one.
  const { data: rosterData } = await sb.rpc("player_roster", { p_tournament_code: tournament.join_code || enteredCode });
  roster = (rosterData || []).map((r) => ({
    id: r.member_id, player_name: r.player_name, team_id: r.team_id,
    teams: { id: r.team_id, name: r.team_name, join_code: r.team_code },
  }));
  loadingEl.classList.add("hidden");
  if (!roster.length) emptyNote.classList.remove("hidden");

  function renderNameResults(list) {
    nameResults.innerHTML = list.map((m) => `
      <button data-team-id="${escapeHtml(m.team_id)}" data-team-name="${escapeHtml(m.teams.name)}" data-team-code="${escapeHtml(m.teams.join_code)}" data-player-name="${escapeHtml(m.player_name)}" class="row-link text-left" style="padding:.7rem .85rem">
        <div class="min-w-0 flex-1">
          <div class="font-semibold text-sm truncate">${escapeHtml(m.player_name)}</div>
          <div class="eyebrow mt-0.5">${escapeHtml(m.teams.name)}</div>
        </div>
        <span class="btn-ghost shrink-0">Go ${icon("arrow", 13)}</span>
      </button>
    `).join("");
    nameResults.querySelectorAll("button[data-team-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        store("bb_player_name", btn.dataset.playerName);
        saveMyTeam(tournament.id, {
          teamId: btn.dataset.teamId,
          teamName: btn.dataset.teamName,
          teamCode: btn.dataset.teamCode,
          tournamentCode: tournament.join_code,
        });
        location.hash = `#/team/${btn.dataset.teamId}`;
      });
    });
  }

  nameSearch.addEventListener("input", () => {
    const q = nameSearch.value.trim().toLowerCase();
    if (!q) return renderNameResults([]);
    const matches = roster.filter((m) => m.player_name.toLowerCase().includes(q)).slice(0, 8);
    if (!matches.length) {
      nameResults.innerHTML = `<div class="text-xs muted-2 p-1">No match yet — keep typing, or use a team code below.</div>`;
      return;
    }
    renderNameResults(matches);
  });

  // ---- Fallback: team code or brand-new team, for anyone not pre-added ----
  document.getElementById("mode-new").addEventListener("click", () => {
    document.getElementById("team-mode-body").innerHTML = `
      <label class="field-label">Team name</label>
      <input id="team-name" placeholder="e.g. The Duffers" class="mb-3" />
      <button id="submit-new-team" class="btn-primary w-full">Create team</button>
    `;
    document.getElementById("submit-new-team").addEventListener("click", async () => {
      const playerName = document.getElementById("player-name").value.trim();
      const teamName = document.getElementById("team-name").value.trim();
      if (!playerName || !teamName) return toast("Enter your name and a team name", true);
      store("bb_player_name", playerName);

      // Goes through player_create_team so the write is gated on knowing the
      // tournament code, rather than on holding the public anon key.
      const { data: team, error } = await sb.rpc("player_create_team", {
        p_tournament_code: tournament.join_code,
        p_team_name: teamName,
        p_player_name: playerName,
      });
      if (error || !team) return toast(error?.message || "Couldn't create team, try again", true);

      saveMyTeam(tournament.id, { teamId: team.id, teamName: team.name, teamCode: team.join_code, tournamentCode: tournament.join_code });
      location.hash = `#/team/${team.id}`;
    });
  });

  document.getElementById("mode-existing").addEventListener("click", () => {
    document.getElementById("team-mode-body").innerHTML = `
      <label class="field-label text-center">Team code</label>
      <input id="team-code" maxlength="6" autocapitalize="characters" autocomplete="off"
             class="code-input mb-3" style="font-size:1.9rem" />
      <button id="submit-join-team" class="btn-primary w-full">Join team</button>
    `;
    document.getElementById("submit-join-team").addEventListener("click", async () => {
      const playerName = document.getElementById("player-name").value.trim();
      const teamCode = document.getElementById("team-code").value.trim().toUpperCase();
      if (!playerName || !teamCode) return toast("Enter your name and the team code", true);
      store("bb_player_name", playerName);

      const { data: team, error } = await sb.rpc("player_join_team", {
        p_tournament_code: tournament.join_code,
        p_team_code: teamCode,
        p_player_name: playerName,
      });
      if (error || !team) return toast(error?.message || "No team found with that code", true);

      saveMyTeam(tournament.id, { teamId: team.id, teamName: team.name, teamCode: team.join_code, tournamentCode: tournament.join_code });
      location.hash = `#/team/${team.id}`;
    });
  });
}

// ---------- SCORECARD ----------

// Strokes each player gets per hole on a scoring screen. A match plays off the
// difference between the sides; stroke play off the full handicap.
function scoringAllocations(tournament, sides) {
  if (formatOf(tournament).match) return matchAllocations(tournament, sides);
  const alloc = new Map();
  sides.flatMap((s) => s.players).forEach((p) => {
    alloc.set(p.id, strokeAllocation(tournament, Number(p.handicap) || 0));
  });
  return alloc;
}

// "4 → 3" when a shot lands on this hole, the gross alone when it doesn't.
// A plus handicap gives one back, so the arrow can point the other way.
function netHtml(gross, pops) {
  if (gross === "" || gross == null) return "";
  if (!pops || pops <= 0) return "";
  const net = gross - pops;
  return `<span class="netcell" title="${pops} shot${pops > 1 ? "s" : ""} here">
            <span class="np-arrow">→</span><span class="np-net">${net}</span>
          </span>`;
}

// ---------- ONE SCORER, WHOLE GROUP ----------
//
// The normal flow is a phone per side. With single_scorer on, one person
// enters every player's card, so this screen spans both sides instead of one
// team. Writes still go through player_set_score gated on each side's own
// code, so nothing here widens who can change a card.

async function viewMatchScore(tournamentId) {
  app.innerHTML = loadingHtml();

  const { data: tournament, error } = await sb
    .from("tournaments").select(TOURNAMENT_COLS).eq("id", tournamentId).single();
  if (error || !tournament) { app.innerHTML = notFoundHtml("Match"); return; }

  const par = tournament.par && tournament.par.length === tournament.num_holes
    ? tournament.par : Array(tournament.num_holes).fill(4);
  const n = tournament.num_holes;

  // Scoring is not a public act. Only the organizer, or somebody holding the
  // round's code, may open this screen — previously the button was on the
  // leaderboard and the screen was reachable by anyone who saw it.
  let code = myTeams()[tournamentId]?.tournamentCode || null;
  if (!code) {
    const user = await getUser();
    if (user && tournament.created_by === user.id) code = tournament.join_code || null;
  }
  if (!code) return renderScoreGate();

  function renderScoreGate(message) {
    app.innerHTML = `
      <div class="idband"><div class="idband-top"><div class="min-w-0">
        <div class="idname">${escapeHtml(tournament.name)}</div>
        <div class="idmeta">${escapeHtml(formatOf(tournament).label)}</div>
      </div></div></div>
      <div class="card p-5 mt-3">
        <h2 class="text-lg mb-1">Enter the code to score</h2>
        <p class="text-sm muted mb-4">Anyone can follow this match. Entering scores needs the code the organizer shared.</p>
        <input id="gate-code" placeholder="Join code" autocomplete="off"
               style="text-transform:uppercase;letter-spacing:.12em" class="mb-3" />
        <button id="gate-go" class="btn-primary w-full">Start scoring</button>
        <p id="gate-err" class="text-xs status-err mt-2">${message ? escapeHtml(message) : ""}</p>
        <a href="#/leaderboard/${tournamentId}" class="block text-center text-sm mt-4"
           style="color:var(--blue);font-weight:600">Just watching — show me the match</a>
      </div>`;
    document.getElementById("gate-go").addEventListener("click", async () => {
      const entered = document.getElementById("gate-code").value.trim().toUpperCase();
      if (!entered) return;
      // The RPC is the check: a wrong code returns nothing, so there is no way
      // to confirm a guess from the client alone.
      const { data, error } = await sb.rpc("player_roster", { p_tournament_code: entered });
      if (error || !data?.length) return renderScoreGate("That code doesn't match this match.");
      if (!data.some((r) => r.team_id)) return renderScoreGate("That code doesn't match this match.");
      const { data: found } = await sb.rpc("player_find_tournament", { p_code: entered });
      const t = Array.isArray(found) ? found[0] : found;
      if (!t || t.id !== tournamentId) return renderScoreGate("That code is for a different round.");
      saveMyTeam(tournamentId, { tournamentCode: entered });
      code = entered;
      render();
    });
  }

  async function render() {
    // Codes come from the code-gated roster, not from the teams table.
    const { data: rosterRows, error: rosterErr } = await sb.rpc("player_roster", { p_tournament_code: code });
    if (rosterErr) return renderScoreGate("That code no longer works.");

    const { data: teams } = await sb
      .from("teams")
      .select("id, name, signed_at, team_members(id, player_name, handicap), scores(hole_number, strokes, team_member_id)")
      .eq("tournament_id", tournamentId);

    const codeByTeam = Object.fromEntries((rosterRows || []).map((r) => [r.team_id, r.team_code]));
    (teams || []).forEach((t) => { t.join_code = codeByTeam[t.id]; });

    const sides = (teams || []).slice(0, 2);
    if (sides.length < 2) {
      app.innerHTML = `<div class="panel p-8 text-center mt-4">
        <p class="text-sm muted">This match doesn't have two sides yet.</p></div>`;
      return;
    }

    // Flatten to the people actually holding a club, each carrying the code
    // its own side scores under.
    const players = sides.flatMap((t) => (t.team_members || []).map((m) => ({
      id: m.id, name: m.player_name, handicap: m.handicap,
      teamId: t.id, teamCode: t.join_code, sideName: t.name,
    })));
    const allocSides = sides.map((t) => ({
      players: (t.team_members || []).map((m) => ({ id: m.id, handicap: m.handicap })),
    }));
    const alloc = scoringAllocations(tournament, allocSides);

    const byMember = {};
    players.forEach((p) => { byMember[p.id] = {}; });
    sides.forEach((t) => (t.scores || []).forEach((sc) => {
      if (sc.team_member_id && byMember[sc.team_member_id]) byMember[sc.team_member_id][sc.hole_number] = sc.strokes;
    }));

    const locked = sides.every((t) => t.signed_at);
    const done = players.every((p) => Object.keys(byMember[p.id]).length >= n);

    let holes = "";
    for (let h = 1; h <= n; h++) {
      holes += `
        <div class="card px-3 py-2.5 mb-2">
          <div class="flex items-center gap-3 mb-2">
            <span class="num-display" style="font-size:1.4rem;min-width:1.6rem">${holeLabel(tournament, h)}</span>
            <span class="eyebrow">Par ${par[h - 1]}</span>
            ${tournament.yardage?.[h - 1] ? `<span class="eyebrow">${tournament.yardage[h - 1]} yds</span>` : ""}
          </div>
          <div class="flex flex-col gap-1.5">
            ${players.map((p) => {
              const v = byMember[p.id][h] ?? "";
              return `
                <div class="flex items-center justify-between gap-2">
                  <span class="text-sm truncate ${v === "" ? "muted-2" : ""}">
                    ${escapeHtml(p.name)}${(alloc.get(p.id)?.[h - 1] ?? 0) > 0 ? `<span class="popdot" title="gets a shot here">${
                      "•".repeat(Math.min(3, alloc.get(p.id)[h - 1]))
                    }</span>` : ""}
                  </span>
                  ${netHtml(v, alloc.get(p.id)?.[h - 1] ?? 0)}
                  ${locked ? `
                    <span class="hole-mark hole-mark-sm ${holeMarkClass(byMember[p.id][h], par[h - 1])}">${v || "—"}</span>
                  ` : `
                    <span class="flex items-center gap-1 shrink-0">
                      <button data-hole="${h}" data-member="${p.id}" data-delta="-1" class="step-btn"
                              style="width:2.1rem;height:2.1rem;font-size:1.1rem"
                              aria-label="One less for ${escapeHtml(p.name)} on hole ${holeLabel(tournament, h)}">−</button>
                      <input data-hole="${h}" data-member="${p.id}" type="number" inputmode="numeric" min="1" max="15"
                             value="${v}" class="step-value" style="width:2.6rem;height:2.1rem;font-size:1.15rem"
                             aria-label="Strokes for ${escapeHtml(p.name)} on hole ${holeLabel(tournament, h)}" placeholder="–" />
                      <button data-hole="${h}" data-member="${p.id}" data-delta="1" class="step-btn"
                              style="width:2.1rem;height:2.1rem;font-size:1.1rem"
                              aria-label="One more for ${escapeHtml(p.name)} on hole ${holeLabel(tournament, h)}">+</button>
                    </span>
                  `}
                </div>`;
            }).join("")}
          </div>
        </div>`;
    }

    app.innerHTML = `
      <div class="idband">
        <div class="idband-top">
          <div class="min-w-0">
            <div class="idname">${escapeHtml(tournament.name)}</div>
            <div class="idmeta">${escapeHtml(formatOf(tournament).label)} · keeping score for everyone</div>
          </div>
        </div>
      </div>
      <div class="mt-3">${holes}</div>
      <a href="#/leaderboard/${tournamentId}" class="btn-primary w-full mt-1">
        ${done ? "See the result" : "See the match"}
      </a>
      <p class="text-xs muted-2 text-center mt-3">Scores save as you enter them.</p>
    `;

    if (locked) return;

    const playerById = Object.fromEntries(players.map((p) => [p.id, p]));

    async function save(hole, strokes, memberId) {
      const p = playerById[memberId];
      if (!p) return;
      const entry = {
        p_team_code: p.teamCode,
        p_hole: hole,
        p_strokes: strokes,
        p_member_id: memberId,
      };
      let err = null;
      try { ({ error: err } = await sb.rpc("player_set_score", entry)); }
      catch (e) { err = e; }
      if (!err) return render();
      if (isConnectionError(err)) { queueScore(entry); toast("Saved on this phone — will sync when you're back online"); }
      else toast("Couldn't save: " + (err.message || "try again"), true);
    }

    app.querySelectorAll("button[data-delta]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const hole = +btn.dataset.hole, member = btn.dataset.member;
        const input = app.querySelector(`input[data-hole="${hole}"][data-member="${member}"]`);
        const current = parseInt(input.value, 10);
        const next = Number.isFinite(current) ? current + (+btn.dataset.delta) : par[hole - 1];
        if (next < 1 || next > 15) return;
        input.value = next;
        save(hole, next, member);
      });
    });
    app.querySelectorAll("input[data-hole]").forEach((input) => {
      input.addEventListener("change", () => {
        const v = parseInt(input.value, 10);
        if (!Number.isFinite(v) || v < 1 || v > 15) { input.value = ""; return; }
        save(+input.dataset.hole, v, input.dataset.member);
      });
    });
  }

  await render();
}

async function viewTeam(teamId) {
  app.innerHTML = loadingHtml();

  // `tournaments(*)` is refused for anonymous players now that join_code is
  // not readable by them — and this is the scoring screen, which has to work
  // without an account. Name the columns instead.
  const { data: team, error: teamErr } = await sb.from("teams")
    .select(`*, tournaments(${TOURNAMENT_COLS_EMBED})`).eq("id", teamId).single();
  if (teamErr || !team) {
    app.innerHTML = notFoundHtml("Team");
    return;
  }
  const tournament = team.tournaments;
  const par = tournament.par && tournament.par.length === tournament.num_holes ? tournament.par : Array(tournament.num_holes).fill(4);

  // "score" = the normal (editable, or locked-after-signing) scorecard.
  // "review" = the review-and-sign screen shown before final submission.
  let mode = "score";

  async function render() {
    const { data: members } = await sb.from("team_members").select("id, player_name, handicap").eq("team_id", teamId);
    const { data: scores } = await sb.from("scores").select("hole_number, strokes, team_member_id").eq("team_id", teamId);
    const perPlayer = isPlayerScored(tournament);
    const roster = members || [];

    // Team formats use the rows with no player attached; per-player formats
    // keep one map per member.
    const scoreMap = {};
    (scores || []).forEach((s) => {
      if (s.team_member_id == null) scoreMap[s.hole_number] = s.strokes;
    });
    const byMember = {};
    roster.forEach((m) => {
      byMember[m.id] = {};
      (scores || []).forEach((s) => {
        if (s.team_member_id === m.id) byMember[m.id][s.hole_number] = s.strokes;
      });
    });

    // In per-player formats the team header shows the best ball on each hole,
    // which is the number that actually matters to the team.
    if (perPlayer) {
      for (let h = 1; h <= tournament.num_holes; h++) {
        let best = null;
        roster.forEach((m) => {
          const v = byMember[m.id][h];
          if (v != null && (best == null || v < best)) best = v;
        });
        if (best != null) scoreMap[h] = best;
      }
    }

    let totalStrokes = 0, totalPar = 0, thru = 0;
    for (let h = 1; h <= tournament.num_holes; h++) {
      if (scoreMap[h] != null) {
        totalStrokes += scoreMap[h];
        totalPar += par[h - 1];
        thru++;
      }
    }
    const toPar = totalStrokes - totalPar;
    const isSigned = !!team.signed_at;
    const allEntered = thru === tournament.num_holes;

    if (mode === "review") {
      app.innerHTML = `
        <div class="mb-4">
          <div class="eyebrow mb-1">Final check</div>
          <h1 class="text-2xl">Review &amp; sign</h1>
          <p class="text-sm muted mt-1">${escapeHtml(team.name)} &middot; ${escapeHtml(tournament.name)}</p>
        </div>

        <div class="card overflow-hidden mb-3">
          ${scorecardGridHtml(par, scoreMap, tournament.start_hole || 1, tournament.yardage, tournament.handicap)}
        </div>

        <div class="card p-4 mb-3 flex items-center justify-between">
          <span class="eyebrow">Total</span>
          <span class="flex items-baseline gap-3">
            <span class="num-display" style="font-size:1.6rem">${totalStrokes}</span>
            <span class="to-par ${toParClass(toPar)}" style="font-size:1.6rem">${toParLabel(toPar)}</span>
          </span>
        </div>

        <div class="card p-5 mb-4">
          <p class="text-sm muted mb-4">By signing, you confirm this card is accurate for <b style="color:var(--ink)">${escapeHtml(team.name)}</b>. Once signed it locks — ask your organizer if you need a correction.</p>
          <label class="field-label">Type your name to sign</label>
          <input id="sign-name" placeholder="Your name" value="${escapeHtml(load("bb_player_name", ""))}" class="mb-4" />
          <div class="flex gap-2">
            <button id="back-to-edit" class="btn-secondary flex-1">Back</button>
            <button id="sign-submit" class="btn-green flex-1">Sign &amp; submit</button>
          </div>
        </div>
      `;
      document.getElementById("back-to-edit").addEventListener("click", () => { mode = "score"; render(); });
      document.getElementById("sign-submit").addEventListener("click", async () => {
        const name = document.getElementById("sign-name").value.trim();
        if (!name) return toast("Enter your name to sign", true);
        const btn = document.getElementById("sign-submit");
        btn.disabled = true;
        btn.textContent = "Signing…";
        const signedAt = new Date().toISOString();
        const { error } = await sb.rpc("player_sign_card", {
          p_team_code: team.join_code,
          p_signed_by: name,
        });
        if (error) {
          toast("Couldn't sign: " + error.message, true);
          btn.disabled = false;
          btn.textContent = "Sign & submit";
          return;
        }
        store("bb_player_name", name);
        team.signed_at = signedAt;
        team.signed_by = name;
        mode = "score";
        render();
        toast("Scorecard signed — nice round!");
      });
      return;
    }

    // Once signed the card is read-only, so show the same compact grid the
    // public scorecard view uses rather than 18 rows of dead steppers.
    // Score entry, grouped into nines so an 18-hole card has a natural
    // turn at the halfway point rather than one endless scroll.
    let holesHtml = isSigned
      ? `<div class="card overflow-hidden">${scorecardGridHtml(par, scoreMap, tournament.start_hole || 1, tournament.yardage, tournament.handicap)}</div>`
      : "";
    for (let h = 1; !isSigned && h <= tournament.num_holes; h++) {
      if (tournament.num_holes > 9 && (h === 1 || h === 10)) {
        holesHtml += `
          <div class="flex items-center gap-3 ${h === 1 ? "" : "mt-4 "}mb-1">
            <span class="eyebrow">${h === 1 ? "Front nine" : "Back nine"}</span>
            <span class="flex-1 hairline"></span>
          </div>`;
      }
      const val = scoreMap[h] ?? "";
      const entered = scoreMap[h] != null;

      if (perPlayer) {
        // One row per player: everyone records their own ball.
        holesHtml += `
          <div class="card px-3 py-2.5">
            <div class="flex items-center gap-3 mb-2">
              <span class="num-display" style="font-size:1.4rem;min-width:1.6rem">${holeLabel(tournament, h)}</span>
              <span class="eyebrow">Par ${par[h - 1]}</span>
              ${tournament.yardage?.[h - 1] ? `<span class="eyebrow">${tournament.yardage[h - 1]} yds</span>` : ""}
            </div>
            <div class="flex flex-col gap-1.5">
              ${roster.map((m) => {
                const pv = byMember[m.id][h] ?? "";
                return `
                <div class="flex items-center justify-between gap-2">
                  <span class="text-sm truncate ${pv === "" ? "muted-2" : ""}">${escapeHtml(m.player_name)}</span>
                  ${isSigned ? `
                    <span class="hole-mark hole-mark-sm ${holeMarkClass(byMember[m.id][h], par[h - 1])}">${pv || "—"}</span>
                  ` : `
                    <span class="flex items-center gap-1 shrink-0">
                      <button data-hole="${h}" data-member="${m.id}" data-delta="-1" class="step-btn"
                              style="width:2.1rem;height:2.1rem;font-size:1.1rem"
                              aria-label="One less for ${escapeHtml(m.player_name)} on hole ${holeLabel(tournament, h)}">−</button>
                      <input data-hole="${h}" data-member="${m.id}" type="number" inputmode="numeric" min="1" max="15"
                             value="${pv}" class="step-value" style="width:2.6rem;height:2.1rem;font-size:1.15rem"
                             aria-label="Strokes for ${escapeHtml(m.player_name)} on hole ${holeLabel(tournament, h)}" placeholder="–" />
                      <button data-hole="${h}" data-member="${m.id}" data-delta="1" class="step-btn"
                              style="width:2.1rem;height:2.1rem;font-size:1.1rem"
                              aria-label="One more for ${escapeHtml(m.player_name)} on hole ${holeLabel(tournament, h)}">+</button>
                    </span>
                  `}
                </div>`;
              }).join("")}
              ${roster.length === 0 ? `<p class="text-xs muted-2">No players on this team yet — add them from the join screen or ask your organizer.</p>` : ""}
            </div>
          </div>`;
        continue;
      }

      holesHtml += `
        <div class="card flex items-center justify-between pl-3 pr-2.5 py-2"
             style="${entered ? "" : "background:#FCFDFC;"}">
          <div class="flex items-center gap-3">
            <span class="num-display" style="font-size:1.4rem;min-width:1.6rem;color:${entered ? "var(--ink)" : "var(--ink-3)"}">${holeLabel(tournament, h)}</span>
            <span class="eyebrow">Par ${par[h - 1]}</span>
          </div>
          ${isSigned ? `
            <div class="hole-mark ${holeMarkClass(scoreMap[h], par[h - 1])}">${val || "—"}</div>
          ` : `
            <div class="flex items-center gap-1.5">
              <button data-hole="${h}" data-delta="-1" class="step-btn" aria-label="One less on hole ${holeLabel(tournament, h)}">−</button>
              <input data-hole="${h}" type="number" inputmode="numeric" min="1" max="15" value="${val}"
                     class="step-value" aria-label="Strokes on hole ${holeLabel(tournament, h)}" placeholder="–" />
              <button data-hole="${h}" data-delta="1" class="step-btn" aria-label="One more on hole ${holeLabel(tournament, h)}">+</button>
            </div>
          `}
        </div>`;
    }

    app.innerHTML = `
      <section class="panel-dark px-5 pt-5 pb-4 mb-3">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="eyebrow on-dark mb-1">${escapeHtml(tournament.name)} · ${escapeHtml(formatOf(tournament).label)}</div>
            <h1 class="display truncate" style="font-size:1.9rem;color:#fff">${escapeHtml(team.name)}</h1>
          </div>
          ${team.join_code ? `<span class="pill on-dark shrink-0">${escapeHtml(team.join_code)}</span>` : ""}
        </div>

        <div class="grid grid-cols-3 gap-3 mt-4 pt-4" style="border-top:1px solid rgba(255,255,255,.09)">
          <div>
            <div class="to-par on-dark ${toParClass(toPar)}" style="font-size:2rem;display:block">${thru ? toParLabel(toPar) : "—"}</div>
            <div class="eyebrow on-dark mt-1">To par</div>
          </div>
          <div>
            <div class="num-display" style="font-size:2rem;color:#fff">${totalStrokes || "—"}</div>
            <div class="eyebrow on-dark mt-1">Strokes</div>
          </div>
          <div>
            <div class="num-display" style="font-size:2rem;color:#fff">${thru}<span style="font-size:1.1rem;color:rgba(255,255,255,.45)">/${tournament.num_holes}</span></div>
            <div class="eyebrow on-dark mt-1">Thru</div>
          </div>
        </div>

        ${(members || []).length ? `
          <p class="text-xs mt-3" style="color:rgba(255,255,255,.45)">${(members || []).map((m) => escapeHtml(m.player_name)).join(" · ")}</p>
        ` : ""}
      </section>

      ${isSigned ? `
        <div class="card p-3.5 mb-3 flex items-center gap-3" style="background:var(--grass-100);border-color:var(--grass-200)">
          <span class="shrink-0" style="color:var(--grass-700)">${icon("check", 20)}</span>
          <div>
            <div class="text-sm font-bold" style="color:var(--grass-700)">Signed by ${escapeHtml(team.signed_by)}</div>
            <div class="text-xs" style="color:var(--grass-600)">Card submitted — nice round.</div>
          </div>
        </div>
      ` : ""}

      <a href="#/leaderboard/${tournament.id}" class="btn-secondary w-full mb-5">
        ${icon("board", 17)} View live leaderboard
      </a>

      <div class="flex items-center gap-3 mb-2.5">
        <h2 class="eyebrow">${isSigned ? "Final scorecard" : "Enter scores"}</h2>
        <span class="flex-1 hairline"></span>
        ${!isSigned ? `<span class="eyebrow">${thru} of ${tournament.num_holes}</span>` : ""}
      </div>

      <div class="grid grid-cols-1 gap-2 mb-5">${holesHtml}</div>

      ${!isSigned ? `
        <button id="review-sign-btn" class="btn-green w-full" ${allEntered ? "" : "disabled"}>Review &amp; sign scorecard</button>
        ${!allEntered ? `<p class="text-xs muted-2 text-center mt-2.5">All ${tournament.num_holes} holes need a score before you can sign.</p>` : ""}
      ` : ""}
    `;

    if (!isSigned) {
      app.querySelectorAll("button.step-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const hole = parseInt(btn.dataset.hole, 10);
          const delta = parseInt(btn.dataset.delta, 10);
          const member = btn.dataset.member || null;
          const input = app.querySelector(
            member ? `input[data-hole="${hole}"][data-member="${member}"]` : `input[data-hole="${hole}"]:not([data-member])`);
          let current = parseInt(input.value, 10) || par[hole - 1];
          current = Math.max(1, current + delta);
          input.value = current;
          await saveScore(hole, current, member);
        });
      });
      app.querySelectorAll('input[data-hole]').forEach((input) => {
        input.addEventListener("change", async () => {
          const hole = parseInt(input.dataset.hole, 10);
          const val = parseInt(input.value, 10);
          if (!val || val < 1) return;
          await saveScore(hole, val, input.dataset.member || null);
        });
      });
      const reviewBtn = document.getElementById("review-sign-btn");
      if (reviewBtn && allEntered) {
        reviewBtn.addEventListener("click", () => { mode = "review"; render(); });
      }
    }
  }

  async function saveScore(hole, strokes, memberId) {
    // Gated on the team's own join code, so holding the public anon key is no
    // longer enough to rewrite somebody else's card.
    const entry = {
      p_team_code: team.join_code,
      p_hole: hole,
      p_strokes: strokes,
      p_member_id: memberId ?? null,
    };

    // Always attempt the write, even when the browser claims to be offline.
    // navigator.onLine is advisory and reads false inside the native WebView
    // often enough that trusting it kept scores on the phone permanently —
    // the app looked like it had saved and the leaderboard never moved.
    let error = null;
    try {
      ({ error } = await sb.rpc("player_set_score", entry));
    } catch (e) {
      error = e;
    }
    if (!error) return render();

    // Distinguish "no signal" from "the server said no": only the former is
    // worth retrying later.
    if (isConnectionError(error)) {
      queueScore(entry);
      toast("No signal — saved on your phone, will sync automatically");
      render();
    } else {
      // A rejection is never silent: this is the difference between a score
      // that is safe and one that has quietly gone nowhere.
      toast("Couldn't save score: " + (error.message || error), true);
    }
  }

  await render();

  realtimeChannel = sb
    .channel(`team-${teamId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "scores", filter: `team_id=eq.${teamId}` }, render)
    .subscribe();
}

// ---------- LEADERBOARD ----------

// The match screen: who is up, by how many, and the hole-by-hole story.
async function renderMatchBoard(tournament, teams) {
  const fmt = formatOf(tournament);
  const m = buildMatch(tournament, teams);
  const par = tournamentPar(tournament);

  // The code is shown to the people entitled to it and nobody else:
  //   - the organizer, who owns the match and reads it from the row
  //   - anyone already keeping score, who has it on their own device from
  //     when they joined, so no privileged read is needed to show it back
  // A passer-by opening a public match sees no code at all. join_code stays
  // ungranted to anon at the column level, so this is belt and braces.
  let shareCode = null;
  const mine = myTeams()[tournament.id];
  if (mine?.tournamentCode) shareCode = mine.tournamentCode;
  if (!shareCode) {
    const user = await getUser();
    if (user && tournament.created_by === user.id) shareCode = tournament.join_code || null;
  }

  const metaBits = [
    fmt.label,
    `${tournament.num_holes} holes`,
    tournament.course_name || null,
    tournament.tee_name ? `${tournament.tee_name} tees` : null,
  ].filter(Boolean);
  const head = `
    <div class="idband">
      <div class="idband-top">
        <div class="min-w-0">
          <div class="idname">${escapeHtml(tournament.name)}</div>
          <div class="idmeta">${metaBits.map(escapeHtml).join(" · ")}</div>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          ${betLabel(tournament) ? `<span class="pill bet">${escapeHtml(betLabel(tournament))}</span>` : ""}
          ${tournament.is_public === false ? `<span class="pill">PRIVATE</span>` : ""}
        </div>
      </div>
      ${shareCode ? `
        <div class="sharecode">
          <span class="sc-l">Join code</span>
          <span class="sc-v">${escapeHtml(shareCode)}</span>
          <button id="copy-code" class="sc-b" type="button">Copy</button>
        </div>` : ""}
    </div>`;

  if (m.incomplete) {
    return void (app.innerHTML = head + `
      <div class="panel p-8 text-center mt-3">
        <p class="text-sm muted">A match needs two sides. ${m.sides === 1 ? "One is" : "None are"} set up so far —
        share the join code and the second side can add themselves.</p>
        <p class="text-sm mt-3"><b>Code ${escapeHtml(tournament.join_code || "")}</b></p>
      </div>`);
  }

  const [A, B] = m.sides;
  const nameOf = (side) => side.players.length
    ? side.players.map((p) => p.name).join(" & ")
    : side.name;

  // Standing, stated the way it would be said out loud.
  const standing = m.up === 0
    ? (m.done ? "Match halved" : "All square")
    : `${escapeHtml(nameOf(m.leader))} ${m.done ? "wins" : "leads"} ${escapeHtml(m.label)}`;

  const sideCard = (side, idx) => {
    const ahead = (idx === 0 && m.up > 0) || (idx === 1 && m.up < 0);
    const behind = m.up !== 0 && !ahead;
    const won = m.done && ahead;
    return `
      <div class="matchside${ahead ? " ahead" : behind ? " behind" : ""}">
        <div class="ms-name">${escapeHtml(nameOf(side))}${won ? `<span class="wintag">Winner</span>` : ""}</div>
        ${(() => {
          if (!side.players.length) return "";
          // In singles the side name is the player's name, so repeating it
          // under itself says nothing — show the handicap alone there.
          if (side.players.length === 1) {
            return `<div class="ms-hcp">${handicapLabel(side.players[0].handicap) || "No handicap set"}</div>`;
          }
          return `<div class="ms-hcp">${side.players.map((p) =>
            `${escapeHtml(p.name)}${handicapShort(p.handicap)}`).join(" · ")}</div>`;
        })()}
      </div>`;
  };

  const playedHoles = m.holes.filter((h) => h.played);

  app.innerHTML = head + `
    <div class="matchhead">
      ${sideCard(A, 0)}
      <div class="ms-vs">vs</div>
      ${sideCard(B, 1)}
    </div>

    <div class="matchresult">
      <div class="mr-line">${standing}</div>
      <div class="mr-sub">${m.done
        ? (m.closedOnHole ? `Closed out on hole ${holeLabel(tournament, m.closedOnHole)}` : "All holes played")
        : `${m.played} of ${tournament.num_holes} played`}</div>
    </div>

    ${tournament.single_scorer && shareCode ? `
      <a href="#/score/${tournament.id}" class="btn-primary w-full mt-3">
        ${m.played ? "Keep scoring" : "Start scoring"}
      </a>` : ""}

    ${playedHoles.length ? `
      <div class="sectionbar mt-5"><span class="t">Scorecard</span><span class="rule"></span></div>
      ${(() => {
        // Laid out like every other card in the app: holes across the top, a
        // row per side, the running match under it. The tall two-column list
        // this replaces did not look like anything else here.
        const nums = m.holes.map((h) => h.hole);
        const cut = tournament.num_holes > 9 ? 9 : nums.length;
        const blocks = tournament.num_holes > 9 ? [nums.slice(0, 9), nums.slice(9)] : [nums];

        // Totals for any set of holes, for a side or for par.
        const sumFor = (holesList, idx) => {
          let gross = 0, net = 0, any = false;
          holesList.forEach((h) => {
            const r = m.holes.find((x) => x.hole === h);
            if (!r || !r.played) return;
            any = true;
            gross += idx === 0 ? r.grossA : r.grossB;
            net += idx === 0 ? r.netA : r.netB;
          });
          return { gross, net, any };
        };
        const cell = (t) => (!t.any ? "–"
          : `<span class="sg-g">${t.gross}</span>${t.gross !== t.net ? `<span class="sg-n">${t.net}</span>` : ""}`);
        const parSum = (holesList) => holesList.reduce((a, h) => a + (par[h - 1] || 0), 0);

        // The Match row is read from one side's point of view throughout.
        const refTag = sideTag(m.sides[0]);

        // Yardage and stroke index, when the course gave them. The stroke
        // index is what decides which holes a shot falls on, so a card that
        // shows the shots should show the order they were allocated in.
        const n2 = tournament.num_holes;
        const yds = Array.isArray(tournament.yardage) && tournament.yardage.length === n2
          ? tournament.yardage : null;
        const si = Array.isArray(tournament.handicap) && tournament.handicap.length === n2
          ? tournament.handicap : null;
        const ydsSum = (holesList) => holesList.reduce((a, h) => a + (yds?.[h - 1] || 0), 0);

        // "Out", "In", then the round — the columns a paper card carries.
        const grid = (block, label, blockLabel, withRound) => `
          <div class="cardwrap">
            ${label ? `<div class="cw-l">${label}</div>` : ""}
            <table class="sgrid">
              <tbody>
                <tr class="sg-head">
                  <th class="sg-rl">Hole</th>
                  ${block.map((h) => `<th>${holeLabel(tournament, h)}</th>`).join("")}
                  <th class="sg-tot">${blockLabel}</th>
                  ${withRound ? `<th class="sg-tot sg-round">Tot</th>` : ""}
                </tr>
                ${yds ? `
                  <tr class="sg-yds">
                    <th class="sg-rl">Yds</th>
                    ${block.map((h) => `<td>${yds[h - 1] ?? "–"}</td>`).join("")}
                    <td class="sg-tot">${ydsSum(block)}</td>
                    ${withRound ? `<td class="sg-tot sg-round">${ydsSum(nums)}</td>` : ""}
                  </tr>` : ""}
                <tr class="sg-par">
                  <th class="sg-rl">Par</th>
                  ${block.map((h) => `<td>${par[h - 1] ?? "–"}</td>`).join("")}
                  <td class="sg-tot">${parSum(block)}</td>
                  ${withRound ? `<td class="sg-tot sg-round">${parSum(nums)}</td>` : ""}
                </tr>
                ${si ? `
                  <tr class="sg-si">
                    <th class="sg-rl">Hcp</th>
                    ${block.map((h) => `<td>${si[h - 1] ?? "–"}</td>`).join("")}
                    <td class="sg-tot">–</td>
                    ${withRound ? `<td class="sg-tot sg-round">–</td>` : ""}
                  </tr>` : ""}
                ${[0, 1].map((idx) => `
                  <tr>
                    <th class="sg-rl sg-side">${escapeHtml(nameOf(m.sides[idx]))}</th>
                    ${block.map((h) => {
                      const row = m.holes.find((x) => x.hole === h);
                      if (!row || !row.played) return `<td class="sg-e">–</td>`;
                      const v = idx === 0 ? row.netA : row.netB;
                      const won = row.winner === idx;
                      const gross = idx === 0 ? row.grossA : row.grossB;
                      // The score made, marked against par the way the rest of
                      // the app marks it — birdies circled, bogeys squared —
                      // with what it counts as after shots beside it.
                      return `<td class="${won ? "sg-won" : ""}${row.dead ? " sg-dead" : ""}">
                                <span class="hole-mark hole-mark-sm ${holeMarkClass(gross, par[h - 1])}">${gross}</span>
                                ${gross !== v ? `<span class="sg-n">${v}</span>` : ""}
                              </td>`;
                    }).join("")}
                    <td class="sg-tot">${cell(sumFor(block, idx))}</td>
                    ${withRound ? `<td class="sg-tot sg-round">${cell(sumFor(nums, idx))}</td>` : ""}
                  </tr>`).join("")}
                <tr class="sg-run">
                  <th class="sg-rl">Match <span class="sg-ref">${escapeHtml(refTag)}</span></th>
                  ${block.map((h) => {
                    const row = m.holes.find((x) => x.hole === h);
                    if (!row || !row.played) return `<td>–</td>`;
                    if (row.dead) return `<td class="sg-dead">—</td>`;
                    const st = row.standing;
                    if (st === 0) return `<td>A/S</td>`;
                    // Name the side that is up. An arrow alone made the reader
                    // hold "up means the top row" in their head all the way
                    // down the card.
                    // One point of view for the whole row — the first side —
                    // so the arrow means up or down rather than which row is
                    // being named. Naming whichever side was ahead made "RL 1↓"
                    // read as RL being one down at the moment he was one up.
                    const up = st > 0;
                    return `<td class="sg-lead ${up ? "is-up" : "is-dn"}">
                              <span class="sg-who">${escapeHtml(refTag)}</span>
                              <span class="sg-up">${Math.abs(st)}${up ? "↑" : "↓"}</span>
                            </td>`;
                  }).join("")}
                  <td class="sg-tot">${m.label}</td>
                  ${withRound ? `<td class="sg-tot sg-round">${m.label}</td>` : ""}
                </tr>
              </tbody>
            </table>
          </div>`;

        const nines = blocks.map((b, i) => grid(
          b,
          blocks.length > 1 ? (i === 0 ? "Front" : "Back") : null,
          blocks.length > 1 ? (i === 0 ? "Out" : "In") : "Tot",
          blocks.length > 1 && i === blocks.length - 1,     // the round total sits on the last block
        )).join("");

        // The round total. The per-nine columns never added up to one, so the
        // question "what did I shoot?" had no answer on this card.
        const totals = [0, 1].map((idx) => {
          let gross = 0, net = 0, holesIn = 0;
          m.holes.forEach((r) => {
            if (!r.played) return;
            holesIn++;
            gross += idx === 0 ? r.grossA : r.grossB;
            net += idx === 0 ? r.netA : r.netB;
          });
          return { side: m.sides[idx], gross, net, holesIn };
        });
        const parPlayed = m.holes.reduce((a, r) => a + (r.played ? (par[r.hole - 1] || 0) : 0), 0);
        const rel = (v) => (v - parPlayed === 0 ? "E" : v - parPlayed > 0 ? `+${v - parPlayed}` : `${v - parPlayed}`);

        return nines + `
          <div class="sectionbar mt-4"><span class="t">Round total</span><span class="rule"></span></div>
          <table class="dtable">
            <thead>
              <tr>
                <th class="l">Player</th>
                <th class="rule" style="width:4.4rem">Gross</th>
                <th class="rule" style="width:4.4rem">Net</th>
                <th class="rule" style="width:4rem">To par</th>
              </tr>
            </thead>
            <tbody>
              ${totals.map((t) => `
                <tr>
                  <td class="l"><div class="nm">${escapeHtml(nameOf(t.side))}</div></td>
                  <td class="rule num">${t.gross || "–"}</td>
                  <td class="rule num">${t.gross === t.net ? "–" : t.net}</td>
                  <td class="rule"><span class="chip ${t.gross - parPlayed < 0 ? "under" : "even"}">${t.gross ? rel(t.gross) : "–"}</span></td>
                </tr>`).join("")}
            </tbody>
          </table>
          <p class="text-xs muted-2 mt-2 text-center">
            Every hole played, including any after the match was won.
            To par is on the gross score${totals[0].holesIn < tournament.num_holes
              ? ` over the ${totals[0].holesIn} holes scored so far` : ""}.
          </p>`;
      })()}
      <p class="text-xs muted-2 mt-2 text-center">
        Circled is a birdie, squared a bogey. The small red number is what the score counts as after shots.
        The Match row is ${escapeHtml(nameOf(A))}'s point of view — <b>${escapeHtml(sideTag(A))}</b> ↑ is
        ${escapeHtml(nameOf(A))} up, <b>${escapeHtml(sideTag(A))}</b> ↓ is ${escapeHtml(nameOf(A))} down.
        ${m.closedOnHole ? `Holes after ${holeLabel(tournament, m.closedOnHole)} are shown but didn't count — the match was already won.` : ""}
      </p>
    ` : `<p class="text-sm muted text-center p-6">No holes scored yet.</p>`}
  `;

  const copyBtn = document.getElementById("copy-code");
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(shareCode);
        toast("Code copied");
      } catch {
        // Clipboard is blocked in some embedded browsers; the code is on
        // screen either way, so say so rather than failing silently.
        toast("Couldn't copy — the code is on screen", true);
      }
    });
  }
}

async function viewLeaderboard(tournamentId) {
  app.innerHTML = loadingHtml();

  const { data: tournament, error } = await sb.from("tournaments").select(TOURNAMENT_COLS).eq("id", tournamentId).single();
  if (error || !tournament) {
    app.innerHTML = notFoundHtml("Tournament");
    return;
  }
  const par = tournamentPar(tournament);

  async function render() {
    const { data: teams } = await sb
      .from("teams")
      .select("id, name, signed_at, team_members(id, player_name, handicap), scores(hole_number, strokes, team_member_id)")
      .eq("tournament_id", tournamentId);

    const fmt = formatOf(tournament);

    // A match is not a leaderboard — it is one result between two sides — so
    // it gets its own screen rather than a table of two rows.
    if (fmt.match) return void (await renderMatchBoard(tournament, teams));

    const rows = buildLeaderboard(tournament, teams);
    // Every card signed means the round is over, even if nobody closed it —
    // and so does scoring that stopped days ago.
    const state = tournamentState(tournament, teams);
    const finished = state !== "live";
    const isLive = !finished;
    const pot = fmt.metric === "skins" ? skinsPayout(tournament, rows) : null;

    // No status pill in the header: the identity band below states it, and
    // saying FINAL twice on one screen is how a layout starts looking padded.

    const metaBits = [
      fmt.label,
      `${tournament.num_holes} holes`,
      tournament.course_name || null,
    ].filter(Boolean);

    const scoreHead = fmt.metric === "points" ? "Pts" : fmt.metric === "skins" ? "Skins" : "Score";

    app.innerHTML = `
      <div class="idband">
        <div class="idband-top">
          <div class="idband-meta">
            <div class="flex items-center gap-1.5">
              ${state === "live"
                ? `<span class="pill live"><span class="dot"></span>LIVE</span>`
                : `<span class="pill on-dark">${state === "unfinished" ? "UNFINISHED" : "FINAL"}</span>`}
            </div>
            <div class="idname">${escapeHtml(tournament.name)}</div>
            <div class="idsub">${escapeHtml(metaBits.join(" · "))}</div>
          </div>
        </div>
        <div class="tabs">
          <span class="tab is-on">${fmt.ranks === "player" ? "Players" : "Teams"}</span>
          <a href="#/tournaments" class="tab">All rounds</a>
        </div>
      </div>

      ${pot && pot.buyIn > 0 ? `
        <div class="panel p-4 mt-3">
          <div class="flex items-center justify-between mb-2.5">
            <span class="eyebrow">Skins pot</span>
            <span class="text-xs muted-2">${money(pot.buyIn)} × ${pot.entrants} player${pot.entrants === 1 ? "" : "s"}</span>
          </div>
          <div class="flex gap-7">
            <div>
              <div class="num-display" style="font-size:1.5rem">${money(pot.pot)}</div>
              <div class="eyebrow mt-0.5">In the pot</div>
            </div>
            <div>
              <div class="num-display" style="font-size:1.5rem">${pot.skinsWon}</div>
              <div class="eyebrow mt-0.5">Skins won</div>
            </div>
            <div>
              <div class="num-display" style="font-size:1.5rem;color:var(--grass-700)">
                ${pot.skinsWon ? money(pot.perSkin) : "—"}
              </div>
              <div class="eyebrow mt-0.5">Per skin</div>
            </div>
          </div>
          ${!pot.skinsWon ? `<p class="text-xs muted-2 mt-2.5">Every hole halved so far — the pot keeps carrying.</p>` : ""}
        </div>` : ""}

      ${rows.length === 0 ? `
        <div class="panel p-8 text-center mt-3">
          <p class="font-semibold mb-1">No teams yet</p>
          <p class="text-sm muted">Players join with the code from the organizer.</p>
        </div>` : `
        <div class="panel mt-3">
          <table class="dtable">
            <thead>
              <tr>
                <th class="l" style="width:2.4rem">#</th>
                <th class="l">${fmt.ranks === "player" ? "Player" : "Team"}</th>
                <th class="rule" style="width:4.2rem">${scoreHead}</th>
                <th class="rule" style="width:3.6rem">Thru</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map((r) => {
                const leading = r.place === 1 && r.thru > 0;
                const sub = r.players.length
                  ? r.players.join(" · ")
                  : r.teamName
                    ? `${r.teamName}${r.handicap != null ? ` · hcp ${r.handicap}` : ""}`
                    : "";
                let chip;
                if (!r.thru) chip = `<span class="chip none">—</span>`;
                else if (fmt.metric === "points") chip = `<span class="chip">${r.points}</span>`;
                else if (fmt.metric === "skins") chip = `<span class="chip ${r.skins ? "" : "none"}">${r.skins}</span>`;
                else chip = `<span class="chip ${r.toPar < 0 ? "under" : r.toPar === 0 ? "even" : "over"}">${toParLabel(r.toPar)}</span>`;
                return `
                <tr class="tap" onclick="location.hash='#/scorecard/${r.teamId || r.id}'">
                  <td class="l pos">${r.tied ? "T" : ""}${r.place}</td>
                  <td class="l" style="max-width:0">
                    <div class="nm truncate">${escapeHtml(r.name)}${r.signed ? ` <span class="fin-badge" title="Card signed">F</span>` : ""}</div>
                    ${sub ? `<div class="sub truncate">${escapeHtml(sub)}</div>` : ""}
                  </td>
                  <td class="rule">${chip}${
                    fmt.metric === "skins" && pot && pot.perSkin && r.skins
                      ? `<div class="sub" style="color:var(--grass-700)">${money(r.skins * pot.perSkin)}</div>` : ""}</td>
                  <td class="rule num" style="color:var(--ink-2)">
                    ${r.thru || "–"}<span style="color:var(--ink-3);font-size:.75rem">/${tournament.num_holes}</span>
                  </td>
                </tr>`;
              }).join("")}
            </tbody>
          </table>
        </div>`}

      <p class="text-center text-xs muted-2 mt-3">
        ${state === "live" ? "Updating live as scores come in"
          : state === "unfinished" ? "Scoring stopped — cards were never signed"
          : state === "never_started" ? "No scores were entered"
          : "Tournament completed"}
        ${rows.length ? "&nbsp;·&nbsp; tap a row for the card" : ""}
      </p>
    `;
  }

  await render();

  realtimeChannel = sb
    .channel(`leaderboard-${tournamentId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "scores" }, render)
    .on("postgres_changes", { event: "*", schema: "public", table: "teams" }, render)
    .subscribe();

  // fallback poll in case realtime drops on flaky course wifi
  const pollId = setInterval(render, 15000);
  const stop = () => { clearInterval(pollId); window.removeEventListener("hashchange", stop); };
  window.addEventListener("hashchange", stop, { once: true });
}

// ---------- READ-ONLY SCORECARD (from the leaderboard's "View scorecard") ----------

async function viewScorecard(teamId) {
  app.innerHTML = loadingHtml();

  const { data: team, error } = await sb
    .from("teams")
    .select(`*, tournaments(${TOURNAMENT_COLS_EMBED}), team_members(player_name)`)
    .eq("id", teamId)
    .single();
  if (error || !team) {
    app.innerHTML = notFoundHtml("Team");
    return;
  }
  const tournament = team.tournaments;
  const par = tournament.par && tournament.par.length === tournament.num_holes ? tournament.par : Array(tournament.num_holes).fill(4);

  async function render() {
    const { data: scores } = await sb.from("scores").select("hole_number, strokes, team_member_id").eq("team_id", teamId);
    const scoreMap = {};
    (scores || []).forEach((s) => (scoreMap[s.hole_number] = s.strokes));

    let totalStrokes = 0, totalPar = 0, thru = 0;
    for (let h = 1; h <= tournament.num_holes; h++) {
      if (scoreMap[h] != null) {
        totalStrokes += scoreMap[h];
        totalPar += par[h - 1];
        thru++;
      }
    }
    const toPar = totalStrokes - totalPar;

    app.innerHTML = `
      <section class="panel-dark px-5 pt-5 pb-4 mb-3">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="eyebrow on-dark mb-1">${escapeHtml(tournament.name)}</div>
            <h1 class="display truncate" style="font-size:1.9rem;color:#fff">${escapeHtml(team.name)}</h1>
          </div>
          ${team.signed_at ? `<span class="pill on-dark shrink-0">Signed</span>` : ""}
        </div>

        <div class="grid grid-cols-3 gap-3 mt-4 pt-4" style="border-top:1px solid rgba(255,255,255,.09)">
          <div>
            <div class="to-par on-dark ${toParClass(toPar)}" style="font-size:2rem;display:block">${thru ? toParLabel(toPar) : "—"}</div>
            <div class="eyebrow on-dark mt-1">To par</div>
          </div>
          <div>
            <div class="num-display" style="font-size:2rem;color:#fff">${totalStrokes || "—"}</div>
            <div class="eyebrow on-dark mt-1">Strokes</div>
          </div>
          <div>
            <div class="num-display" style="font-size:2rem;color:#fff">${thru}<span style="font-size:1.1rem;color:rgba(255,255,255,.45)">/${tournament.num_holes}</span></div>
            <div class="eyebrow on-dark mt-1">Thru</div>
          </div>
        </div>

        ${(team.team_members || []).length ? `
          <p class="text-xs mt-3" style="color:rgba(255,255,255,.45)">${(team.team_members || []).map((m) => escapeHtml(m.player_name)).join(" · ")}</p>
        ` : ""}
      </section>

      ${team.signed_at ? `
        <div class="card p-3.5 mb-3 flex items-center gap-3" style="background:var(--grass-100);border-color:var(--grass-200)">
          <span class="shrink-0" style="color:var(--grass-700)">${icon("check", 20)}</span>
          <div class="text-sm font-bold" style="color:var(--grass-700)">Signed by ${escapeHtml(team.signed_by || "")}</div>
        </div>
      ` : ""}

      <div class="flex items-center gap-3 mb-2.5">
        <h2 class="eyebrow">Scorecard</h2>
        <span class="flex-1 hairline"></span>
      </div>

      <div class="card overflow-hidden mb-3">
        ${scorecardGridHtml(par, scoreMap, tournament.start_hole || 1, tournament.yardage, tournament.handicap)}
      </div>

      <a href="#/leaderboard/${tournament.id}" class="btn-secondary w-full mt-5">${icon("board", 17)} Back to leaderboard</a>
    `;
  }

  await render();

  realtimeChannel = sb
    .channel(`scorecard-${teamId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "scores", filter: `team_id=eq.${teamId}` }, render)
    .subscribe();
}
