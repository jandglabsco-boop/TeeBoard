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
  return toPar > 0 ? `+${toPar}` : `${toPar}`;
}

function toast(msg, isError) {
  let t = document.createElement("div");
  t.textContent = msg;
  t.className = `fixed bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg shadow-lg text-white text-sm z-50 ${isError ? "bg-red-600" : "bg-gray-900"}`;
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
      <button id="profile-btn" class="w-8 h-8 rounded-full bg-blue-600 text-white font-bold text-sm flex items-center justify-center">${initial}</button>
      <div id="profile-menu" class="hidden absolute right-0 mt-2 w-56 card text-gray-900 p-3 z-30">
        <div class="text-xs text-gray-500 mb-2 break-all">Signed in as<br><b>${escapeHtml(user.email)}</b></div>
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
    location.hash = "#/";
    renderHeaderProfile();
  });
}

// ---------- router ----------

const routes = [
  { re: /^#\/$/, view: viewHome },
  { re: /^#\/create$/, view: viewCreate },
  { re: /^#\/join$/, view: viewJoin },
  { re: /^#\/join\/([A-Za-z0-9]+)$/, view: (m) => viewJoin(m[1]) },
  { re: /^#\/admin\/([0-9a-fA-F-]+)$/, view: (m) => viewAdmin(m[1]) },
  { re: /^#\/team\/([0-9a-fA-F-]+)$/, view: (m) => viewTeam(m[1]) },
  { re: /^#\/leaderboard\/([0-9a-fA-F-]+)$/, view: (m) => viewLeaderboard(m[1]) },
];

function route() {
  clearRealtime();
  headerSub.textContent = "";
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
      <div class="card p-5 mt-6">
        <h2 class="font-bold text-lg mb-2">⚠️ Not connected yet</h2>
        <p class="text-sm text-gray-600 mb-2">This app needs a free Supabase project to store tournaments and scores.</p>
        <p class="text-sm text-gray-600">Open <code class="bg-gray-100 px-1 rounded">config.js</code> and fill in your <code class="bg-gray-100 px-1 rounded">SUPABASE_URL</code> and <code class="bg-gray-100 px-1 rounded">SUPABASE_ANON_KEY</code>, then reload. See README.md for step-by-step setup.</p>
      </div>`;
    return;
  }
  route();
});

// ---------- HOME ----------

async function viewHome() {
  app.innerHTML = `<div class="text-center text-gray-400 mt-10">Loading...</div>`;

  const user = await getUser();
  const teams = myTeams();
  const teamEntries = Object.entries(teams);

  let owned = [];
  if (user) {
    const { data } = await sb
      .from("tournaments")
      .select("id, name, join_code")
      .eq("created_by", user.id)
      .order("created_at", { ascending: false });
    owned = data || [];
  }
  // tournaments created on this browser before accounts existed (created_by is null for those)
  const legacy = myTournaments().filter((t) => !owned.some((o) => o.id === t.id));

  app.innerHTML = `
    <div class="text-center my-7">
      <div class="text-5xl mb-3">⛳</div>
      <h1 class="brand text-3xl font-semibold text-[#0b0f19]">TeeBoard</h1>
      <p class="text-gray-500 mt-1.5">Live scoring for scrambles &amp; small tournaments</p>
    </div>

    <div class="grid grid-cols-1 gap-3">
      <a href="#/join" class="card p-5 flex items-center gap-4 hover:-translate-y-0.5 transition">
        <span class="icon-badge">🏌️</span>
        <div>
          <div class="font-bold">Join a Tournament</div>
          <div class="text-sm text-gray-500">Have a code? Enter scores for your team.</div>
        </div>
      </a>
      <a href="#/create" class="card p-5 flex items-center gap-4 hover:-translate-y-0.5 transition">
        <span class="icon-badge">🏆</span>
        <div>
          <div class="font-bold">Create a Tournament</div>
          <div class="text-sm text-gray-500">Set up tonight's scramble and get a join code.</div>
        </div>
      </a>
    </div>

    ${teamEntries.length ? `
      <h2 class="font-bold text-gray-500 text-xs tracking-wide uppercase mt-8 mb-2">My Teams</h2>
      <div class="grid grid-cols-1 gap-2">
        ${teamEntries.map(([tid, t]) => `
          <a href="#/team/${t.teamId}" class="card p-4 flex items-center justify-between">
            <div>
              <div class="font-semibold">${escapeHtml(t.teamName)}</div>
              <div class="text-xs text-gray-500">team code ${escapeHtml(t.teamCode)}</div>
            </div>
            <span class="btn-ghost">Score &rarr;</span>
          </a>
        `).join("")}
      </div>
    ` : ""}

    ${(owned.length || legacy.length) ? `
      <h2 class="font-bold text-gray-500 text-xs tracking-wide uppercase mt-8 mb-2">Tournaments I Created</h2>
      <div class="grid grid-cols-1 gap-2">
        ${owned.map((t) => `
          <a href="#/admin/${t.id}" class="card p-4 flex items-center justify-between">
            <div>
              <div class="font-semibold">${escapeHtml(t.name)}</div>
              <div class="text-xs text-gray-500">code ${escapeHtml(t.join_code)}</div>
            </div>
            <span class="btn-ghost">Manage &rarr;</span>
          </a>
        `).join("")}
        ${legacy.map((t) => `
          <a href="#/admin/${t.id}" class="card p-4 flex items-center justify-between">
            <div>
              <div class="font-semibold">${escapeHtml(t.name)}</div>
              <div class="text-xs text-gray-500">code ${escapeHtml(t.code)}</div>
            </div>
            <span class="btn-ghost">Manage &rarr;</span>
          </a>
        `).join("")}
      </div>
    ` : ""}
  `;
}

// ---------- CREATE TOURNAMENT ----------

const COURSE_SEARCH_URL = "https://api.opengolfapi.org/v1/courses/search?q=";
const COURSE_DETAIL_URL = "https://api.opengolfapi.org/v1/courses/";

async function viewCreate() {
  app.innerHTML = `<div class="text-center text-gray-400 mt-10">Loading...</div>`;
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
      <h1 class="text-xl font-bold mb-4">Create a Tournament</h1>
      <div class="card p-5">
        <p class="text-sm text-gray-600 mb-4">Creating a tournament needs a free organizer account, so only you can manage it later. Players never need an account — they just use a join code.</p>
        <div class="flex gap-2 mb-4">
          <button id="tab-signup" class="${mode === "signup" ? "btn-primary" : "btn-secondary"} flex-1">Sign Up</button>
          <button id="tab-signin" class="${mode === "signin" ? "btn-primary" : "btn-secondary"} flex-1">Sign In</button>
        </div>
        <label class="text-sm font-semibold">Email</label>
        <input id="auth-email" type="email" placeholder="you@email.com" class="mb-3" />
        <label class="text-sm font-semibold">Password</label>
        <input id="auth-password" type="password" placeholder="At least 6 characters" class="mb-3" />
        <button id="auth-submit" class="btn-primary w-full">${mode === "signup" ? "Create Account" : "Sign In"}</button>
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
        statusEl.className = "text-xs mt-3 text-red-600";
        statusEl.textContent = "Enter an email and password.";
        return;
      }

      btn.disabled = true;
      statusEl.className = "text-xs mt-3 text-gray-500";
      statusEl.textContent = mode === "signup" ? "Creating account…" : "Signing in…";

      if (mode === "signup") {
        const { data, error } = await sb.auth.signUp({ email, password });
        btn.disabled = false;
        if (error) {
          statusEl.className = "text-xs mt-3 text-red-600";
          statusEl.textContent = error.message;
          return;
        }
        if (data.session) { renderHeaderProfile(); return viewCreate(); }
        // Project has "confirm email" turned on — no session until they click the email link.
        mode = "signin";
        draw();
        const s = document.getElementById("auth-status");
        s.className = "text-xs mt-3 text-blue-700 font-semibold";
        s.textContent = "Account created — check your email to confirm it, then sign in here.";
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        btn.disabled = false;
        if (error) {
          statusEl.className = "text-xs mt-3 text-red-600";
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
    <div class="flex items-center justify-between mb-4">
      <h1 class="text-xl font-bold">Create a Tournament</h1>
      <span class="text-xs text-gray-400">${escapeHtml(user.email)}</span>
    </div>
    <form id="create-form" class="card p-5 flex flex-col gap-4">
      <div>
        <label class="text-sm font-semibold">Tournament name</label>
        <input name="name" required placeholder="Thursday Night Scramble" />
      </div>
      <div class="relative">
        <label class="text-sm font-semibold">Course</label>
        <input id="course-input" name="course" placeholder="Search for your course… e.g. Pine Valley" autocomplete="off" />
        <div id="course-results" class="hidden absolute z-20 left-0 right-0 mt-1 card max-h-64 overflow-y-auto"></div>
        <p id="course-attribution" class="text-xs text-gray-400 mt-1">Search pulls real course data (holes &amp; par) from <a href="https://opengolfapi.org" target="_blank" class="underline">OpenGolfAPI</a>, free &amp; open (ODbL). Can't find your course? That's okay — every hole will default to par 4.</p>
        <p id="course-selected-note" class="hidden text-xs text-blue-700 font-semibold mt-1"></p>
      </div>
      <div>
        <label class="text-sm font-semibold">Holes</label>
        <select id="holes-select" name="holes">
          <option value="18">18 holes</option>
          <option value="9">9 holes</option>
        </select>
      </div>
      <div id="nine-wrap" class="hidden">
        <label class="text-sm font-semibold">Which nine?</label>
        <select id="nine-select" name="nine">
          <option value="front">Front nine (holes 1–9)</option>
          <option value="back">Back nine (holes 10–18)</option>
        </select>
      </div>
      <button class="btn-primary" type="submit">Create &amp; Get Code</button>
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
    const siteLink = website ? ` <a href="${escapeHtml(website)}" target="_blank" class="underline">${escapeHtml(name)}'s site</a> ·` : "";
    selectedNote.innerHTML = `✓ Using ${escapeHtml(name)}'s ${escapeHtml(label)}, par ${totalPar}.${siteLink}${escapeHtml(mismatchWarning)}`;
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
        resultsBox.innerHTML = `<div class="p-3 text-sm text-gray-400">No matches — that's okay, every hole will default to par 4.</div>`;
        resultsBox.classList.remove("hidden");
        return;
      }
      resultsBox.innerHTML = courses.map((c) => `
        <div class="search-result p-3 border-b border-gray-100 cursor-pointer" data-id="${escapeHtml(c.id)}" data-name="${escapeHtml(c.name)}">
          <div class="font-semibold text-sm">${escapeHtml(c.name)}</div>
          <div class="text-xs text-gray-400">${escapeHtml([c.city, c.state].filter(Boolean).join(", ")) || "&nbsp;"}</div>
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
      resultsBox.innerHTML = `<div class="p-3 text-sm text-gray-400">Couldn't reach course search right now — that's okay, every hole will default to par 4.</div>`;
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
    btn.textContent = "Creating...";

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
        btn.textContent = "Create & Get Code";
        return;
      }
    }
    if (!tournament) {
      toast("Couldn't generate a unique code, try again.", true);
      btn.disabled = false;
      btn.textContent = "Create & Get Code";
      return;
    }
    saveMyTournament({ id: tournament.id, name: tournament.name, code: tournament.join_code });
    location.hash = `#/admin/${tournament.id}`;
  });
}

// ---------- ADMIN VIEW ----------

async function viewAdmin(tournamentId) {
  app.innerHTML = `<div class="text-center text-gray-400 mt-10">Loading...</div>`;

  const [{ data: tournament, error }, user] = await Promise.all([
    sb.from("tournaments").select("*").eq("id", tournamentId).single(),
    getUser(),
  ]);
  if (error || !tournament) {
    app.innerHTML = `<div class="card p-5 mt-6">Tournament not found.</div>`;
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

    app.innerHTML = `
      <div class="flex items-center justify-between mb-2">
        <h1 class="text-xl font-bold">${escapeHtml(tournament.name)}</h1>
        <span class="text-xs px-2 py-1 rounded-full ${tournament.status === "active" ? "bg-blue-100 text-blue-800" : "bg-gray-200 text-gray-600"}">${tournament.status}</span>
      </div>
      ${tournament.course_name ? `<p class="text-gray-500 text-sm mb-4">${escapeHtml(tournament.course_name)} &middot; ${tournament.num_holes} holes</p>` : ""}

      <div id="qr-print-area" class="card p-5 text-center mb-4">
        <div class="text-sm text-gray-500 mb-1">Join code</div>
        <div class="text-4xl font-black tracking-widest text-blue-700">${tournament.join_code}</div>
        <canvas id="qr" class="mx-auto mt-3"></canvas>
        <div class="text-xs text-gray-400 mt-2">Scan to join &amp; score &mdash; ${escapeHtml(tournament.name)}</div>
        <div class="flex gap-2 mt-3 no-print">
          <button id="copy-link" class="btn-secondary flex-1">Copy join link</button>
          <button id="print-qr" class="btn-secondary flex-1">Print QR</button>
          <a href="#/leaderboard/${tournament.id}" class="btn-primary flex-1 text-center">Leaderboard</a>
        </div>
      </div>

      <h2 class="font-bold text-gray-600 text-sm uppercase mb-2">Teams (${(teams || []).length})</h2>
      <div class="grid grid-cols-1 gap-2 mb-4">
        ${(teams || []).length === 0 ? `<div class="card p-4 text-sm text-gray-500">No teams yet — share the join code above.</div>` : ""}
        ${(teams || []).map((t) => {
          const expanded = expandedTeams.has(t.id);
          return `
          <div class="card p-4">
            <div class="flex items-center justify-between">
              <div class="font-semibold">${escapeHtml(t.name)}${t.signed_at ? ` <span class="fin-badge" title="Signed by ${escapeHtml(t.signed_by || "")}">F</span>` : ""}</div>
              <span class="text-xs text-gray-400">code ${escapeHtml(t.join_code)}</span>
            </div>
            <div class="text-xs text-gray-500 mt-1">${(t.team_members || []).map((m) => escapeHtml(m.player_name)).join(", ") || "no players yet"}</div>
            <div class="text-xs text-gray-400 mt-1">${(t.scores || []).length}/${tournament.num_holes} holes entered${t.signed_at ? ` &middot; signed by ${escapeHtml(t.signed_by || "—")}` : ""}</div>
            ${isOwner ? `
              <button data-manage-team="${escapeHtml(t.id)}" class="btn-ghost text-xs mt-2">${expanded ? "Hide" : "Edit team"}</button>
              <div class="${expanded ? "" : "hidden"} mt-3 pt-3 border-t border-gray-100">
                <label class="text-xs font-semibold text-gray-500">Team name</label>
                <div class="flex gap-2 mb-3">
                  <input data-rename-input="${escapeHtml(t.id)}" value="${escapeHtml(t.name)}" class="flex-1" />
                  <button data-rename-btn="${escapeHtml(t.id)}" class="btn-secondary">Save</button>
                </div>
                ${(t.team_members || []).length ? `
                  <div class="flex flex-col gap-1 mb-3">
                    ${(t.team_members || []).map((m) => `
                      <div class="flex items-center justify-between text-sm bg-gray-50 rounded px-2 py-1">
                        <span>${escapeHtml(m.player_name)}</span>
                        <button data-remove-member="${escapeHtml(m.id)}" class="text-red-500 text-xs font-bold">Remove</button>
                      </div>
                    `).join("")}
                  </div>
                ` : ""}
                <label class="text-xs font-semibold text-gray-500">Add player</label>
                <div class="flex gap-2 mb-3">
                  <input data-quick-add-input="${escapeHtml(t.id)}" placeholder="Player name" class="flex-1" />
                  <button data-quick-add-btn="${escapeHtml(t.id)}" class="btn-primary">Add</button>
                </div>
                ${t.signed_at ? `
                  <button data-reopen-team="${escapeHtml(t.id)}" class="btn-secondary text-xs w-full">Reopen scorecard (undo signing)</button>
                ` : ""}
              </div>
            ` : ""}
          </div>
        `; }).join("")}
      </div>

      ${isOwner ? `
        <div class="card p-4 mb-4">
          <h2 class="font-bold text-gray-600 text-sm uppercase mb-2">Add a Player</h2>
          <p class="text-xs text-gray-500 mb-2">Add one person at a time — to an existing team, or a brand new one.</p>
          <label class="text-sm font-semibold">Team</label>
          <select id="add-team-select" class="mb-2">
            <option value="__new">+ New team</option>
            ${(teams || []).map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join("")}
          </select>
          <div id="new-team-name-wrap" class="mb-2">
            <input id="new-team-name" placeholder="New team name, e.g. The Duffers" />
          </div>
          <label class="text-sm font-semibold">Player name</label>
          <input id="add-player-name" placeholder="Player name" class="mb-3" />
          <button id="add-player-btn" class="btn-primary w-full">Add Player</button>
          <div id="add-player-status" class="text-xs mt-2"></div>
        </div>

        <div class="card p-4 mb-4">
          <h2 class="font-bold text-gray-600 text-sm uppercase mb-2">Import Roster (CSV)</h2>
          <p class="text-xs text-gray-500 mb-2">
            Columns: <code class="bg-gray-100 px-1 rounded">team</code>, <code class="bg-gray-100 px-1 rounded">player</code>.
            No team column? Everyone gets auto-grouped into teams of 4, in file order.
            <a class="underline text-blue-700" download="teeboard-roster-template.csv" href="data:text/csv;charset=utf-8,${encodeURIComponent("team,player\nThe Duffers,Ben Herbst\nThe Duffers,Gabe Smith\nThe Duffers,Sam Lee\nThe Duffers,Pat Jordan\nBirdie Brigade,Alex Kim\nBirdie Brigade,Jordan Rivera\n")}">Download template</a>
          </p>
          <input type="file" id="csv-input" accept=".csv,text/csv" />
          <div id="csv-status" class="text-xs text-gray-500 mt-2"></div>
        </div>

        <button id="toggle-status" class="btn-secondary w-full">${tournament.status === "active" ? "Close tournament" : "Reopen tournament"}</button>
      ` : `
        <p class="text-xs text-gray-400 text-center">Only the organizer who created this tournament can manage roster imports and settings.</p>
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
          statusEl.className = "text-xs mt-2 text-red-600";
          statusEl.textContent = "Enter a player name.";
          return;
        }
        if (teamChoice === "__new" && !newTeamName) {
          statusEl.className = "text-xs mt-2 text-red-600";
          statusEl.textContent = "Enter a team name.";
          return;
        }

        btn.disabled = true;
        statusEl.className = "text-xs mt-2 text-gray-500";
        statusEl.textContent = "Adding…";

        const result = await addPlayerManually(teamChoice, newTeamName, playerName);

        btn.disabled = false;
        if (result.error) {
          statusEl.className = "text-xs mt-2 text-red-600";
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
    <h1 class="text-xl font-bold mb-4">Join a Tournament</h1>
    <form id="code-form" class="card p-5 flex flex-col gap-4">
      <div>
        <label class="text-sm font-semibold">Tournament code</label>
        <input name="code" required maxlength="8" style="text-transform:uppercase;letter-spacing:.2em;font-weight:700;font-size:1.3rem;text-align:center" value="${escapeHtml(prefillCode || "")}" />
      </div>
      <button class="btn-primary" type="submit">Find Tournament</button>
    </form>
    <div id="join-body"></div>
  `;

  document.getElementById("code-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = new FormData(e.target).get("code").trim().toUpperCase();
    const btn = e.target.querySelector("button");
    btn.disabled = true;
    btn.textContent = "Searching...";
    const { data: tournament, error } = await sb.from("tournaments").select("*").eq("join_code", code).maybeSingle();
    btn.disabled = false;
    btn.textContent = "Find Tournament";
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
    <div class="card p-5 mt-4">
      <div class="font-semibold mb-3">${escapeHtml(tournament.name)}</div>

      <label class="text-sm font-semibold">Find your name</label>
      <input id="name-search" placeholder="Start typing your name…" autocomplete="off" class="mb-2" />
      <div id="name-search-loading" class="text-xs text-gray-400 mb-2">Loading roster…</div>
      <div id="name-results" class="flex flex-col gap-2 mb-2"></div>
      <p id="name-empty-note" class="hidden text-xs text-gray-400 mb-3">Nobody's been added to this tournament yet — ask your organizer, or set up your own team below.</p>

      <button id="toggle-other-options" class="btn-ghost text-xs mb-1">Don't see your name? Use a team code or start a new team &rarr;</button>

      <div id="other-options" class="hidden mt-3 pt-3 border-t border-gray-100">
        <label class="text-sm font-semibold">Your name</label>
        <input id="player-name" placeholder="Your name" value="${escapeHtml(savedName)}" class="mb-3" />

        <div class="flex gap-2 mb-3">
          <button id="mode-new" class="btn-secondary flex-1">Create a Team</button>
          <button id="mode-existing" class="btn-secondary flex-1">Join a Team</button>
        </div>
        <div id="team-mode-body"></div>
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
      <button data-team-id="${escapeHtml(m.team_id)}" data-team-name="${escapeHtml(m.teams.name)}" data-team-code="${escapeHtml(m.teams.join_code)}" data-player-name="${escapeHtml(m.player_name)}" class="card p-3 text-left flex items-center justify-between hover:shadow-md transition">
        <div>
          <div class="font-semibold text-sm">${escapeHtml(m.player_name)}</div>
          <div class="text-xs text-gray-400">${escapeHtml(m.teams.name)}</div>
        </div>
        <span class="btn-ghost">Go &rarr;</span>
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
      nameResults.innerHTML = `<div class="text-xs text-gray-400 p-1">No match yet — keep typing, or use a team code below.</div>`;
      return;
    }
    renderNameResults(matches);
  });

  // ---- Fallback: team code or brand-new team, for anyone not pre-added ----
  document.getElementById("mode-new").addEventListener("click", () => {
    document.getElementById("team-mode-body").innerHTML = `
      <label class="text-sm font-semibold">Team name</label>
      <input id="team-name" placeholder="e.g. The Duffers" class="mb-3" />
      <button id="submit-new-team" class="btn-primary w-full">Create Team</button>
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
      <label class="text-sm font-semibold">Team code</label>
      <input id="team-code" maxlength="6" style="text-transform:uppercase;letter-spacing:.2em;font-weight:700;text-align:center" class="mb-3" />
      <button id="submit-join-team" class="btn-primary w-full">Join Team</button>
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
  app.innerHTML = `<div class="text-center text-gray-400 mt-10">Loading...</div>`;

  const { data: team, error: teamErr } = await sb.from("teams").select("*, tournaments(*)").eq("id", teamId).single();
  if (teamErr || !team) {
    app.innerHTML = `<div class="card p-5 mt-6">Team not found.</div>`;
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
        <div class="mb-3">
          <h1 class="text-xl font-bold">Review &amp; Sign</h1>
          <p class="text-sm text-gray-500">${escapeHtml(team.name)} &middot; ${escapeHtml(tournament.name)}</p>
        </div>
        <div class="card overflow-hidden mb-4">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-xs text-gray-400 uppercase tracking-wide">
                <th class="p-2 text-left font-semibold">Hole</th>
                <th class="p-2 text-right font-semibold">Par</th>
                <th class="p-2 text-right font-semibold">Strokes</th>
              </tr>
            </thead>
            <tbody>
              ${par.map((p, i) => `
                <tr class="border-t border-gray-100">
                  <td class="p-2">${i + 1}</td>
                  <td class="p-2 text-right text-gray-400">${p}</td>
                  <td class="p-2 text-right font-semibold">${scoreMap[i + 1] ?? "—"}</td>
                </tr>
              `).join("")}
              <tr class="border-t border-gray-200 font-bold">
                <td class="p-2">Total</td>
                <td class="p-2 text-right text-gray-400">${totalPar}</td>
                <td class="p-2 text-right">${totalStrokes}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="card p-5 mb-4">
          <p class="text-sm text-gray-600 mb-3">By signing, you confirm this scorecard is accurate for <b>${escapeHtml(team.name)}</b>. Once signed it locks — ask your organizer if you need a correction.</p>
          <label class="text-sm font-semibold">Type your name to sign</label>
          <input id="sign-name" placeholder="Your name" value="${escapeHtml(load("bb_player_name", ""))}" class="mb-3" />
          <div class="flex gap-2">
            <button id="back-to-edit" class="btn-secondary flex-1">Back</button>
            <button id="sign-submit" class="btn-primary flex-1">Sign &amp; Submit</button>
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
          btn.textContent = "Sign & Submit";
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

    let holesHtml = "";
    for (let h = 1; h <= tournament.num_holes; h++) {
      const val = scoreMap[h] ?? "";
      holesHtml += isSigned ? `
        <div class="card p-3 flex items-center justify-between">
          <div>
            <div class="font-bold">Hole ${h}</div>
            <div class="text-xs text-gray-400">Par ${par[h - 1]}</div>
          </div>
          <div class="text-lg font-bold w-16 text-center">${val || "—"}</div>
        </div>` : `
        <div class="card p-3 flex items-center justify-between">
          <div>
            <div class="font-bold">Hole ${h}</div>
            <div class="text-xs text-gray-400">Par ${par[h - 1]}</div>
          </div>
          <div class="flex items-center gap-2">
            <button data-hole="${h}" data-delta="-1" class="score-btn bg-gray-100">-</button>
            <input data-hole="${h}" type="number" inputmode="numeric" min="1" max="15" value="${val}" class="w-16 text-center" />
            <button data-hole="${h}" data-delta="1" class="score-btn bg-gray-100">+</button>
          </div>
        </div>`;
    }

    app.innerHTML = `
      <div class="mb-3">
        <h1 class="text-xl font-bold">${escapeHtml(team.name)}</h1>
        <p class="text-sm text-gray-500">${escapeHtml(tournament.name)} &middot; team code <b>${team.join_code}</b></p>
        <p class="text-xs text-gray-400">Players: ${(members || []).map((m) => escapeHtml(m.player_name)).join(", ") || "—"}</p>
      </div>

      ${isSigned ? `
        <div class="card p-4 mb-4 text-center" style="background:#f0fdf4;border-color:#bbf7d0;">
          <div class="text-sm font-bold text-green-700">✓ Signed by ${escapeHtml(team.signed_by)}</div>
          <div class="text-xs text-green-600 mt-0.5">Scorecard submitted — nice round!</div>
        </div>
      ` : ""}

      <div class="card p-4 flex items-center justify-around text-center mb-4">
        <div><div class="text-2xl font-black text-blue-700">${thru ? toParLabel(toPar) : "—"}</div><div class="text-xs text-gray-400">Score</div></div>
        <div><div class="text-2xl font-black">${totalStrokes || "—"}</div><div class="text-xs text-gray-400">Strokes</div></div>
        <div><div class="text-2xl font-black">${thru}/${tournament.num_holes}</div><div class="text-xs text-gray-400">Thru</div></div>
      </div>

      <a href="#/leaderboard/${tournament.id}" class="btn-primary block text-center mb-4">View Live Leaderboard</a>

      <h2 class="font-bold text-gray-600 text-sm uppercase mb-2">${isSigned ? "Final Scorecard" : "Enter Scores"}</h2>
      <div class="grid grid-cols-1 gap-2 mb-4">${holesHtml}</div>

      ${!isSigned ? `
        <button id="review-sign-btn" class="btn-primary w-full" ${allEntered ? "" : "disabled"}>Review &amp; Sign Scorecard</button>
        ${!allEntered ? `<p class="text-xs text-gray-400 text-center mt-2">Enter all ${tournament.num_holes} holes to sign and submit.</p>` : ""}
      ` : ""}
    `;

    if (!isSigned) {
      app.querySelectorAll("button.score-btn").forEach((btn) => {
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
  app.innerHTML = `<div class="text-center text-gray-400 mt-10">Loading...</div>`;

  const { data: tournament, error } = await sb.from("tournaments").select("*").eq("id", tournamentId).single();
  if (error || !tournament) {
    app.innerHTML = `<div class="card p-5 mt-6">Tournament not found.</div>`;
    return;
  }
  headerSub.textContent = tournament.status === "active" ? "🔵 live" : "closed";

  const par = tournament.par && tournament.par.length === tournament.num_holes ? tournament.par : Array(tournament.num_holes).fill(4);

  async function render() {
    const { data: teams } = await sb
      .from("teams")
      .select("id, name, signed_at, scores(hole_number, strokes)")
      .eq("tournament_id", tournamentId);

    const rows = (teams || []).map((t) => {
      let strokes = 0, parSum = 0, thru = 0;
      (t.scores || []).forEach((s) => {
        strokes += s.strokes;
        parSum += par[s.hole_number - 1] ?? 4;
        thru++;
      });
      return { name: t.name, strokes, thru, toPar: strokes - parSum, signed: !!t.signed_at };
    });

    rows.sort((a, b) => (a.thru === 0 ? 1 : 0) - (b.thru === 0 ? 1 : 0) || a.toPar - b.toPar || b.thru - a.thru);

    app.innerHTML = `
      <h1 class="text-xl font-bold mb-1">${escapeHtml(tournament.name)}</h1>
      <p class="text-sm text-gray-500 mb-4">${tournament.course_name ? escapeHtml(tournament.course_name) + " · " : ""}${tournament.num_holes} holes &middot; code ${tournament.join_code}</p>

      <div class="card overflow-hidden">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-xs text-gray-400 uppercase tracking-wide">
              <th class="p-3 text-left font-semibold"></th>
              <th class="p-3 text-left font-semibold">Team</th>
              <th class="p-3 text-right font-semibold">Score</th>
              <th class="p-3 text-right font-semibold">Thru</th>
            </tr>
          </thead>
          <tbody>
            ${rows.length === 0 ? `<tr><td colspan="4" class="p-4 text-center text-gray-400">No teams yet</td></tr>` : ""}
            ${rows.map((r, i) => `
              <tr class="border-t border-gray-100">
                <td class="p-3"><span class="rank-badge${i === 0 && r.thru ? " gold" : ""}">${i + 1}</span></td>
                <td class="p-3 font-semibold">${escapeHtml(r.name)}${r.signed ? ` <span class="fin-badge" title="Scorecard signed & submitted">F</span>` : ""}</td>
                <td class="p-3 text-right">${r.thru ? `<span class="par-chip ${r.toPar < 0 ? "under" : "flat"}">${toParLabel(r.toPar)}</span>` : `<span class="text-gray-300">—</span>`}</td>
                <td class="p-3 text-right text-gray-500">${r.thru}/${tournament.num_holes}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
      <p class="text-xs text-gray-400 text-center mt-3">Updates live as teams enter scores</p>
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
