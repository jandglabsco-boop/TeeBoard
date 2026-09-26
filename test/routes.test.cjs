// Route table checks.
//
// The stats range buttons link to "#/stats?days=90". The route was anchored
// as /^#\/stats$/, which cannot match a query string, so every one of those
// links fell through the whole table to the viewHome() fallback — the page
// appeared to throw the user out. Anchored routes and querystring links are
// easy to add independently, so this asserts they still agree.
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'app.js'), 'utf8');

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = got === want; ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`);
};

// Every route regex in the table, in order.
const routeRes = [...src.matchAll(/\{ re: (\/\^#[^,]*?\/), view:/g)].map(m => m[1]);
check('route table parsed', routeRes.length > 15, true);

const resolves = (hash) => {
  for (const r of routeRes) {
    if (new RegExp(eval(r).source).test(hash)) return r;
  }
  return null;                       // would fall through to viewHome()
};

// Every link the app itself renders must resolve to something.
const links = [...src.matchAll(/href="(#\/[^"$]*\?[^"]*)"/g)].map(m => m[1]);
for (const raw of links) {
  const concrete = raw.replace(/\$\{[^}]*\}/g, '90');
  check(`app link resolves: ${concrete}`, resolves(concrete) !== null, true);
}

for (const d of [7, 30, 90]) {
  check(`#/stats?days=${d} resolves`, resolves(`#/stats?days=${d}`) !== null, true);
}
check('#/stats still resolves', resolves('#/stats') !== null, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
