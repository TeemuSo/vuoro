#!/usr/bin/env node
// vuoro complete — an agent calls this when it believes an issue is done. It
// records "agent marked complete" on the issue, which makes VUORO surface an
// acceptance card (with the e2e proof as evidence) for the human to rule on.
//   node complete.mjs [--issue <id>]     (defaults to $VUORO_ISSUE)
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const PORT = process.env.VUORO_PORT || 4319;
const BASE = `http://localhost:${PORT}`;
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const issueId = opt('issue', process.env.VUORO_ISSUE || '');
if (!issueId) { console.error('vuoro complete: need --issue <id> (or export VUORO_ISSUE)'); process.exit(1); }

async function sessionId() {
  if (process.env.CLAUDE_SESSION_ID) return process.env.CLAUDE_SESSION_ID;
  try {
    const dir = join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/\//g, '-'));
    const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
    let newest = null, mt = 0;
    for (const f of files) { const s = await stat(join(dir, f)); if (s.mtimeMs > mt) { mt = s.mtimeMs; newest = f; } }
    return newest ? newest.replace(/\.jsonl$/, '') : '';
  } catch { return ''; }
}

try {
  const r = await fetch(`${BASE}/api/complete`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ issueId, sessionId: await sessionId() }),
  });
  const j = await r.json();
  if (!j.ok) { console.error('vuoro complete:', j.error || 'failed'); process.exit(1); }
  console.log(`marked complete → acceptance card raised for issue ${issueId}`);
} catch {
  console.error(`vuoro complete: cockpit not reachable at ${BASE}`);
  process.exit(2);
}
