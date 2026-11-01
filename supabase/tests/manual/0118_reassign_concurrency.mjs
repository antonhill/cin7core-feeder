// MANUAL multi-connection concurrency check for migration 0118's customer_rep_reassign (the SQL regression tests in ../*.test.sql are single-session, so they cannot race).
//
// Run it against a THROWAWAY database that has the migrations applied (e.g. a local `supabase start` + `supabase db reset`, never hosted Supabase):
//   npm i --no-save pg && DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres node supabase/tests/manual/0118_reassign_concurrency.mjs
// Every worker is its own connection running AS service_role. It proves (and exits non-zero if not):
//   S1  a competing reassignment WAITS for the first transaction, then loses;
//   S2  many rounds of truly parallel conflicting requests: exactly one success per intended Rep, no duplicate active Rep, the customer never uncovered, unrelated Reps untouched;
//   S3  a plain insert racing a reassignment: the reassignment either commits whole or rolls back whole (the old Rep is kept);
//   S4  requests that fail AFTER the old row was updated are rolled back whole, leaving no trace.
//   every scenario also asserts the durable linkage: the ended row's replaced_by_assignment_id names exactly the winning target's assignment (failed/losing attempts leave none).
// It creates its own organisation/users/customers (tagged per run); the assignment guard forbids deletes, so use a disposable database.
// Real multi-connection concurrency evidence for customer_rep_reassign (migration 0118). Every worker is its own connection running AS service_role.
import pg from "pg";
if (!process.env.DB_URL) { console.error("Set DB_URL to a THROWAWAY database with the migrations applied."); process.exit(2); }
const cfg = { connectionString: process.env.DB_URL };
const ORG = "00000000-0000-0000-0000-00000000c0c1"; const U = Object.fromEntries(["A","B","C","D","E"].map((k, i) => [k, `00000000-0000-0000-0000-00000000c0d${i}`]));
const RUN = Date.now().toString(36); const adm = new pg.Client(cfg); await adm.connect();
for (const id of Object.values(U)) await adm.query("insert into auth.users (id) values ($1) on conflict do nothing", [id]);
await adm.query("insert into organizations (id, name) values ($1, 'Conc Org') on conflict do nothing", [ORG]);
for (const id of Object.values(U)) await adm.query("insert into org_members (org_id, user_id, role) values ($1, $2, 'member') on conflict do nothing", [ORG, id]);
const conn = async () => { const c = new pg.Client(cfg); await c.connect(); await c.query("set role service_role"); return c; };
const assign = (cust, who, email) => adm.query("insert into customer_rep_assignments (org_id, cin7_customer_id, rep_user_id, rep_email, assigned_by_email) values ($1,$2,$3,$4,'mgr@x.test')", [ORG, cust, U[who], email]);
const call = (c, cust, from, to, email = `${to}@x.test`, reason = "concurrency test") =>
  c.query("select customer_rep_reassign($1,$2,'Farm',$3,$4,$5,'mgr@x.test',null,$6) as r", [ORG, cust, U[from], U[to], email, reason]).then((r) => ({ ok: true, created: r.rows[0].r.created }), (e) => ({ ok: false, msg: e.message.replace("customer_rep_reassign: ", "") }));
const rows = async (cust) => (await adm.query("select id, replaced_by_assignment_id, rep_user_id, ended_at, ended_by_email, end_reason, assigned_reason from customer_rep_assignments where org_id=$1 and cin7_customer_id=$2", [ORG, cust])).rows;
const nameOf = (id) => Object.entries(U).find(([, v]) => v === id)[0];
let violations = 0; const bad = (m) => { violations++; console.log("  INVARIANT VIOLATION:", m); };
// The durable linkage: the ended row of `from` must name the exact row of `to` (same customer, still the one active row of that Rep, or the Rep's row at that time).
const linkOf = (rs, from, to) => { const e = rs.find((x) => x.ended_at && nameOf(x.rep_user_id) === from); const t = e && rs.find((x) => x.id === e.replaced_by_assignment_id); return !!t && nameOf(t.rep_user_id) === to && t.id !== e.id; };
const tally = {};
const note = (r) => { const k = r.ok ? (r.created ? "ok(created)" : "ok(existing)") : r.msg.slice(0, 48); tally[k] = (tally[k] ?? 0) + 1; };

// ── S1: deterministic proof that a competing reassignment WAITS for the first transaction ─────────────
{
  const cust = `S1-${RUN}`; await assign(cust, "A", "a@x.test");
  const c1 = await conn(), c2 = await conn();
  await c1.query("begin");
  const r1 = await call(c1, cust, "A", "B");                       // holds the customer lock + row lock until commit
  const t0 = Date.now(); const p2 = call(c2, cust, "A", "C");       // competing request
  await new Promise((r) => setTimeout(r, 1500));
  const stillWaiting = await Promise.race([p2.then(() => false), new Promise((r) => setTimeout(() => r(true), 50))]);
  await c1.query("commit"); const r2 = await p2; const waited = Date.now() - t0;
  const act = (await rows(cust)).filter((x) => !x.ended_at).map((x) => nameOf(x.rep_user_id));
  console.log(`S1 blocking: first=${r1.ok ? "ok" : r1.msg}; competitor still waiting after 1.5s=${stillWaiting}; competitor result="${r2.ok ? "ok" : r2.msg}" after ${waited}ms; active=${JSON.stringify(act)}`);
  if (!stillWaiting) bad("S1 competitor did not wait"); if (r2.ok) bad("S1 competitor must lose"); if (JSON.stringify(act) !== '["B"]') bad("S1 final state");
  if (!linkOf(await rows(cust), "A", "B")) bad("S1 the ended row must name B's assignment as its successor (the loser's target C must not appear)");
  await c1.end(); await c2.end();
}

// ── S2: many rounds of truly parallel, conflicting requests; invariants after every round ─────────────
const ROUNDS = Number(process.env.ROUNDS ?? 150); const clients = await Promise.all(Array.from({ length: 10 }, conn));
for (let i = 0; i < ROUNDS; i++) {
  const cust = `R${i}-${RUN}`; await assign(cust, "A", "a@x.test"); await assign(cust, "B", "b@x.test");     // two active Reps (A, B): unrelated assignment must survive when only A moves
  const jobs = [["A","C"],["A","C"],["A","C"],["A","D"],["A","E"],["A","B"],["A","C","x"],["A","D","x"],["B","C"],["A","C"]];   // "x" = a replacement email that fails the CHECK
  const results = await Promise.all(jobs.map(([f, t, bad_], k) => call(clients[k], cust, f, t, bad_ ? "x" : `${t}@x.test`)));
  results.forEach(note);
  const rs = await rows(cust); const active = rs.filter((x) => !x.ended_at).map((x) => nameOf(x.rep_user_id));
  const okA = results.filter((r, k) => r.ok && jobs[k][0] === "A").length; const okB = results.filter((r, k) => r.ok && jobs[k][0] === "B").length;
  if (okA > 1) bad(`${cust}: ${okA} reassignments of A succeeded`);
  const winA = jobs.find((j, k) => results[k].ok && j[0] === "A"); if (winA && !linkOf(rs, "A", winA[1])) bad(`${cust}: A's ended row does not name the WINNING target ${winA[1]}`);
  const winB = jobs.find((j, k) => results[k].ok && j[0] === "B"); if (winB && !linkOf(rs, "B", winB[1])) bad(`${cust}: B's ended row does not name its target ${winB[1]}`);
  for (const x of rs) if (!x.ended_at && x.replaced_by_assignment_id) bad(`${cust}: an ACTIVE row carries a successor link`);
  for (const x of rs.filter((y) => y.ended_at)) if (!x.replaced_by_assignment_id) bad(`${cust}: an ended row has no successor link`);
  const endedA = rs.filter((x) => x.ended_at && nameOf(x.rep_user_id) === "A").length; if (endedA !== okA) bad(`${cust}: A ended ${endedA} times but ${okA} successes`);
  const endedB = rs.filter((x) => x.ended_at && nameOf(x.rep_user_id) === "B").length; if (endedB !== okB) bad(`${cust}: B ended ${endedB} times but ${okB} successes`);
  if (okA === 0 && !active.includes("A")) bad(`${cust}: A lost its assignment although no reassignment of A succeeded`);
  if (okB === 0 && !active.includes("B")) bad(`${cust}: unrelated Rep B lost its assignment`);
  if (new Set(active).size !== active.length) bad(`${cust}: duplicate active Rep ${active}`);
  if (active.length === 0) bad(`${cust}: customer left with NO Rep`);
  for (const x of rs.filter((y) => y.ended_at)) if (!x.ended_by_email || !x.end_reason) bad(`${cust}: ended row without actor/reason`);
  const unexpected = results.filter((r) => !r.ok && !/not currently assigned|check constraint/.test(r.msg)); if (unexpected.length) bad(`${cust}: unexpected errors ${JSON.stringify(unexpected)}`);
}
console.log(`S2 ${ROUNDS} rounds x 10 parallel conflicting calls: outcomes ${JSON.stringify(tally)}`);

// ── S3: a competing PLAIN insert of the target Rep races the reassignment (the insert path of the function can hit the unique index) ──
{
  let rolledBack = 0, committed = 0;
  for (let i = 0; i < 60; i++) {
    const cust = `P${i}-${RUN}`; await assign(cust, "A", "a@x.test");
    const [r, ins] = await Promise.all([call(clients[0], cust, "A", "C"), adm.query("insert into customer_rep_assignments (org_id, cin7_customer_id, rep_user_id, rep_email, assigned_by_email) values ($1,$2,$3,'c@x.test','mgr@x.test')", [ORG, cust, U.C]).then(() => "ins-ok", (e) => "ins-fail")]);
    const rs = await rows(cust); const active = rs.filter((x) => !x.ended_at).map((x) => nameOf(x.rep_user_id));
    if (new Set(active).size !== active.length) bad(`${cust}: duplicate active ${active}`);
    if (r.ok) { committed++; if (active.includes("A")) bad(`${cust}: reassignment committed but A still active`); if (!linkOf(rs, "A", "C")) bad(`${cust}: committed reassignment must name C's assignment`); }
    else { rolledBack++; if (!active.includes("A")) bad(`${cust}: reassignment FAILED (${r.msg}) but A lost its assignment`); if (rs.some((x) => x.replaced_by_assignment_id)) bad(`${cust}: a rolled-back reassignment left a successor link`); }
    if (active.length === 0) bad(`${cust}: customer with no Rep`);
  }
  console.log(`S3 reassign vs plain insert, 60 rounds: reassignment committed=${committed}, rolled back whole=${rolledBack}`);
}

// ── S4: FAILURE INJECTION under concurrency: several requests fail AFTER the old row was updated (bad replacement email), racing one valid request, in random order ──
{
  let failedWhole = 0, winners = 0; const stats = {};
  for (let i = 0; i < 120; i++) {
    const cust = `F${i}-${RUN}`; await assign(cust, "A", "a@x.test"); await assign(cust, "B", "b@x.test");
    const jobs = [...Array(5).fill(["A", "C", "x"]), ["A", "D"]].sort(() => Math.random() - 0.5);
    const results = await Promise.all(jobs.map(([f, t, badEmail], k) => call(clients[k], cust, f, t, badEmail ? "x" : `${t}@x.test`)));
    results.forEach((r) => { const k = r.ok ? "ok" : r.msg.slice(0, 40); stats[k] = (stats[k] ?? 0) + 1; });
    const rs = await rows(cust); const active = rs.filter((x) => !x.ended_at).map((x) => nameOf(x.rep_user_id));
    const wins = results.filter((r) => r.ok).length; winners += wins; failedWhole += results.filter((r) => !r.ok && /check constraint/.test(r.msg)).length;
    if (wins !== 1) bad(`${cust}: expected exactly 1 success, got ${wins}`);
    if (!linkOf(rs, "A", "D")) bad(`${cust}: A's ended row must name D's assignment (failed attempts must leave no link)`);
    if (rs.filter((x) => x.replaced_by_assignment_id).length !== 1) bad(`${cust}: exactly one row may carry a successor link`);
    if (!active.includes("B")) bad(`${cust}: unrelated Rep B was affected`);
    if (!active.includes("D") || active.includes("A") || active.includes("C")) bad(`${cust}: final active set ${active} (expected B and D only)`);
    if (rs.filter((x) => x.ended_at && nameOf(x.rep_user_id) === "A").length !== 1) bad(`${cust}: A must be ended exactly once (failed attempts leave no trace)`);
    if (rs.length !== 3) bad(`${cust}: ${rs.length} history rows (expected A ended, B, D)`);
  }
  console.log(`S4 failure injection, 120 random-order rounds: ${winners} successes, ${failedWhole} calls failed AFTER updating the old row and were rolled back whole; outcomes ${JSON.stringify(stats)}`);
}
for (const c of clients) await c.end(); await adm.end();
console.log(violations === 0 ? "RESULT: 0 invariant violations" : `RESULT: ${violations} INVARIANT VIOLATIONS`);
process.exit(violations === 0 ? 0 : 1);
