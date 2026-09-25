const fs = require('fs');
let src = fs.readFileSync('app.js', 'utf8');
// strip browser-only bootstrap; we only want the pure scoring functions
global.window = { addEventListener(){}, TEEBOARD_CONFIG:{} };
global.document = { getElementById: () => null, querySelectorAll: () => [], addEventListener(){} };
global.location = { hash: '' };
global.navigator = { onLine: true };
const ctx = {};
const fns = ['FORMATS','formatOf','strokeAllocation','buildMatch','matchResultLabel','matchAllocations','sideNetOnHole','isMatchFormat'];
// evaluate the file in a sandbox that tolerates missing DOM
const vm = require('vm');
const sandbox = { window: global.window, document: global.document, location: global.location,
                  navigator: global.navigator, console, setTimeout, fetch: () => Promise.reject(),
                  localStorage: {getItem:()=>null,setItem(){},removeItem(){}} };
vm.createContext(sandbox);
try { vm.runInContext(src, sandbox); } catch (e) { /* DOM bits may throw; functions are still defined */ }

const T = (holes, si) => ({ num_holes: holes, handicap: si, par: Array(holes).fill(4) });
const side = (id, name, players, signed) => ({ id, name, team_members: players.map(p=>({id:p.id,player_name:p.name,handicap:p.hc})),
  scores: players.flatMap(p => Object.entries(p.s||{}).map(([h,v]) => ({hole_number:+h, strokes:v, team_member_id:p.id}))), signed_at: signed?'x':null });

let pass=0, fail=0;
const check = (label, got, want) => { const ok = got===want; ok?pass++:fail++;
  console.log(`${ok?'PASS':'FAIL'}  ${label}\n      got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`); };

const si9 = [1,2,3,4,5,6,7,8,9];

// --- 1. scratch singles, A wins holes 1,2,3 then all halved -> 3 & 6? no: 3up with 6 left, not closed
{
  const a = {id:'a',name:'Gabe',hc:0,s:{1:3,2:3,3:3,4:4,5:4,6:4,7:4,8:4,9:4}};
  const b = {id:'b',name:'Roland',hc:0,s:{1:4,2:4,3:4,4:4,5:4,6:4,7:4,8:4,9:4}};
  const m = sandbox.buildMatch({...T(9,si9), format:'match_singles'}, [side('A','A',[a]), side('B','B',[b])]);
  check('3 up with 2 to play closes the match -> "3 & 2"', m.label, '3 & 2');
  check('  leader is Gabe side', m.leader.name, 'A');
}

// --- 2. closed out: A wins first 5 of 9 -> 5 up with 4 to play = "5 & 4"
{
  const a = {id:'a',name:'A',hc:0,s:{1:3,2:3,3:3,4:3,5:3}};
  const b = {id:'b',name:'B',hc:0,s:{1:4,2:4,3:4,4:4,5:4}};
  const m = sandbox.buildMatch({...T(9,si9), format:'match_singles'}, [side('A','A',[a]), side('B','B',[b])]);
  check('closed out 5 up with 4 left -> "5 & 4"', m.label, '5 & 4');
  check('  closedOnHole', m.closedOnHole, 5);
  check('  done', m.done, true);
}

// --- 3. all square
{
  const a = {id:'a',name:'A',hc:0,s:Object.fromEntries([...Array(9)].map((_,i)=>[i+1,4]))};
  const b = {id:'b',name:'B',hc:0,s:Object.fromEntries([...Array(9)].map((_,i)=>[i+1,4]))};
  const m = sandbox.buildMatch({...T(9,si9), format:'match_singles'}, [side('A','A',[a]), side('B','B',[b])]);
  check('all halved -> "A/S"', m.label, 'A/S');
  check('  no leader', m.leader, null);
}

// --- 4. POPS: B is 9 handicap over 9 holes (plays 4.5 -> 5 shots), A scratch.
// Gross tie on a hole where B gets a pop should be a B win.
{
  const a = {id:'a',name:'A',hc:0,s:{1:4}};
  const b = {id:'b',name:'B',hc:9,s:{1:4}};
  const m = sandbox.buildMatch({...T(9,si9), format:'match_singles'}, [side('A','A',[a]), side('B','B',[b])]);
  const h1 = m.holes[0];
  check('pops: gross 4v4 on SI-1 hole, B gets a shot -> B wins hole', h1.winner, 1);
  check('  B net on hole 1', h1.netB, 3);
}

// --- 5. pops come from the DIFFERENCE, not full handicaps
{
  const a = {id:'a',name:'A',hc:10,s:{1:4}};
  const b = {id:'b',name:'B',hc:10,s:{1:4}};
  const m = sandbox.buildMatch({...T(9,si9), format:'match_singles'}, [side('A','A',[a]), side('B','B',[b])]);
  check('equal handicaps -> nobody gets a shot, hole halved', m.holes[0].winner, null);
}

// --- 6. four-ball: side takes the BETTER net of the pair
{
  const a1 = {id:'a1',name:'A1',hc:0,s:{1:6}};
  const a2 = {id:'a2',name:'A2',hc:0,s:{1:4}};
  const b1 = {id:'b1',name:'B1',hc:0,s:{1:5}};
  const b2 = {id:'b2',name:'B2',hc:0,s:{1:5}};
  const m = sandbox.buildMatch({...T(9,si9), format:'match_fourball'}, [side('A','A',[a1,a2]), side('B','B',[b1,b2])]);
  check('four-ball takes better ball: A 4 beats B 5', m.holes[0].winner, 0);
  check('  A side net on hole', m.holes[0].netA, 4);
}

// --- 7. incomplete match (only one side set up)
{
  const a = {id:'a',name:'A',hc:0,s:{}};
  const m = sandbox.buildMatch({...T(9,si9), format:'match_singles'}, [side('A','A',[a])]);
  check('one side only -> incomplete', m.incomplete, true);
}

// --- 8. unplayed holes don't count
{
  const a = {id:'a',name:'A',hc:0,s:{1:3}};
  const b = {id:'b',name:'B',hc:0,s:{1:4}};
  const m = sandbox.buildMatch({...T(9,si9), format:'match_singles'}, [side('A','A',[a]), side('B','B',[b])]);
  check('1 of 9 played -> played=1', m.played, 1);
  check('  label "1 up" (not closed)', m.label, '1 up');
  check('  not done', m.done, false);
}

// --- 9. REGRESSION: holes entered after the close must not change the result.
// A is 3 up after 7 (closed, "3 & 2"). Scores exist for 8 and 9 where A loses
// both. The match ended at 7; the result must still be 3 & 2, not 1 up.
{
  const a = {id:'a',name:'A',hc:0,s:{1:3,2:3,3:3,4:4,5:4,6:4,7:4,8:6,9:6}};
  const b = {id:'b',name:'B',hc:0,s:{1:4,2:4,3:4,4:4,5:4,6:4,7:4,8:4,9:4}};
  const m = sandbox.buildMatch({...T(9,si9), format:'match_singles'}, [side('A','A',[a]), side('B','B',[b])]);
  check('scores after the close do not change the result', m.label, '3 & 2');
  check('  closed on hole 7', m.closedOnHole, 7);
  check('  leader still A', m.leader.name, 'A');
}


// ---- plus handicaps ----
{
  const T9 = { num_holes: 9, handicap: [1,2,3,4,5,6,7,8,9], par: Array(9).fill(4) };
  // +4 over 9 holes plays 2: gives a stroke back on the two hardest holes.
  const a = sandbox.strokeAllocation(T9, -4);
  check('plus 4 over 9 holes gives back 2 strokes', a.filter(v => v === -1).length, 2);
  check('  on the two hardest holes (SI 1 and 2)', [a[0], a[1]].join(','), '-1,-1');
  check('  and nothing on the rest', a.slice(2).every(v => v === 0), true);

  // scratch is unchanged
  check('scratch gets nothing', sandbox.strokeAllocation(T9, 0).every(v => v === 0), true);

  // a plus player in a match becomes the reference: the other side gets the gap
  const side = (id,name,players,signed) => ({ id, name,
    team_members: players.map(p=>({id:p.id,player_name:p.name,handicap:p.hc})),
    scores: players.flatMap(p => Object.entries(p.s||{}).map(([h,v]) => ({hole_number:+h, strokes:v, team_member_id:p.id}))),
    signed_at: signed?'x':null });
  const pro  = {id:'p',name:'Pro',hc:-2,s:{1:4}};
  const hack = {id:'h',name:'Hack',hc:16,s:{1:4}};
  const m = sandbox.buildMatch({...T9, format:'match_singles'}, [side('A','A',[pro]), side('B','B',[hack])]);
  check('vs a +2, an 18-diff still allocates to the higher handicap', m.holes[0].winner, 1);
  check('  plus player plays off scratch in the match (net = gross)', m.holes[0].netA, 4);
}

console.log(`\n${pass} passed, ${fail} failed`);
