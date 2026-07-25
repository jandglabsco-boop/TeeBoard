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

function viewHome() {
  const admin = myTournaments();
  const teams = myTeams();
  const teamEntries = Object.entries(teams);

  app.innerHTML = `
    <div class="text-center my-6">
      <div class="text-5xl mb-2">⛳</div>
      <h1 class="text-2xl font-bold text-green-900">TeeBoard</h1>
      <p class="text-gray-500 mt-1">Live scoring for scrambles &amp; small tournaments</p>
    </div>

    <div class="grid grid-cols-1 gap-3">
      <a href="#/join" class="card p-5 flex items-center gap-4 hover:shadow-md transition">
        <span class="text-3xl">🏌️</span>
        <div>
          <div class="font-bold">Join a Tournament</div>
          <div class="text-sm text-gray-500">Have a code? Enter scores for your team.</div>
        </div>
      </a>
      <a href="#/create" class="card p-5 flex items-center gap-4 hover:shadow-md transition">
        <span class="text-3xl">🏆</span>
        <div>
          <div class="font-bold">Create a Tournament</div>
          <div class="text-sm text-gray-500">Set up tonight's scramble and get a join code.</div>
        </div>
      </a>
    </div>

    ${teamEntries.length ? `
      <h2 class="font-bold text-gray-600 text-sm uppercase mt-8 mb-2">My Teams</h2>
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

    ${admin.length ? `
      <h2 class="font-bold text-gray-600 text-sm uppercase mt-8 mb-2">Tournaments I Created</h2>
      <div class="grid grid-cols-1 gap-2">
        ${admin.map((t) => `
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

function viewCreate() {
  app.innerHTML = `
    <h1 class="text-xl font-bold mb-4">Create a Tournament</h1>
    <form id="create-form" class="card p-5 flex flex-col gap-4">
      <div>
        <label class="text-sm font-semibold">Tournament name</label>
        <input name="name" required placeholder="Thursday Night Scramble" />
      </div>
      <div>
        <label class="text-sm font-semibold">Course name (optional)</label>
        <input name="course" placeholder="Pine Valley GC" />
      </div>
      <div>
        <label class="text-sm font-semibold">Holes</label>
        <select name="holes">
          <option value="18">18 holes</option>
          <option value="9">9 holes</option>
        </select>
      </div>
      <div>
        <label class="text-sm font-semibold">Par per hole (optional)</label>
        <input name="par" placeholder="e.g. 4,4,3,5,4,3,4,5,4,4,4,3,5,4,4,3,4,5" />
        <p class="text-xs text-gray-500 mt-1">Comma-separated, one per hole. Leave blank to default every hole to par 4.</p>
      </div>
      <button class="btn-primary" type="submit">Create &amp; Get Code</button>
    </form>
  `;

  document.getElementById("create-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const name = fd.get("name").trim();
    const course = fd.get("course").trim();
    const numHoles = parseInt(fd.get("holes"), 10);
    let par = [];
    const parRaw = fd.get("par").trim();
    if (parRaw) {
      par = parRaw.split(",").map((p) => parseInt(p.trim(), 10)).filter((p) => !isNaN(p));
    }
    if (par.length !== numHoles) par = Array(numHoles).fill(4);

    const btn = e.target.querySelector("button");
    btn.disabled = true;
    btn.textContent = "Creating...";

    let tournament = null;
    for (let attempt = 0; attempt < 6 && !tournament; attempt++) {
      const code = genCode(5);
      const { data, error } = await sb
        .from("tournaments")
        .insert({ name, course_name: course || null, join_code: code, num_holes: numHoles, par })
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

  const { data: tournament, error } = await sb.from("tournaments").select("*").eq("id", tournamentId).single();
  if (error || !tournament) {
    app.innerHTML = `<div class="card p-5 mt-6">Tournament not found.</div>`;
    return;
  }
  saveMyTournament({ id: tournament.id, name: tournament.name, code: tournament.join_code });

  async function render() {
    const { data: teams } = await sb
      .from("teams")
      .select("id, name, join_code, team_members(id, player_name), scores(hole_number)")
      .eq("tournament_id", tournamentId)
      .order("created_at", { ascending: true });

    const joinUrl = shareLink(`/join/${tournament.join_code}`);

    app.innerHTML = `
      <div class="flex items-center justify-between mb-2">
        <h1 class="text-xl font-bold">${escapeHtml(tournament.name)}</h1>
        <span class="text-xs px-2 py-1 rounded-full ${tournament.status === "active" ? "bg-green-100 text-green-800" : "bg-gray-200 text-gray-600"}">${tournament.status}</span>
      </div>
      ${tournament.course_name ? `<p class="text-gray-500 text-sm mb-4">${escapeHtml(tournament.course_name)} &middot; ${tournament.num_holes} holes</p>` : ""}

      <div class="card p-5 text-center mb-4">
        <div class="text-sm text-gray-500 mb-1">Join code</div>
        <div class="text-4xl font-black tracking-widest text-green-800">${tournament.join_code}</div>
        <canvas id="qr" class="mx-auto mt-3"></canvas>
        <div class="flex gap-2 mt-3">
          <button id="copy-link" class="btn-secondary flex-1">Copy join link</button>
          <a href="#/leaderboard/${tournament.id}" class="btn-primary flex-1 text-center">Leaderboard</a>
        </div>
      </div>

      <h2 class="font-bold text-gray-600 text-sm uppercase mb-2">Teams (${(teams || []).length})</h2>
      <div class="grid grid-cols-1 gap-2 mb-4">
        ${(teams || []).length === 0 ? `<div class="card p-4 text-sm text-gray-500">No teams yet — share the join code above.</div>` : ""}
        ${(teams || []).map((t) => `
          <div class="card p-4">
            <div class="flex items-center justify-between">
              <div class="font-semibold">${escapeHtml(t.name)}</div>
              <span class="text-xs text-gray-400">code ${escapeHtml(t.join_code)}</span>
            </div>
            <div class="text-xs text-gray-500 mt-1">${(t.team_members || []).map((m) => escapeHtml(m.player_name)).join(", ") || "no players yet"}</div>
            <div class="text-xs text-gray-400 mt-1">${(t.scores || []).length}/${tournament.num_holes} holes entered</div>
          </div>
        `).join("")}
      </div>

      <button id="toggle-status" class="btn-secondary w-full">${tournament.status === "active" ? "Close tournament" : "Reopen tournament"}</button>
    `;

    if (window.QRCode) QRCode.toCanvas(document.getElementById("qr"), joinUrl, { width: 160 });

    document.getElementById("copy-link").addEventListener("click", () => {
      navigator.clipboard.writeText(joinUrl).then(() => toast("Join link copied"));
    });
    document.getElementById("toggle-status").addEventListener("click", async () => {
      const newStatus = tournament.status === "active" ? "closed" : "active";
      await sb.from("tournaments").update({ status: newStatus }).eq("id", tournament.id);
      tournament.status = newStatus;
      render();
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

function renderTeamStep(tournament) {
  const savedName = load("bb_player_name", "");
  const body = document.getElementById("join-body");
  body.innerHTML = `
    <div class="card p-5 mt-4">
      <div class="font-semibold mb-3">${escapeHtml(tournament.name)}</div>
      <label class="text-sm font-semibold">Your name</label>
      <input id="player-name" placeholder="Your name" value="${escapeHtml(savedName)}" class="mb-3" />

      <div class="flex gap-2 mb-3">
        <button id="mode-new" class="btn-secondary flex-1">Create a Team</button>
        <button id="mode-existing" class="btn-secondary flex-1">Join a Team</button>
      </div>
      <div id="team-mode-body"></div>
    </div>
  `;

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

  async function render() {
    const { data: members } = await sb.from("team_members").select("player_name").eq("team_id", teamId);
    const { data: scores } = await sb.from("scores").select("hole_number, strokes").eq("team_id", teamId);
    const scoreMap = {};
    (scores || []).forEach((s) => (scoreMap[s.hole_number] = s.strokes));

    const par = tournament.par && tournament.par.length === tournament.num_holes ? tournament.par : Array(tournament.num_holes).fill(4);
    let totalStrokes = 0, totalPar = 0, thru = 0;
    for (let h = 1; h <= tournament.num_holes; h++) {
      if (scoreMap[h] != null) {
        totalStrokes += scoreMap[h];
        totalPar += par[h - 1];
        thru++;
      }
    }
    const toPar = totalStrokes - totalPar;

    let holesHtml = "";
    for (let h = 1; h <= tournament.num_holes; h++) {
      const val = scoreMap[h] ?? "";
      holesHtml += `
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

      <div class="card p-4 flex items-center justify-around text-center mb-4">
        <div><div class="text-2xl font-black text-green-800">${thru ? toParLabel(toPar) : "—"}</div><div class="text-xs text-gray-400">Score</div></div>
        <div><div class="text-2xl font-black">${totalStrokes || "—"}</div><div class="text-xs text-gray-400">Strokes</div></div>
        <div><div class="text-2xl font-black">${thru}/${tournament.num_holes}</div><div class="text-xs text-gray-400">Thru</div></div>
      </div>

      <a href="#/leaderboard/${tournament.id}" class="btn-primary block text-center mb-4">View Live Leaderboard</a>

      <h2 class="font-bold text-gray-600 text-sm uppercase mb-2">Enter Scores</h2>
      <div class="grid grid-cols-1 gap-2">${holesHtml}</div>
    `;

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
  headerSub.textContent = tournament.status === "active" ? "🟢 live" : "closed";

  const par = tournament.par && tournament.par.length === tournament.num_holes ? tournament.par : Array(tournament.num_holes).fill(4);

  async function render() {
    const { data: teams } = await sb
      .from("teams")
      .select("id, name, scores(hole_number, strokes)")
      .eq("tournament_id", tournamentId);

    const rows = (teams || []).map((t) => {
      let strokes = 0, parSum = 0, thru = 0;
      (t.scores || []).forEach((s) => {
        strokes += s.strokes;
        parSum += par[s.hole_number - 1] ?? 4;
        thru++;
      });
      return { name: t.name, strokes, thru, toPar: strokes - parSum };
    });

    rows.sort((a, b) => (a.thru === 0 ? 1 : 0) - (b.thru === 0 ? 1 : 0) || a.toPar - b.toPar || b.thru - a.thru);

    app.innerHTML = `
      <h1 class="text-xl font-bold mb-1">${escapeHtml(tournament.name)}</h1>
      <p class="text-sm text-gray-500 mb-4">${tournament.course_name ? escapeHtml(tournament.course_name) + " · " : ""}${tournament.num_holes} holes &middot; code ${tournament.join_code}</p>

      <div class="card overflow-hidden">
        <table class="w-full text-sm">
          <thead class="bg-green-800 text-white">
            <tr>
              <th class="p-3 text-left">#</th>
              <th class="p-3 text-left">Team</th>
              <th class="p-3 text-right">Score</th>
              <th class="p-3 text-right">Thru</th>
            </tr>
          </thead>
          <tbody>
            ${rows.length === 0 ? `<tr><td colspan="4" class="p-4 text-center text-gray-400">No teams yet</td></tr>` : ""}
            ${rows.map((r, i) => `
              <tr class="border-t border-gray-100">
                <td class="p-3 font-bold text-gray-400">${i + 1}</td>
                <td class="p-3 font-semibold">${escapeHtml(r.name)}</td>
                <td class="p-3 text-right font-bold ${r.toPar < 0 ? "text-green-700" : r.toPar > 0 ? "text-gray-700" : "text-gray-500"}">${r.thru ? toParLabel(r.toPar) : "—"}</td>
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
