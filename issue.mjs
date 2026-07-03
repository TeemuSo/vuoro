#!/usr/bin/env node
// vuoro issue — create or list issues. An issue is the seed an agent works:
// a title + description. Decisions and proof link back to it by id.
//   node issue.mjs "Add dark mode" --desc "..." [--project vuoro] [--test dark-mode]
//   node issue.mjs --list
// Prints the new issue id to stdout, so an agent can bind to it:
//   export VUORO_ISSUE=$(node issue.mjs "..." --desc "...")
const PORT = process.env.VUORO_PORT || 4319;
const BASE = `http://localhost:${PORT}`;
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes('--' + k);

async function main() {
  if (has('list')) {
    const j = await (await fetch(`${BASE}/api/state`)).json();
    for (const i of j.issues || []) {
      console.log(`${i.state.padEnd(16)} ${i.openCount ? `(${i.openCount} open) ` : ''}${i.proof ? `[${i.proof.verdict}] ` : ''}${i.title}   ${i.id}`);
    }
    return;
  }
  const title = args.find((a) => !a.startsWith('--'));
  if (!title) { console.error('usage: node issue.mjs "<title>" --desc "..." [--project x] [--test <launchproof-test>]'); process.exit(1); }
  const body = {
    title,
    description: opt('desc', opt('description', '')),
    project: opt('project', ''),
    acceptanceTest: opt('test', null),
    agentSessionId: opt('agent-session', process.env.CLAUDE_SESSION_ID || null),
    agentCwd: opt('agent-cwd', process.cwd()),
    agentLabel: opt('agent-label', ''),
  };
  try {
    const r = await fetch(`${BASE}/api/issues`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!j.ok) { console.error('vuoro issue:', j.error || 'failed'); process.exit(1); }
    console.log(j.id);
  } catch {
    console.error(`vuoro issue: cockpit not reachable at ${BASE} (is it running? node server.mjs)`);
    process.exit(2);
  }
}
main();
