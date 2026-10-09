// Banker rules.
//
// One player banks, names what the hole is worth, and plays it against every
// other player at once. Beat the bank and it pays you; lose and you pay it.
// The winner of the hole takes the bank; a banker who wins keeps it. A tie
// for low is settled by going back a hole at a time.
const fs = require('fs'), vm = require('vm'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

const sandbox = {
  window: { addEventListener(){}, TEEBOARD_CONFIG: {} },
  document: { getElementById: () => null, querySelectorAll: () => [], addEventListener(){}, createElement: () => ({}) },
  location: { hash: '' }, navigator: { onLine: true }, console,
  setTimeout, setInterval: () => 0, clearInterval(){}, clearTimeout(){},
  fetch: () => Promise.reject(new Error('no network in tests')),
  localStorage: { getItem: () => null, setItem(){}, removeItem(){} },
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`);
};

// A group of players on one team, each with their own ball.
const round = (players, amounts, holes = 9, si = [1,2,3,4,5,6,7,8,9], par = 4) => ({
  num_holes: holes,
  handicap: si,
  par: Array(holes).fill(par),
  format: 'banker',
  bankerAmounts: amounts,
  teams: [{
    id: 'g1', name: 'Group', signed_at: null,
    team_members: players.map(p => ({ id: p.id, player_name: p.name, handicap: p.hc })),
    scores: players.flatMap(p => Object.entries(p.s || {})
      .map(([h, v]) => ({ hole_number: +h, strokes: v, team_member_id: p.id }))),
  }],
});

const money = (b) => Object.fromEntries(b.players.map(p => [p.name, p.money]));

// --- 1. the bank pays everyone it loses to, and collects from everyone else
{
  const t = round([
    { id:'a', name:'Banker', hc:0, s:{1:5} },
    { id:'b', name:'Beat',   hc:0, s:{1:4} },
    { id:'c', name:'Lost',   hc:0, s:{1:6} },
    { id:'d', name:'Halved', hc:0, s:{1:5} },
  ], { 1: 5 });
  const b = sandbox.buildBanker(t, t.teams);
  check('a $5 hole: the bank pays who beat it', money(b).Beat, 5);
  check('  and collects from who lost', money(b).Lost, -5);
  check('  a halved hole is nothing', money(b).Halved, 0);
  check('  the bank is square on the hole', money(b).Banker, 0);
}

// --- 2. the bank passes to whoever won the hole
{
  const t = round([
    { id:'a', name:'Banker', hc:0, s:{1:5} },
    { id:'b', name:'Winner', hc:0, s:{1:3} },
    { id:'c', name:'Other',  hc:0, s:{1:6} },
  ], { 1: 5 });
  const b = sandbox.buildBanker(t, t.teams);
  check('the winner takes the bank', b.holes[0].winnerId, 'b');
}

// --- 3. a banker who wins keeps it
{
  const t = round([
    { id:'a', name:'Banker', hc:0, s:{1:3,2:3} },
    { id:'b', name:'Other',  hc:0, s:{1:5,2:5} },
  ], { 1: 5, 2: 5 });
  const b = sandbox.buildBanker(t, t.teams);
  check('a winning banker keeps the bank', b.holes[1].bankerId, 'a');
  check('  and is up both holes', money(b).Banker, 10);
}

// --- 4. POPS: a shot makes a 5 beat a scratch 5
{
  const t = round([
    { id:'a', name:'Scratch', hc:0, s:{1:5} },
    { id:'b', name:'Pop',     hc:9, s:{1:5} },   // 9 over 9 holes = a shot on SI 1..5
  ], { 1: 5 });
  const b = sandbox.buildBanker(t, t.teams);
  check('a shot on the hole turns a tie into a win', money(b).Pop, 5);
  check('  and the bank pays it', money(b).Scratch, -5);
}

// --- 5. plus handicaps give nothing back; below scratch is scratch
{
  const t = round([
    { id:'a', name:'Plus',    hc:-4, s:{1:4} },
    { id:'b', name:'Scratch', hc:0,  s:{1:4} },
  ], { 1: 5 });
  const b = sandbox.buildBanker(t, t.teams);
  check('a plus handicap is treated as scratch, so this is halved', money(b).Plus, 0);
  check('  nobody is charged a shot', money(b).Scratch, 0);
}

// --- 6. TIE FOR LOW: settled by going back a hole
{
  // Hole 2 is tied between B and C. On hole 1, B was lower than C.
  const t = round([
    { id:'a', name:'Banker', hc:0, s:{1:5, 2:5} },
    { id:'b', name:'B',      hc:0, s:{1:4, 2:3} },
    { id:'c', name:'C',      hc:0, s:{1:6, 2:3} },
  ], { 1: 5, 2: 5 });
  const b = sandbox.buildBanker(t, t.teams);
  check('hole 2 is tied for low', b.holes[1].tiedLow, true);
  check('  it goes to whoever was ahead on hole 1', b.holes[1].winnerId, 'b');
}

// --- 7. tie resolved two holes back
{
  // Holes 2 and 3 both tied between B and C; hole 1 separates them.
  const t = round([
    { id:'a', name:'Banker', hc:0, s:{1:5, 2:5, 3:5} },
    { id:'b', name:'B',      hc:0, s:{1:6, 2:4, 3:3} },
    { id:'c', name:'C',      hc:0, s:{1:4, 2:4, 3:3} },
  ], { 1: 5, 2: 5, 3: 5 });
  const b = sandbox.buildBanker(t, t.teams);
  check('a tie still level one hole back goes further back', b.holes[2].winnerId, 'c');
}

// --- 8. an unpriced hole moves the bank but no money
{
  const t = round([
    { id:'a', name:'Banker', hc:0, s:{1:5} },
    { id:'b', name:'Winner', hc:0, s:{1:3} },
  ], {});                                    // no amount set
  const b = sandbox.buildBanker(t, t.teams);
  check('no money changes hands on an unpriced hole', money(b), { Banker: 0, Winner: 0 });
  check('  but the bank still moves', b.holes[0].winnerId, 'b');
  check('  and it is reported as unpriced', b.unpriced, 1);
}

// --- 9. everyone is square at the end
{
  const t = round([
    { id:'a', name:'A', hc:0, s:{1:4,2:5,3:3} },
    { id:'b', name:'B', hc:0, s:{1:5,2:4,3:4} },
    { id:'c', name:'C', hc:0, s:{1:6,2:4,3:5} },
  ], { 1: 10, 2: 5, 3: 20 });
  const b = sandbox.buildBanker(t, t.teams);
  const total = b.players.reduce((a, p) => a + p.money, 0);
  check('the money always sums to zero', total, 0);
}

// --- 10. fewer than two players is not a game
{
  const t = round([{ id:'a', name:'Alone', hc:0, s:{1:4} }], { 1: 5 });
  const b = sandbox.buildBanker(t, t.teams);
  check('one player is not a banker game', b.incomplete, true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
