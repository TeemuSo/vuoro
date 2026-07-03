#!/usr/bin/env node
// vuoro proof — attach an e2e result to an issue. Usually you don't call this
// directly: an e2e harness with a webhook setting auto-posts to /api/proof. Use
// it to attach a run by hand:
//   node proof.mjs --issue <id> --test vuoro-system-panel --verdict WORKING --run <runId>
const PORT = process.env.VUORO_PORT || 4319;
const BASE = `http://localhost:${PORT}`;
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const issueId = opt('issue', process.env.VUORO_ISSUE || '');
if (!issueId) { console.error('vuoro proof: need --issue <id> (or export VUORO_ISSUE)'); process.exit(1); }

const body = {
  issueId,
  test: opt('test', ''),
  verdict: opt('verdict', 'INCONCLUSIVE'),
  runId: opt('run', ''),
  url: opt('url', ''),
};
try {
  const r = await fetch(`${BASE}/api/proof`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!j.ok) { console.error('vuoro proof:', j.error || 'failed'); process.exit(1); }
  console.log(`proof (${body.verdict}) attached to issue ${issueId}`);
} catch {
  console.error(`vuoro proof: cockpit not reachable at ${BASE}`);
  process.exit(2);
}
