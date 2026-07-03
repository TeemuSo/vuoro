#!/usr/bin/env node
// vuoro ask — an agent calls this at a decision point. It posts a card to the
// cockpit, then BLOCKS until you answer there, prints your answer, and exits.
// The calling session's turn is paused on this command, so it continues the
// moment you decide. Usage:
//   node ask.mjs "<question>" --why "<one-line>" --options "Approve,Deny" [--context "..."] [--project x]
// Ballot (several calls sharing one context; blocks until ALL are ruled):
//   node ask.mjs "<title>" --why "..." --decision "key|need|optA,optB" --decision "key2|need2|Yes,No"
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const PORT = process.env.VUORO_PORT || 4319;
const BASE = `http://localhost:${PORT}`;
const args = process.argv.slice(2);
const question = args.find((a) => !a.startsWith('--')) || 'Decision needed';
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const why = opt('why', 'Answer to continue the session.');
const context = opt('context', '');
const project = opt('project', '');
const issueId = opt('issue', process.env.VUORO_ISSUE || '');
const options = opt('options', 'Approve,Deny').split(',').map((s) => s.trim()).filter(Boolean);
// repeated --decision "key|need|optA,optB" flags build a ballot
const decisions = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--decision' && args[i + 1]) {
    const [key, need, opts] = args[i + 1].split('|');
    if (key && key.trim()) decisions.push({
      key: key.trim(), need: (need || '').trim() || key.trim(),
      options: (opts || '').split(',').map((s) => s.trim()).filter(Boolean),
    });
  }
}
const cwd = process.cwd();

async function sessionId() {
  if (process.env.CLAUDE_SESSION_ID) return process.env.CLAUDE_SESSION_ID;
  try {
    const dir = join(process.env.HOME, '.claude', 'projects', cwd.replace(/\//g, '-'));
    const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
    let newest = null, mt = 0;
    for (const f of files) { const s = await stat(join(dir, f)); if (s.mtimeMs > mt) { mt = s.mtimeMs; newest = f; } }
    return newest ? newest.replace(/\.jsonl$/, '') : '';
  } catch { return ''; }
}

const sid = await sessionId();
const label = project || cwd.split('/').pop();
let id;
try {
  const r = await fetch(`${BASE}/api/ask`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question, why, context, project, options, decisions, sessionId: sid, cwd, label, issueId }),
  });
  ({ id } = await r.json());
} catch {
  console.error(`vuoro ask: cockpit not reachable at ${BASE} (is it running? node server.mjs)`);
  process.exit(2);
}

const what = decisions.length ? `${decisions.length} calls: "${question}"` : `"${question}"`;
process.stderr.write(`\n⏳ VUORO — waiting for your decision on ${what}\n   Decide it in the cockpit (card ${id}). This session continues once you answer${decisions.length ? ' all of them' : ''}.\n`);
while (true) {
  await new Promise((r) => setTimeout(r, 1500));
  try {
    const j = await (await fetch(`${BASE}/api/answer?cardId=${encodeURIComponent(id)}`)).json();
    if (j.answered) { process.stdout.write(j.verdict + (j.note ? ': ' + j.note : '') + '\n'); process.exit(0); }
  } catch {}
}
