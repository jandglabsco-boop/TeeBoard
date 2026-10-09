// The JS format list and the formats table must agree.
//
// They live in different places and have drifted three times: match play was
// rejected by a CHECK constraint, then scored as a team because the function
// had its own list, then group stroke play was rejected on insert. The table
// is now the source of truth for the database; this asserts the client still
// matches it, since nothing else can.
const fs = require('fs'), vm = require('vm'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

const sandbox = { window:{addEventListener(){},TEEBOARD_CONFIG:{}},
  document:{getElementById:()=>null,querySelectorAll:()=>[],addEventListener(){},createElement:()=>({})},
  location:{hash:''}, navigator:{onLine:true}, console, setTimeout, setInterval:()=>0,
  clearInterval(){}, clearTimeout(){}, fetch:()=>Promise.reject(new Error('no network')),
  localStorage:{getItem:()=>null,setItem(){},removeItem(){}} };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
// A top-level const is not a property of the context, so ask for it directly.
const FORMATS = vm.runInContext('FORMATS', sandbox);

// Mirrors public.formats. Update together with the migration.
const DB = {
  scramble: false, alt_shot: false, best_ball: true, stroke: true,
  stableford: true, skins: true,
  match_singles: true, match_fourball: true, match_foursomes: false,
  stroke_singles: true, stroke_fourball: true, stroke_foursomes: false,
  banker: true, stroke_group: true,
};

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`);
};

check('same formats on both sides',
  Object.keys(FORMATS).sort(), Object.keys(DB).sort());

for (const [code, f] of Object.entries(FORMATS)) {
  if (!(code in DB)) continue;
  check(`${code}: per-player flag agrees`, f.scoring === 'player', DB[code]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
