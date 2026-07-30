// TeeBoard app logic. Plain JS, no build step. Talks directly to Supabase.

const CFG = window.TEEBOARD_CONFIG || {};
const CONFIGURED = CFG.SUPABASE_URL && !CFG.SUPABASE_URL.includes("YOUR_SUPABASE_URL_HERE");
const sb = CONFIGURED ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY) : null;

const app = document.getElementById("app");
const headerSub = document.getElementById("header-sub");

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
function scorecardGridHtml(par, scoreMap) {
  const nines = [];
  for (let i = 0; i < par.length; i += 9) nines.push({ start: i, pars: par.slice(i, i + 9) });

  const totalLabel = (idx) => (par.length <= 9 ? "TOT" : idx === 0 ? "OUT" : idx === 1 ? "IN" : "TOT");

  const blocks = nines.map((nine, idx) => {
    const holeNums = nine.pars.map((_, j) => nine.start + j + 1);
    const parSum = nine.pars.reduce((a, b) => a + b, 0);
    const played = holeNums.filter((h) => scoreMap[h] != null);
    const scoreSum = played.reduce((a, h) => a + scoreMap[h], 0);

    return `
      <table class="card-grid">
        <thead>
          <tr>
            <th class="lbl" style="width:2.7rem">Hole</th>
            ${holeNums.map((h) => `<th>${h}</th>`).join("")}
            <th class="tot" style="width:2.4rem">${totalLabel(idx)}</th>
          </tr>
        </thead>
        <tbody>
          <tr class="par-row">
            <td class="lbl">Par</td>
            ${nine.pars.map((p) => `<td>${p}</td>`).join("")}
            <td class="tot">${parSum}</td>
          </tr>
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
// track tournaments I created (admin quick access)
function myTournaments() { return load("bb_my_tournaments", []); }
function saveMyTournament(t) {
  const list = myTournaments().filter((x) => x.id !== t.id);
  list.unshift(t);
  store("bb_my_tournaments", list.slice(0, 10));
}
function removeMyTournament(id) {
  store("bb_my_tournaments", myTournaments().filter((x) => x.id !== id));
}

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
  const initial = escapeHtml(user.email.charAt(0).toUpperCase());
  el.innerHTML = `
    <div class="relative">
      <button id="profile-btn" aria-label="Account menu"
        class="w-8 h-8 rounded-lg text-white font-bold text-sm flex items-center justify-center"
        style="background:var(--grass-600);border:1px solid rgba(255,255,255,.15);">${initial}</button>
      <div id="profile-menu" class="hidden absolute right-0 mt-2 w-60 card p-3 z-40">
        <div class="eyebrow mb-1">Signed in as</div>
        <div class="text-sm font-semibold mb-3 break-all">${escapeHtml(user.email)}</div>
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
  { re: /^#\/create$/, view: viewCreate },
  // Wrapped so the regex match array isn't passed in as prefillCode — bare
  // `view: viewJoin` handed it the match ("#/join"), which pre-filled the code
  // box with that string and auto-fired a doomed lookup on arrival.
  { re: /^#\/join$/, view: () => viewJoin() },
  { re: /^#\/join\/([A-Za-z0-9]+)$/, view: (m) => viewJoin(m[1]) },
  { re: /^#\/admin\/([0-9a-fA-F-]+)$/, view: (m) => viewAdmin(m[1]) },
  { re: /^#\/team\/([0-9a-fA-F-]+)$/, view: (m) => viewTeam(m[1]) },
  { re: /^#\/leaderboard\/([0-9a-fA-F-]+)$/, view: (m) => viewLeaderboard(m[1]) },
  { re: /^#\/scorecard\/([0-9a-fA-F-]+)$/, view: (m) => viewScorecard(m[1]) },
];

function route() {
  clearRealtime();
  headerSub.innerHTML = "";
  renderHeaderProfile();
  const hash = location.hash || "#/";
  for (const r of routes) {
    const m = hash.match(r.re);
    if (m) return r.view(m);
  }
  viewHome();
}

window.addEventListener("hashchange", route);
window.addEventListener("DOMContentLoaded", () => {
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
  route();
});

// ---------- HOME ----------

async function viewHome() {
  app.innerHTML = loadingHtml();

  const user = await getUser();
  const teams = myTeams();
  const teamEntries = Object.entries(teams);

  let owned = [];
  let legacy = [];
  if (user) {
    const { data } = await sb
      .from("tournaments")
      .select("id, name, join_code")
      .eq("created_by", user.id)
      .order("created_at", { ascending: false });
    owned = data || [];
    // tournaments created on this browser before accounts existed (created_by is null
    // for those). Only surfaced while signed in — otherwise a signed-out visitor on a
    // browser that once created a tournament would still see a management list.
    legacy = myTournaments().filter((t) => !owned.some((o) => o.id === t.id));
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
    <section class="panel-dark px-5 pt-6 pb-6 mb-2.5">
      <div class="eyebrow on-dark mb-3">Live scramble scoring</div>
      <h1 class="wordmark on-dark" style="font-size:3.2rem">
        <span class="wm-tee">TEE</span><span class="wm-board">BOARD</span>
      </h1>
      <p class="mt-3 text-[15px]" style="color:rgba(255,255,255,.6);max-width:21rem">
        One shared card per team. Every phone updates the second a score goes in.
      </p>
    </section>

    <div class="grid grid-cols-1 gap-2.5 mb-2">
      <a href="#/join" class="row-link">
        <span class="icon-tile">${icon("flag", 22)}</span>
        <div class="min-w-0 flex-1">
          <div class="font-bold">Join a tournament</div>
          <div class="text-sm muted">Got a code? Score for your team.</div>
        </div>
        <span class="muted-2 shrink-0">${icon("arrow", 18)}</span>
      </a>
      <a href="#/create" class="row-link">
        <span class="icon-tile">${icon("trophy", 22)}</span>
        <div class="min-w-0 flex-1">
          <div class="font-bold">Create a tournament</div>
          <div class="text-sm muted">Set up tonight's scramble, get a code.</div>
        </div>
        <span class="muted-2 shrink-0">${icon("arrow", 18)}</span>
      </a>
    </div>

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

    ${(owned.length || legacy.length) ? `
      <div class="flex items-center gap-3 mt-7 mb-2.5">
        <h2 class="eyebrow">Tournaments I created</h2>
        <div class="flex-1 hairline"></div>
      </div>
      <div class="grid grid-cols-1 gap-2">
        ${owned.map((t) => listRow(
          `#/admin/${t.id}`, escapeHtml(t.name), `Code ${escapeHtml(t.join_code)}`, "Manage",
        )).join("")}
        ${legacy.map((t) => listRow(
          `#/admin/${t.id}`, escapeHtml(t.name), `Code ${escapeHtml(t.code)}`, "Manage",
        )).join("")}
      </div>
    ` : ""}
  `;
}

// ---------- CREATE TOURNAMENT ----------

const COURSE_SEARCH_URL = "https://api.opengolfapi.org/v1/courses/search?q=";
const COURSE_DETAIL_URL = "https://api.opengolfapi.org/v1/courses/";

async function viewCreate() {
  app.innerHTML = loadingHtml();
  const user = await getUser();
  if (!user) return renderAuthGate();
  renderCreateForm(user);
}

function renderAuthGate() {
  // Default to Sign Up: most people hitting this gate are brand new
  // organizers who don't have an account yet. Returning organizers can
  // still tap "Sign In".
  let mode = "signup";

  function draw() {
    app.innerHTML = `
      <div class="mb-4">
        <div class="eyebrow mb-1">Organizer</div>
        <h1 class="text-2xl">Create a tournament</h1>
      </div>

      <div class="card p-3 mb-3 flex items-start gap-3" style="background:var(--grass-100);border-color:var(--grass-200)">
        <span class="shrink-0 mt-0.5" style="color:var(--grass-700)">${icon("lock", 18)}</span>
        <p class="text-sm" style="color:var(--grass-700)">
          Organizers need a free account so only you can manage what you create.
          <b>Players never sign up</b> — they just use the join code.
        </p>
      </div>

      <div class="card p-5">
        <div class="flex gap-2 mb-5 p-1 rounded-xl" style="background:var(--paper)">
          <button id="tab-signup" class="flex-1 py-2 rounded-lg text-sm font-bold transition"
            style="${mode === "signup" ? "background:var(--surface);box-shadow:0 1px 3px rgba(8,17,12,.12)" : "color:var(--ink-2)"}">Sign up</button>
          <button id="tab-signin" class="flex-1 py-2 rounded-lg text-sm font-bold transition"
            style="${mode === "signin" ? "background:var(--surface);box-shadow:0 1px 3px rgba(8,17,12,.12)" : "color:var(--ink-2)"}">Sign in</button>
        </div>
        <label class="field-label">Email</label>
        <input id="auth-email" type="email" placeholder="you@email.com" class="mb-4" />
        <label class="field-label">Password</label>
        <input id="auth-password" type="password" placeholder="At least 6 characters" class="mb-4" />
        <button id="auth-submit" class="btn-primary w-full">${mode === "signup" ? "Create account" : "Sign in"}</button>
        <div id="auth-status" class="text-xs mt-3"></div>
      </div>
    `;

    document.getElementById("tab-signin").addEventListener("click", () => { mode = "signin"; draw(); });
    document.getElementById("tab-signup").addEventListener("click", () => { mode = "signup"; draw(); });

    document.getElementById("auth-submit").addEventListener("click", async () => {
      const email = document.getElementById("auth-email").value.trim();
      const password = document.getElementById("auth-password").value;
      const statusEl = document.getElementById("auth-status");
      const btn = document.getElementById("auth-submit");

      if (!email || !password) {
        statusEl.className = "text-xs mt-3 status-err";
        statusEl.textContent = "Enter an email and password.";
        return;
      }

      btn.disabled = true;
      statusEl.className = "text-xs mt-3 status-info";
      statusEl.textContent = mode === "signup" ? "Creating account…" : "Signing in…";

      if (mode === "signup") {
        const { data, error } = await sb.auth.signUp({ email, password });
        btn.disabled = false;
        if (error) {
          statusEl.className = "text-xs mt-3 status-err";
          statusEl.textContent = error.message;
          return;
        }
        if (data.session) { renderHeaderProfile(); return viewCreate(); }
        // Project has "confirm email" turned on — no session until they click the email link.
        mode = "signin";
        draw();
        const s = document.getElementById("auth-status");
        s.className = "text-xs mt-3 status-ok";
        s.textContent = "Account created — check your email to confirm it, then sign in here.";
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        btn.disabled = false;
        if (error) {
          statusEl.className = "text-xs mt-3 status-err";
          statusEl.textContent = error.message;
          return;
        }
        renderHeaderProfile();
        viewCreate();
      }
    });
  }

  draw();
}

function renderCreateForm(user) {
  app.innerHTML = `
    <div class="mb-4">
      <div class="eyebrow mb-1">Organizer · ${escapeHtml(user.email)}</div>
      <h1 class="text-2xl">Create a tournament</h1>
    </div>
    <form id="create-form" class="card p-5 flex flex-col gap-5">
      <div>
        <label class="field-label">Tournament name</label>
        <input name="name" required placeholder="Thursday Night Scramble" />
      </div>
      <div class="relative">
        <label class="field-label">Course</label>
        <input id="course-input" name="course" placeholder="Search your course… e.g. Pine Valley" autocomplete="off" />
        <div id="course-results" class="hidden absolute z-20 left-0 right-0 mt-1 card max-h-64 overflow-y-auto"></div>
        <p id="course-attribution" class="text-xs muted-2 mt-1.5 leading-relaxed">Pulls real hole-by-hole par from <a href="https://opengolfapi.org" target="_blank" class="link-underline">OpenGolfAPI</a> (free &amp; open, ODbL). Not listed? No problem — every hole defaults to par 4.</p>
        <p id="course-selected-note" class="hidden text-xs font-semibold mt-2 p-2 rounded-lg" style="color:var(--grass-700);background:var(--grass-100)"></p>
      </div>
      <div>
        <label class="field-label">Holes</label>
        <select id="holes-select" name="holes">
          <option value="18">18 holes</option>
          <option value="9">9 holes</option>
        </select>
      </div>
      <div id="nine-wrap" class="hidden">
        <label class="field-label">Which nine?</label>
        <select id="nine-select" name="nine">
          <option value="front">Front nine (holes 1–9)</option>
          <option value="back">Back nine (holes 10–18)</option>
        </select>
      </div>
      <button class="btn-primary w-full" type="submit">Create &amp; get code</button>
    </form>
  `;

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
    selectedNote.innerHTML = `Using ${escapeHtml(name)}'s ${escapeHtml(label)}, par ${totalPar}.${siteLink}${escapeHtml(mismatchWarning)}`;
    selectedNote.classList.remove("hidden");
  }

  function clearSelection() {
    selectedNote.classList.add("hidden");
    selectedNote.textContent = "";
    courseScorecard = null;
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
    const name = fd.get("name").trim();
    const course = fd.get("course").trim();
    const numHoles = parseInt(fd.get("holes"), 10);
    const par = getCurrentPar();

    const btn = e.target.querySelector("button");
    btn.disabled = true;
    btn.textContent = "Creating…";

    let tournament = null;
    for (let attempt = 0; attempt < 6 && !tournament; attempt++) {
      const code = genCode(5);
      const { data, error } = await sb
        .from("tournaments")
        .insert({ name, course_name: course || null, join_code: code, num_holes: numHoles, par, created_by: user.id })
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
    saveMyTournament({ id: tournament.id, name: tournament.name, code: tournament.join_code });
    location.hash = `#/admin/${tournament.id}`;
  });
}

// ---------- ADMIN VIEW ----------

async function viewAdmin(tournamentId) {
  app.innerHTML = loadingHtml();

  const [{ data: tournament, error }, user] = await Promise.all([
    sb.from("tournaments").select("*").eq("id", tournamentId).single(),
    getUser(),
  ]);
  if (error || !tournament) {
    app.innerHTML = notFoundHtml("Tournament");
    return;
  }
  // Tournaments created before accounts existed have no owner — anyone with the
  // admin link can still manage those, same as before. Newer ones are owner-only
  // (also enforced by RLS on the database side).
  const isOwner = !tournament.created_by || (user && tournament.created_by === user.id);
  saveMyTournament({ id: tournament.id, name: tournament.name, code: tournament.join_code });

  // Which teams currently have their "manage" panel open — kept outside
  // render() so it survives re-renders (e.g. after adding another player,
  // the panel you were working in stays open for the next one).
  const expandedTeams = new Set();

  async function render() {
    const { data: teams } = await sb
      .from("teams")
      .select("id, name, join_code, signed_at, signed_by, team_members(id, player_name), scores(hole_number)")
      .eq("tournament_id", tournamentId)
      .order("created_at", { ascending: true });

    const joinUrl = shareLink(`/join/${tournament.join_code}`);

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
          <input id="add-player-name" placeholder="Player name" class="mb-4" />
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
          <h2 class="eyebrow">Settings</h2>
          <span class="flex-1 hairline"></span>
        </div>

        <button id="toggle-status" class="btn-secondary w-full mb-2.5">${isActive ? "Close tournament" : "Reopen tournament"}</button>

        <div class="card p-5" style="border-color:#F1CFD0">
          <h3 class="eyebrow mb-2" style="color:var(--under)">Danger zone</h3>
          <p class="text-xs muted mb-4">Deleting removes every team, player, and score in this tournament. It can't be undone.</p>
          <button id="delete-tournament-btn" class="btn-danger w-full">Delete tournament</button>
          <div id="delete-confirm-wrap" class="hidden mt-4 pt-4" style="border-top:1px solid var(--line)">
            <label class="field-label">Type <b style="color:var(--ink)">${escapeHtml(tournament.name)}</b> to confirm</label>
            <input id="delete-confirm-input" placeholder="${escapeHtml(tournament.name)}" class="mb-3" />
            <button id="delete-confirm-btn" class="btn-danger-solid">Permanently delete</button>
          </div>
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

    if (isOwner) {
      document.getElementById("delete-tournament-btn").addEventListener("click", () => {
        document.getElementById("delete-confirm-wrap").classList.toggle("hidden");
      });
      document.getElementById("delete-confirm-btn").addEventListener("click", async () => {
        const val = document.getElementById("delete-confirm-input").value.trim();
        if (val !== tournament.name) return toast("Type the tournament name exactly to confirm", true);
        const btn = document.getElementById("delete-confirm-btn");
        btn.disabled = true;
        btn.textContent = "Deleting…";
        const { error } = await sb.from("tournaments").delete().eq("id", tournament.id);
        if (error) {
          toast("Couldn't delete: " + error.message, true);
          btn.disabled = false;
          btn.textContent = "Permanently delete";
          return;
        }
        removeMyTournament(tournament.id);
        toast("Tournament deleted");
        location.hash = "#/";
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
        const statusEl = document.getElementById("add-player-status");
        const btn = document.getElementById("add-player-btn");

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

        const result = await addPlayerManually(teamChoice, newTeamName, playerName);

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
          const { error } = await sb.from("teams").update({ name: newName }).eq("id", id);
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
          const { error } = await sb.from("team_members").delete().eq("id", id);
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
          const { error } = await sb.from("teams").update({ signed_at: null, signed_by: null }).eq("id", id);
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
          const { error } = await sb.from("team_members").insert({ team_id: id, player_name: playerName });
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
  async function addPlayerManually(teamChoice, newTeamName, playerName) {
    let teamId = teamChoice;
    if (teamChoice === "__new") {
      let created = null;
      for (let attempt = 0; attempt < 6 && !created; attempt++) {
        const code = genCode(4);
        const { data, error: teamErr } = await sb
          .from("teams")
          .insert({ tournament_id: tournamentId, name: newTeamName, join_code: code })
          .select()
          .single();
        if (data) created = data;
        else if (teamErr && teamErr.code !== "23505") return { error: teamErr.message };
      }
      if (!created) return { error: "Couldn't create team, try again." };
      teamId = created.id;
    }
    const { error: memberErr } = await sb.from("team_members").insert({ team_id: teamId, player_name: playerName });
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
            let created = null;
            for (let attempt = 0; attempt < 6 && !created; attempt++) {
              const code = genCode(4);
              const { data, error: teamErr } = await sb
                .from("teams")
                .insert({ tournament_id: tournamentId, name: group.name, join_code: code })
                .select()
                .single();
              if (data) created = data;
              else if (teamErr && teamErr.code !== "23505") {
                statusEl.textContent = `Error creating team "${group.name}": ${teamErr.message}`;
                return;
              }
            }
            if (!created) {
              statusEl.textContent = `Couldn't create team "${group.name}" — try again.`;
              return;
            }
            team = { id: created.id, name: created.name };
            existingPlayerNames = [];
            teamsCreated++;
          }

          for (const playerName of group.players) {
            if (existingPlayerNames.includes(playerName.trim().toLowerCase())) continue;
            const { error: memberErr } = await sb.from("team_members").insert({ team_id: team.id, player_name: playerName });
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
    const { data: tournament, error } = await sb.from("tournaments").select("*").eq("join_code", code).maybeSingle();
    btn.disabled = false;
    btn.textContent = "Find tournament";
    if (error || !tournament) {
      toast("No tournament found with that code", true);
      return;
    }
    if (tournament.status !== "active") {
      toast("That tournament is closed", true);
      return;
    }
    renderTeamStep(tournament);
  });

  if (prefillCode) {
    document.getElementById("code-form").requestSubmit();
  }
}

async function renderTeamStep(tournament) {
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

  const { data: rosterData } = await sb
    .from("team_members")
    .select("id, player_name, team_id, teams!inner(id, name, join_code, tournament_id)")
    .eq("teams.tournament_id", tournament.id);
  roster = rosterData || [];
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

      let team = null;
      for (let attempt = 0; attempt < 6 && !team; attempt++) {
        const code = genCode(4);
        const { data, error } = await sb
          .from("teams")
          .insert({ tournament_id: tournament.id, name: teamName, join_code: code })
          .select()
          .single();
        if (data) team = data;
        else if (error && error.code !== "23505") return toast("Error: " + error.message, true);
      }
      if (!team) return toast("Couldn't create team, try again", true);

      await sb.from("team_members").insert({ team_id: team.id, player_name: playerName });
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

      const { data: team, error } = await sb
        .from("teams")
        .select("*")
        .eq("tournament_id", tournament.id)
        .eq("join_code", teamCode)
        .maybeSingle();
      if (error || !team) return toast("No team found with that code", true);

      await sb.from("team_members").insert({ team_id: team.id, player_name: playerName });
      saveMyTeam(tournament.id, { teamId: team.id, teamName: team.name, teamCode: team.join_code, tournamentCode: tournament.join_code });
      location.hash = `#/team/${team.id}`;
    });
  });
}

// ---------- SCORECARD ----------

async function viewTeam(teamId) {
  app.innerHTML = loadingHtml();

  const { data: team, error: teamErr } = await sb.from("teams").select("*, tournaments(*)").eq("id", teamId).single();
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
    const { data: members } = await sb.from("team_members").select("player_name").eq("team_id", teamId);
    const { data: scores } = await sb.from("scores").select("hole_number, strokes").eq("team_id", teamId);
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
          ${scorecardGridHtml(par, scoreMap)}
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
        const { error } = await sb.from("teams").update({ signed_at: signedAt, signed_by: name }).eq("id", teamId);
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
      ? `<div class="card overflow-hidden">${scorecardGridHtml(par, scoreMap)}</div>`
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
      holesHtml += `
        <div class="card flex items-center justify-between pl-3 pr-2.5 py-2"
             style="${entered ? "" : "background:#FCFDFC;"}">
          <div class="flex items-center gap-3">
            <span class="num-display" style="font-size:1.4rem;width:1.6rem;color:${entered ? "var(--ink)" : "var(--ink-3)"}">${h}</span>
            <span class="eyebrow">Par ${par[h - 1]}</span>
          </div>
          ${isSigned ? `
            <div class="hole-mark ${holeMarkClass(scoreMap[h], par[h - 1])}">${val || "—"}</div>
          ` : `
            <div class="flex items-center gap-1.5">
              <button data-hole="${h}" data-delta="-1" class="step-btn" aria-label="One less on hole ${h}">−</button>
              <input data-hole="${h}" type="number" inputmode="numeric" min="1" max="15" value="${val}"
                     class="step-value" aria-label="Strokes on hole ${h}" placeholder="–" />
              <button data-hole="${h}" data-delta="1" class="step-btn" aria-label="One more on hole ${h}">+</button>
            </div>
          `}
        </div>`;
    }

    app.innerHTML = `
      <section class="panel-dark px-5 pt-5 pb-4 mb-3">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="eyebrow on-dark mb-1">${escapeHtml(tournament.name)}</div>
            <h1 class="display truncate" style="font-size:1.9rem;color:#fff">${escapeHtml(team.name)}</h1>
          </div>
          <span class="pill on-dark shrink-0">${escapeHtml(team.join_code)}</span>
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

      ${isSigned ? `
        <p class="text-xs muted-2 mb-3 flex items-center gap-1.5">
          <span class="hole-mark hole-mark-sm birdie">3</span> birdie
          <span class="hole-mark hole-mark-sm bogey ml-2">5</span> bogey
        </p>` : ""}

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
          const input = app.querySelector(`input[data-hole="${hole}"]`);
          let current = parseInt(input.value, 10) || par[hole - 1];
          current = Math.max(1, current + delta);
          input.value = current;
          await saveScore(hole, current);
        });
      });
      app.querySelectorAll('input[data-hole]').forEach((input) => {
        input.addEventListener("change", async () => {
          const hole = parseInt(input.dataset.hole, 10);
          const val = parseInt(input.value, 10);
          if (!val || val < 1) return;
          await saveScore(hole, val);
        });
      });
      const reviewBtn = document.getElementById("review-sign-btn");
      if (reviewBtn && allEntered) {
        reviewBtn.addEventListener("click", () => { mode = "review"; render(); });
      }
    }
  }

  async function saveScore(hole, strokes) {
    const { error } = await sb
      .from("scores")
      .upsert({ team_id: teamId, hole_number: hole, strokes, updated_at: new Date().toISOString() }, { onConflict: "team_id,hole_number" });
    if (error) toast("Couldn't save score: " + error.message, true);
    else render();
  }

  await render();

  realtimeChannel = sb
    .channel(`team-${teamId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "scores", filter: `team_id=eq.${teamId}` }, render)
    .subscribe();
}

// ---------- LEADERBOARD ----------

async function viewLeaderboard(tournamentId) {
  app.innerHTML = loadingHtml();

  const { data: tournament, error } = await sb.from("tournaments").select("*").eq("id", tournamentId).single();
  if (error || !tournament) {
    app.innerHTML = notFoundHtml("Tournament");
    return;
  }
  headerSub.innerHTML = tournament.status === "active"
    ? `<span class="pill live"><span class="dot"></span>Live</span>`
    : `<span class="pill on-dark">Final</span>`;

  const par = tournament.par && tournament.par.length === tournament.num_holes ? tournament.par : Array(tournament.num_holes).fill(4);

  async function render() {
    const { data: teams } = await sb
      .from("teams")
      .select("id, name, signed_at, team_members(player_name), scores(hole_number, strokes)")
      .eq("tournament_id", tournamentId);

    const rows = (teams || []).map((t) => {
      let strokes = 0, parSum = 0, thru = 0;
      (t.scores || []).forEach((s) => {
        strokes += s.strokes;
        parSum += par[s.hole_number - 1] ?? 4;
        thru++;
      });
      return {
        id: t.id,
        name: t.name,
        players: (t.team_members || []).map((m) => m.player_name),
        strokes, thru,
        toPar: strokes - parSum,
        signed: !!t.signed_at,
      };
    });

    rows.sort((a, b) => (a.thru === 0 ? 1 : 0) - (b.thru === 0 ? 1 : 0) || a.toPar - b.toPar || b.thru - a.thru);

    const isLive = tournament.status === "active";

    app.innerHTML = `
      <section class="panel-dark px-5 pt-5 pb-5 mb-2.5">
        <div class="eyebrow on-dark mb-2">Leaderboard</div>
        <h1 class="display" style="font-size:2.1rem;color:#fff">${escapeHtml(tournament.name)}</h1>
        ${tournament.course_name ? `<p class="text-sm mt-2" style="color:rgba(255,255,255,.55)">${escapeHtml(tournament.course_name)}</p>` : ""}
        <div class="flex items-center gap-2 mt-4 pt-3.5" style="border-top:1px solid rgba(255,255,255,.09)">
          <span class="pill on-dark">${tournament.num_holes} holes</span>
          <span class="pill on-dark">Code ${escapeHtml(tournament.join_code)}</span>
          ${!isLive ? `<span class="pill on-dark">Closed</span>` : ""}
        </div>
      </section>

      <div class="card overflow-hidden">
        <div class="lb-head">
          <span></span>
          <span>Team</span>
          <span class="text-right">Score</span>
          <span class="text-right">Thru</span>
        </div>
        ${rows.length === 0 ? `
          <div class="p-8 text-center">
            <div class="mx-auto mb-3 flex items-center justify-center" style="color:var(--ink-3)">${icon("users", 30)}</div>
            <p class="font-semibold mb-1">No teams yet</p>
            <p class="text-sm muted">Share code <b class="num">${escapeHtml(tournament.join_code)}</b> to get players on the board.</p>
          </div>` : ""}
        ${rows.map((r, i) => {
          const leading = i === 0 && r.thru > 0;
          return `
          <a href="#/scorecard/${r.id}" class="lb-row${leading ? " leader" : ""}">
            <span class="rank${leading ? " lead" : ""}">${i + 1}</span>
            <span class="min-w-0">
              <span class="font-bold block truncate">${escapeHtml(r.name)}${r.signed ? ` <span class="fin-badge" title="Scorecard signed &amp; submitted">F</span>` : ""}</span>
              ${r.players.length ? `<span class="text-xs muted-2 block truncate mt-0.5">${escapeHtml(r.players.join(" · "))}</span>` : ""}
            </span>
            <span class="text-right">
              ${r.thru
                ? `<span class="to-par ${toParClass(r.toPar)}" style="font-size:1.65rem">${toParLabel(r.toPar)}</span>`
                : `<span class="muted-2">—</span>`}
            </span>
            <span class="text-right num-display muted" style="font-size:1.15rem">
              ${r.thru || "–"}<span class="text-xs muted-2">/${tournament.num_holes}</span>
            </span>
          </a>`;
        }).join("")}
      </div>

      <div class="flex items-center justify-center gap-2 mt-3.5">
        <span class="eyebrow">${isLive ? "Updating live as scores come in" : "Tournament closed"}</span>
      </div>
      <p class="text-center text-xs muted-2 mt-2">
        <span class="to-par under font-bold">−</span> under par &nbsp;·&nbsp; tap a team for their full card
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
    .select("*, tournaments(*), team_members(player_name)")
    .eq("id", teamId)
    .single();
  if (error || !team) {
    app.innerHTML = notFoundHtml("Team");
    return;
  }
  const tournament = team.tournaments;
  const par = tournament.par && tournament.par.length === tournament.num_holes ? tournament.par : Array(tournament.num_holes).fill(4);

  async function render() {
    const { data: scores } = await sb.from("scores").select("hole_number, strokes").eq("team_id", teamId);
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
        ${scorecardGridHtml(par, scoreMap)}
      </div>

      <p class="text-xs muted-2 mb-5 flex items-center gap-1.5">
        <span class="hole-mark hole-mark-sm birdie">3</span> birdie
        <span class="hole-mark hole-mark-sm bogey ml-2">5</span> bogey
      </p>

      <a href="#/leaderboard/${tournament.id}" class="btn-secondary w-full">${icon("board", 17)} Back to leaderboard</a>
    `;
  }

  await render();

  realtimeChannel = sb
    .channel(`scorecard-${teamId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "scores", filter: `team_id=eq.${teamId}` }, render)
    .subscribe();
}
