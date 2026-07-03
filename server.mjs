// VUORO cockpit — one surface for the decisions a fleet of AI agents surfaces to you.
// Zero dependencies: pure Node stdlib. Run: node server.mjs
import { createServer } from 'node:http';
import { readFile, writeFile, readdir, stat, open, appendFile, mkdir, unlink, realpath } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { join, resolve, dirname, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { totalmem, freemem, loadavg, cpus, platform, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const pexec = promisify(execFile);
const DIR = dirname(fileURLToPath(import.meta.url));
// config.json is optional: without it the cockpit boots on defaults — Claude Code
// sessions from ~/.claude/projects, no GitHub repos, evidence readable under $HOME.
let userConfig = {};
try { userConfig = JSON.parse(await readFile(join(DIR, 'config.json'), 'utf8')); } catch {}
const CONFIG = { sessionsRoot: join(homedir(), '.claude', 'projects'), shotRoots: [homedir()], ...userConfig };
const PORT = process.env.VUORO_PORT || CONFIG.port || 4319;
const LEDGER = join(DIR, 'ledger.jsonl');
const INBOX = join(DIR, 'cards');
const ISSUES = join(DIR, 'issues');
const IGNORE = (CONFIG.ignoreChecks || []).map((s) => s.toLowerCase());
const RANK = { now: 0, soon: 1, later: 2, watch: 3 };
const PROOF_DASHBOARD = CONFIG.proofDashboard || 'http://localhost:4321';
await mkdir(INBOX, { recursive: true });
await mkdir(ISSUES, { recursive: true });

// ttyd-backed embedded terminals (optional: brew install ttyd)
const TERMS = new Map(); // sessionId -> { port, proc }
let TTYD_OK = false;
try { await pexec('ttyd', ['--version'], { timeout: 4000 }); TTYD_OK = true; } catch {}
let nextTermPort = 4331;
// ttyd runs detached in its own process group so this reaches its zsh/claude
// children too — claude ignores the SIGHUP a plain pty close would send.
function killTerms() { for (const { proc } of TERMS.values()) { try { process.kill(-proc.pid, 'SIGTERM'); } catch { try { proc.kill('SIGTERM'); } catch {} } } }
process.on('exit', () => { killTerms(); drainDeliveriesSync(); });
process.on('SIGINT', () => { killTerms(); drainDeliveriesSync(); process.exit(0); });
process.on('SIGTERM', () => { killTerms(); drainDeliveriesSync(); process.exit(0); });

let cache = { at: 0, data: null };

// ---------- GitHub (live cards) ----------
async function gh(args) {
  try {
    const { stdout } = await pexec('gh', args, { maxBuffer: 16 * 1024 * 1024, timeout: 20000 });
    return JSON.parse(stdout || 'null');
  } catch (e) {
    return { __error: (e.stderr && e.stderr.toString()) || e.message };
  }
}

function analyzeChecks(rollup) {
  const fails = [];
  const pend = [];
  let pass = 0;
  for (const c of rollup || []) {
    const name = c.name || c.context || 'check';
    const s = (c.conclusion || c.state || '').toUpperCase();
    if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(s)) fails.push(name);
    else if (['SUCCESS', 'NEUTRAL', 'SKIPPED', 'COMPLETED'].includes(s)) pass++;
    else pend.push(name);
  }
  const realFails = fails.filter((n) => !IGNORE.includes(String(n).toLowerCase()));
  return { pass, fails, pend, realFails };
}

async function liveCards() {
  const cards = [];
  for (const repo of CONFIG.repos || []) {
    const prs = await gh(['pr', 'list', '-R', repo.slug, '--state', 'open', '--json',
      'number,title,headRefName,baseRefName,url,statusCheckRollup,updatedAt,labels']);
    if (prs && prs.__error) {
      cards.push({
        id: `${repo.name}-gh-error`, project: repo.name, type: 'info', urgency: 'later',
        title: `Could not read ${repo.slug} PRs`, need: 'Check that `gh` is authed.',
        whoWhat: 'GitHub query failed.', body: prs.__error, evidence: [], actions: [],
      });
      continue;
    }
    for (const pr of prs || []) {
      if (repo.deliveryBranch && pr.baseRefName !== repo.deliveryBranch) continue;
      const a = analyzeChecks(pr.statusCheckRollup);
      const labels = (pr.labels || []).map((l) => l.name);
      const hot = labels.some((l) => /security|launch-blocker|payments/i.test(l));
      let need, urgency, verdict;
      if (a.pend.length) { need = 'Waiting on CI / agent — not ready for you yet.'; urgency = 'watch'; verdict = 'in-flight'; }
      else if (a.realFails.length) { need = `CI red (${a.realFails.join(', ')}) — agent should iterate or bounce.`; urgency = hot ? 'now' : 'soon'; verdict = 'not-ready'; }
      else { need = 'Evidence green — review, then merge or bounce.'; urgency = hot ? 'now' : 'soon'; verdict = 'ready'; }
      const ignoredNote = a.fails.filter((n) => IGNORE.includes(String(n).toLowerCase()));
      cards.push({
        id: `${repo.name}-pr-${pr.number}`, project: repo.name, type: 'review', urgency, verdict,
        source: { kind: 'pr', label: `PR #${pr.number}`, repo: repo.slug, pr: pr.number },
        title: `PR #${pr.number}: ${pr.title}`, need,
        whoWhat: `${pr.headRefName} → ${pr.baseRefName} · ${a.pass}✓ ${a.realFails.length}✗ ${a.pend.length}…` +
          (ignoredNote.length ? ` · ignoring ${ignoredNote.join(',')} (#199)` : ''),
        body: '', labels,
        evidence: [
          { kind: 'diff', label: 'Eyeball the code diff', repo: repo.name, pr: pr.number },
          { kind: 'link', label: `Open PR #${pr.number} on GitHub`, value: pr.url },
        ],
        actions: [
          { label: `Copy: merge to ${pr.baseRefName}`, kind: 'copy', value: `gh pr merge ${pr.number} -R ${repo.slug} --squash` },
          { label: 'Verdict: looks good (record)', kind: 'verdict', value: 'ship' },
          { label: 'Verdict: bounce to agent', kind: 'verdict', value: 'bounce' },
        ],
        updatedAt: pr.updatedAt,
      });
    }
  }
  return cards;
}

// ---------- Claude Code sessions ----------
function decodeProject(d) {
  const parts = d.split('-Projects-');
  if (parts[1]) return parts[1].replace(/-/g, '/');
  return d.replace(/^-/, '').replace(/-/g, '/');
}
function extractText(o) {
  const m = o && o.message;
  if (!m) return '';
  const c = m.content;
  if (typeof c === 'string') return c.replace(/\s+/g, ' ').trim();
  if (Array.isArray(c)) for (const p of c) if (p && p.type === 'text' && p.text) return p.text.replace(/\s+/g, ' ').trim();
  return '';
}
async function tailInfo(file) {
  const res = { preview: '', cwd: '' };
  try {
    const fh = await open(file, 'r');
    const st = await fh.stat();
    const len = Math.min(st.size, 65536);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, st.size - len);
    await fh.close();
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const o = JSON.parse(lines[i]);
        if (!res.cwd && o && typeof o.cwd === 'string') res.cwd = o.cwd;
        if (!res.preview) { const t = extractText(o); if (t) res.preview = t.slice(0, 160); }
        if (res.preview && res.cwd) break;
      } catch {}
    }
  } catch {}
  return res;
}
// Threads the human trashed from the list: sid -> hiddenAt ms. A hidden thread
// reappears automatically if it sees activity NEWER than the hide (like
// recurring cards); its transcript is never touched.
const HIDDEN_FILE = join(DIR, 'threads-hidden.json');
async function loadHidden() { try { return JSON.parse(await readFile(HIDDEN_FILE, 'utf8')) || {}; } catch { return {}; } }
// Live `claude` processes attributable to a session id — ones whose argv names
// it (`--resume <sid>` / `--session-id <sid>`). Sessions started bare can't be
// attributed this way; cockpit terminals and wakes are tracked directly.
async function claudePidsBySid(sids) {
  const map = {};
  if (!sids.length) return map;
  try {
    const { stdout } = await pexec('ps', ['-axo', 'pid=,args='], { maxBuffer: 8 * 1024 * 1024, timeout: 5000 });
    for (const line of stdout.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (!m || !/(^|\/)claude(\s|$)/.test(m[2])) continue;
      for (const sid of sids) if (m[2].includes(sid)) (map[sid] ||= []).push(Number(m[1]));
    }
  } catch {}
  return map;
}
async function sessions() {
  const root = CONFIG.sessionsRoot;
  const out = [];
  let dirs = [];
  try { dirs = await readdir(root); } catch { return out; }
  for (const d of dirs) {
    const dir = join(root, d);
    let files = [];
    try { files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    let latest = 0, latestFile = null;
    for (const f of files) {
      try { const s = await stat(join(dir, f)); if (s.mtimeMs > latest) { latest = s.mtimeMs; latestFile = join(dir, f); } } catch {}
    }
    if (!latestFile) continue;
    const ageMin = (Date.now() - latest) / 60000;
    if (ageMin > 60 * 24) continue;
    const info = await tailInfo(latestFile);
    out.push({
      project: decodeProject(d), lastActive: latest, ageMin: Math.round(ageMin),
      active: ageMin <= 20, sessions: files.length, preview: info.preview,
      sessionId: basename(latestFile, '.jsonl'), cwd: info.cwd,
    });
  }
  const hidden = await loadHidden();
  const rows = out.filter((s) => !(hidden[s.sessionId] && s.lastActive <= hidden[s.sessionId]));
  const bySid = await claudePidsBySid(rows.map((r) => r.sessionId));
  for (const r of rows) {
    const t = TERMS.get(r.sessionId);
    r.liveProcs = (bySid[r.sessionId] || []).length;
    r.term = !!(t && t.proc.exitCode === null);
    r.waking = WAKES.has(r.sessionId);
  }
  rows.sort((a, b) => b.lastActive - a.lastActive);
  return rows;
}
// Stop everything live that belongs to a session: the cockpit's ttyd terminal
// (whole process group), an in-flight background wake, and any `claude`
// process whose argv names the sid. SIGTERM first, SIGKILL 3s later if it
// ignored it (interactive claude ignores SIGHUP; don't trust it with TERM).
function killHard(target) {
  try { process.kill(target, 'SIGTERM'); } catch { return false; }
  setTimeout(() => { try { process.kill(target, 'SIGKILL'); } catch {} }, 3000).unref();
  return true;
}
async function stopThread(sid, { onlyTerm = false } = {}) {
  let killed = 0;
  const t = TERMS.get(sid);
  if (t && t.proc.exitCode === null && killHard(-t.proc.pid)) killed++;
  TERMS.delete(sid);
  if (onlyTerm) return killed;
  const w = WAKES.get(sid);
  if (w && killHard(-w.pid)) killed++;
  WAKES.delete(sid);
  const bySid = await claudePidsBySid([sid]);
  for (const pid of bySid[sid] || []) if (killHard(pid)) killed++;
  return killed;
}

// ---------- System stats (are we running too many sessions?) ----------
// macOS os.freemem() only counts truly-free pages (~0), so it reads as "full"
// even when memory is fine. memory_pressure gives the real free percentage.
async function claudeFootprint() {
  // Count live `claude` CLI processes and their combined resident memory.
  try {
    const { stdout } = await pexec('ps', ['-axo', 'rss=,comm='], { maxBuffer: 8 * 1024 * 1024, timeout: 5000 });
    let procs = 0, rssKB = 0;
    for (const line of stdout.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!m) continue;
      if ((m[2].split('/').pop() || '') === 'claude') { procs++; rssKB += parseInt(m[1], 10); }
    }
    return { procs, rssKB };
  } catch { return { procs: null, rssKB: 0 }; }
}
async function freePercent() {
  if (platform() === 'darwin') {
    try {
      const { stdout } = await pexec('memory_pressure', [], { timeout: 4000 });
      const m = stdout.match(/free percentage:\s*(\d+)%/i);
      if (m) return Number(m[1]);
    } catch {}
  }
  const total = totalmem();
  return total ? Math.round((freemem() / total) * 100) : null;
}
async function systemStats() {
  const [claude, memFreePct] = await Promise.all([claudeFootprint(), freePercent()]);
  return {
    total: totalmem(),
    cores: cpus().length,
    load1: loadavg()[0],
    memFreePct,
    claudeProcs: claude.procs,
    claudeRssKB: claude.rssKB,
  };
}

// ---------- Coalesced delivery (verdicts ride back to the source session) ----------
// A ruling on a session-sourced card is delivered by waking that session in
// the BACKGROUND: `claude -p --resume <sid> "<message>"` appends the human's
// message to the same session transcript and runs the agent's next turn
// headlessly — no terminal window ever opens. The woken turn runs with
// --permission-mode delivery.permissionMode (default acceptEdits) and its
// output lands in deliveries/<stamp>-<sid>.log plus a delivery-result ledger
// event. Deliveries are grouped per sessionId and debounced by
// delivery.coalesceSeconds (default 120; 0 delivers each ruling at once),
// so several rulings from one sitting land as ONE wake, not many. Blocking
// asks never enter this queue: their session is paused on ask.mjs and picks
// the answer up from /api/answer the moment it exists.
const DELIVERIES = new Map(); // sessionId -> { cwd, items: [text], timer }
const WAKES = new Map(); // sessionId -> in-flight background-wake child process
const DELIVERY_LOGS = join(DIR, 'deliveries');
function deliveryConf() {
  const d = CONFIG.delivery || {};
  return {
    coalesceSeconds: process.env.VUORO_COALESCE_SECONDS != null
      ? Number(process.env.VUORO_COALESCE_SECONDS) : (d.coalesceSeconds ?? 120),
    dryRun: process.env.VUORO_DELIVERY_DRYRUN != null
      ? process.env.VUORO_DELIVERY_DRYRUN !== '0' : !!d.dryRun,
    permissionMode: process.env.VUORO_DELIVERY_PERMISSION_MODE || d.permissionMode || 'acceptEdits',
    claudeBin: process.env.VUORO_CLAUDE_BIN || d.claudeBin || 'claude',
  };
}
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
// The interactive form — only ever printed as the run-by-hand remedy when a
// background wake fails or the server stops inside a coalesce window.
function deliveryCommand(sid, cwd, message) {
  return (cwd ? `cd ${shq(cwd)} && ` : '') + `claude --resume ${sid} ${shq(message)}`;
}
function enqueueDelivery(src, text) {
  const sid = String((src && src.sessionId) || '');
  if (!/^[0-9a-fA-F-]{8,}$/.test(sid)) return;
  let q = DELIVERIES.get(sid);
  if (!q) { q = { cwd: String(src.cwd || ''), items: [], timer: null }; DELIVERIES.set(sid, q); }
  q.items.push(text);
  if (q.timer) clearTimeout(q.timer);
  const wait = deliveryConf().coalesceSeconds;
  if (wait > 0) { q.timer = setTimeout(() => { flushDelivery(sid).catch(() => {}); }, wait * 1000); return; }
  return flushDelivery(sid);
}
async function flushDelivery(sid) {
  const q = DELIVERIES.get(sid);
  if (!q || !q.items.length) return;
  DELIVERIES.delete(sid);
  if (q.timer) clearTimeout(q.timer);
  const conf = deliveryConf();
  const message = q.items.join('\n');
  const command = deliveryCommand(sid, q.cwd, message);
  const entry = { t: new Date().toISOString(), kind: 'delivery', sessionId: sid, cards: q.items.length, message };
  try {
    if (conf.dryRun) { entry.dry = true; entry.command = command; console.log(`[delivery DRY] would wake ${sid.slice(0, 8)} headless; interactive equivalent: ${command}`); }
    else {
      await mkdir(DELIVERY_LOGS, { recursive: true });
      const logFile = join(DELIVERY_LOGS, `${entry.t.replace(/[:.]/g, '-')}-${sid.slice(0, 8)}.log`);
      const fh = await open(logFile, 'a');
      const args = ['-p', '--resume', sid, '--output-format', 'json'];
      if (conf.permissionMode && conf.permissionMode !== 'default') args.push('--permission-mode', conf.permissionMode);
      args.push(message);
      const child = spawn(conf.claudeBin, args, { cwd: q.cwd || DIR, detached: true, stdio: ['ignore', fh.fd, fh.fd] });
      child.unref();
      await fh.close();
      WAKES.set(sid, child);
      let errored = false;
      child.on('error', (e) => {
        errored = true;
        WAKES.delete(sid);
        appendFile(LEDGER, JSON.stringify({ t: new Date().toISOString(), kind: 'delivery-result', sessionId: sid, ok: false, error: e.message, command }) + '\n').catch(() => {});
        console.error(`[delivery] could not start ${conf.claudeBin} for ${sid.slice(0, 8)}: ${e.message}. Run by hand: ${command}`);
      });
      child.on('exit', (code) => {
        WAKES.delete(sid);
        if (errored) return;
        appendFile(LEDGER, JSON.stringify({ t: new Date().toISOString(), kind: 'delivery-result', sessionId: sid, ok: code === 0, code, log: logFile }) + '\n').catch(() => {});
        console.log(`[delivery] ${sid.slice(0, 8)} finished its woken turn (exit ${code}) → ${logFile}`);
      });
      entry.ok = true; entry.pid = child.pid; entry.log = logFile; entry.permissionMode = conf.permissionMode;
      console.log(`[delivery] waking ${sid.slice(0, 8)} in the background (${q.items.length} ruling${q.items.length > 1 ? 's' : ''}) → ${logFile}`);
    }
  } catch (e) {
    entry.ok = false; entry.error = e.message; entry.command = command;
    console.error(`[delivery] failed for ${sid.slice(0, 8)}: ${e.message}. Run by hand: ${command}`);
  }
  try { await appendFile(LEDGER, JSON.stringify(entry) + '\n'); } catch {}
}
// If the server stops while a coalesce window is open, write the pending
// command to the ledger so nothing is silently lost (the verdicts themselves
// are already in the ledger regardless).
function drainDeliveriesSync() {
  for (const [sid, q] of DELIVERIES) {
    if (!q.items.length) continue;
    if (q.timer) clearTimeout(q.timer);
    const message = q.items.join('\n');
    try {
      appendFileSync(LEDGER, JSON.stringify({
        t: new Date().toISOString(), kind: 'delivery', sessionId: sid, cards: q.items.length,
        message, command: deliveryCommand(sid, q.cwd, message),
        ok: false, error: 'server stopped inside the coalesce window; run the command by hand',
      }) + '\n');
    } catch {}
  }
  DELIVERIES.clear();
}
async function findLocalCard(id) {
  try { return JSON.parse(await readFile(join(INBOX, id + '.json'), 'utf8')); } catch {}
  try { return (JSON.parse(await readFile(join(DIR, 'manual-cards.json'), 'utf8')) || []).find((c) => c && c.id === id) || null; } catch { return null; }
}
// After a ruling lands in the ledger: if the card is session-sourced (and not
// a blocking ask), compose its message and queue it for coalesced delivery.
// A ballot delivers only once ALL its slots are ruled, as one message.
async function maybeDeliver(cardId) {
  if (!cardId) return;
  const card = await findLocalCard(cardId);
  if (!card || card.ask) return;
  const src = card.source;
  if (!src || typeof src !== 'object' || src.kind !== 'session') return;
  const ledger = await loadLedger();
  if (isBallot(card)) {
    const slots = ballotSlots(card, ledger, (CONFIG.guardrails || {}).autoDecideFromLedger !== false);
    if (!slots.every((s) => s.resolved)) return;
    return enqueueDelivery(src, `[${card.title}] Verdicts: ${slots.map(slotLine).join('; ')}`);
  }
  const r = ledger.resolvedById[card.id];
  if (!r || !r.verdict) return;
  return enqueueDelivery(src, `[${card.title}] Verdict: ${r.verdict}${r.note ? ` (note: ${r.note})` : ''}`);
}

// ---------- Ledger (decisions resolve and archive cards) ----------
async function loadLedger() {
  const resolvedById = {}, verdictByKey = {}, slotsByCard = {}, entries = [];
  try {
    const txt = await readFile(LEDGER, 'utf8');
    for (const line of txt.split('\n').filter(Boolean)) {
      try {
        const o = JSON.parse(line);
        entries.push(o);
        // a slot ruling resolves one slot of a ballot, never the whole card
        if ((o.verdict && !o.slot) || o.archive) resolvedById[o.cardId] = o;
        if (o.verdict && o.decisionKey) verdictByKey[o.decisionKey] = o;
        if (o.verdict && o.slot && o.cardId) (slotsByCard[o.cardId] ||= {})[o.slot] = o;
      } catch {}
    }
  } catch {}
  return { resolvedById, verdictByKey, slotsByCard, entries };
}

// ---------- Ballot cards (one shared context, several calls) ----------
// A card may carry `decisions`: an array of slots that share the card's
// context. Each slot's `key` IS its decisionKey: slot rulings are ledger
// events, so partial rulings persist and each slot auto-applies from a prior
// ruling independently. The card resolves only when every slot is ruled.
function isBallot(c) { return Array.isArray(c && c.decisions) && c.decisions.length > 0; }
function ballotSlots(card, ledger, autoDecide) {
  const ruled = ledger.slotsByCard[card.id] || {};
  return card.decisions.filter((d) => d && d.key).map((d) => {
    const hit = ruled[d.key] || (autoDecide && ledger.verdictByKey[d.key] ? { ...ledger.verdictByKey[d.key], auto: true } : null);
    return {
      key: String(d.key), need: String(d.need || d.key),
      options: (Array.isArray(d.options) && d.options.length ? d.options : ['Approve', 'Deny']).map(String),
      resolved: hit ? { t: hit.t, verdict: hit.verdict, note: hit.note || '', auto: !!hit.auto } : null,
    };
  });
}
function slotLine(s) {
  return `${s.key} = ${s.resolved.verdict}${s.resolved.note ? ` (note: ${s.resolved.note})` : ''}${s.resolved.auto ? ' (auto)' : ''}`;
}

// ---------- Card sources ----------
async function loadManual() {
  try { return JSON.parse(await readFile(join(DIR, 'manual-cards.json'), 'utf8')); } catch { return []; }
}
async function loadInbox() {
  const out = [];
  let files = [];
  try { files = (await readdir(INBOX)).filter((f) => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    try {
      const c = JSON.parse(await readFile(join(INBOX, f), 'utf8'));
      if (!c.id) c.id = f.replace(/\.json$/, '');
      if (!c.createdAt) { try { c.createdAt = (await stat(join(INBOX, f))).mtimeMs; } catch {} }
      c.source = c.source || 'agent';
      out.push(c);
    } catch {}
  }
  return out;
}
// Issues are the spine: a seed description an agent works, with decision cards
// and proof linked back to it. Stored one JSON file per issue in issues/.
async function loadIssues() {
  const out = [];
  let files = [];
  try { files = (await readdir(ISSUES)).filter((f) => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    try {
      const iss = JSON.parse(await readFile(join(ISSUES, f), 'utf8'));
      if (!iss.id) iss.id = f.replace(/\.json$/, '');
      if (!iss.createdAt) { try { iss.createdAt = (await stat(join(ISSUES, f))).mtimeMs; } catch {} }
      iss.project = iss.project || CONFIG.defaultProject || 'vuoro';
      out.push(iss);
    } catch {}
  }
  return out;
}

// ---------- State assembly ----------
async function buildState(force) {
  if (!force && cache.data && Date.now() - cache.at < 12000) return cache.data;
  const [live, sess, manual, inbox, issues, ledger, system] = await Promise.all([liveCards(), sessions(), loadManual(), loadInbox(), loadIssues(), loadLedger(), systemStats()]);
  const g = CONFIG.guardrails || {};
  const surfaceRank = RANK[g.surfaceAtOrAbove] ?? 1;
  const staleMs = (g.staleAfterHours || 0) * 3600 * 1000;

  // Per-issue events pulled from the append-only ledger: the agent marking
  // itself complete, e2e proof attached by LaunchProof, and your acceptance.
  const proofByIssue = {}, completeByIssue = {}, acceptByIssue = {};
  for (const o of ledger.entries) {
    if (!o.issueId) continue;
    if (o.kind === 'proof') (proofByIssue[o.issueId] ||= []).push(o);
    else if (o.kind === 'complete') completeByIssue[o.issueId] = o;
    else if (o.cardId === `acc-${o.issueId}` && o.verdict) acceptByIssue[o.issueId] = o;
  }
  const latestProof = (id) => { const a = proofByIssue[id]; return a && a.length ? a[a.length - 1] : null; };
  const isAccepted = (id) => acceptByIssue[id] && acceptByIssue[id].verdict === 'accept';

  // Acceptance is the gate: when the agent has marked an issue complete and you
  // have not yet accepted it, VUORO synthesizes one "acceptance" card whose
  // evidence is the e2e proof. Ruling on it closes the issue.
  const acceptanceCards = [];
  for (const iss of issues) {
    if (!completeByIssue[iss.id] || isAccepted(iss.id)) continue;
    const p = latestProof(iss.id);
    const green = p && p.verdict === 'WORKING';
    acceptanceCards.push({
      id: `acc-${iss.id}`, project: iss.project, type: 'acceptance', urgency: 'now',
      issueId: iss.id, acceptance: true,
      source: iss.agentSessionId
        ? { kind: 'session', label: iss.agentLabel || 'agent', sessionId: iss.agentSessionId, cwd: iss.agentCwd || '' }
        : { kind: 'manual' },
      title: `Accept: ${iss.title}`,
      need: !p
        ? 'Agent marked this complete but attached no proof. Bounce for an e2e test, or accept on your own judgment.'
        : green
          ? 'Proof is green (e2e WORKING). Accept to close the issue, or bounce with a note.'
          : `Proof came back ${p.verdict}. Bounce to the agent to fix it.`,
      whoWhat: `Agent marked "${iss.title}" complete` + (p ? ` · e2e ${p.verdict}` : ' · no proof yet'),
      body: iss.description || '',
      evidence: [
        ...(p ? [{ kind: 'log', label: `LaunchProof: ${p.verdict}${p.test ? ' · ' + p.test : ''}`,
          value: `verdict  ${p.verdict}\ntest     ${p.test || '(unnamed)'}\nrun      ${p.runId || '?'}\nrecorded ${p.t}` }] : []),
        ...(p && p.runId ? [{ kind: 'link', label: '▶ Watch the recording (LaunchProof)', value: `${PROOF_DASHBOARD}/#${p.runId}` }] : []),
      ],
      actions: [
        { kind: 'verdict', label: 'Accept & close issue', value: 'accept' },
        { kind: 'verdict', label: 'Bounce to agent', value: 'bounce' },
      ],
      createdAt: completeByIssue[iss.id].t ? new Date(completeByIssue[iss.id].t).getTime() : Date.now(),
    });
  }

  const cards = [...inbox, ...manual, ...live, ...acceptanceCards].map((c) => {
    let resolved = ledger.resolvedById[c.id] || null;
    // recurring cards (PRs) reopen if the thread saw new activity after you resolved it
    if (resolved && c.updatedAt && new Date(c.updatedAt).getTime() > new Date(resolved.t).getTime()) resolved = null;
    let slots = null;
    if (isBallot(c)) {
      // a ballot resolves only when every slot is ruled (by hand or auto-applied)
      slots = ballotSlots(c, ledger, g.autoDecideFromLedger !== false);
      if (!resolved && slots.length && slots.every((s) => s.resolved)) {
        const t = slots.reduce((m, s) => (s.resolved.t > m ? s.resolved.t : m), '');
        resolved = { t, verdict: slots.map((s) => `${s.key} = ${s.resolved.verdict}`).join('; '), auto: slots.every((s) => s.resolved.auto), ballot: true };
      }
    } else if (!resolved && g.autoDecideFromLedger !== false && c.decisionKey && ledger.verdictByKey[c.decisionKey]) {
      resolved = { ...ledger.verdictByKey[c.decisionKey], auto: true };
    }
    const rank = RANK[c.urgency] ?? 9;
    const lane = resolved ? 'archive' : (rank <= surfaceRank ? 'needs' : 'later');
    const stale = !resolved && staleMs && c.createdAt && (Date.now() - c.createdAt > staleMs);
    return { ...c, ...(slots ? { decisions: slots, ruledCount: slots.filter((s) => s.resolved).length } : {}), resolved, decided: resolved, lane, stale: !!stale };
  });
  cards.sort((a, b) => (a.resolved ? 1 : 0) - (b.resolved ? 1 : 0) || (RANK[a.urgency] ?? 9) - (RANK[b.urgency] ?? 9));

  // Assemble each issue: seed description + decision history + proof + state,
  // so the issue view shows "what was asked, what we decided, and the proof".
  const issueViews = issues.map((iss) => {
    const decisions = cards.filter((c) => c.issueId === iss.id && !c.acceptance);
    const openCount = decisions.filter((c) => !c.resolved).length;
    const p = latestProof(iss.id);
    const accepted = isAccepted(iss.id);
    const completed = !!completeByIssue[iss.id];
    let state;
    if (accepted) state = 'done';
    else if (completed) state = 'needs-acceptance';
    else if (openCount) state = 'blocked';
    else if (iss.agentSessionId) state = 'in-progress';
    else state = 'open';
    const events = [{ t: new Date(iss.createdAt).toISOString(), kind: 'created', text: iss.description || iss.title }];
    for (const c of decisions) {
      if (c.resolved && c.resolved.verdict) events.push({ t: c.resolved.t, kind: 'decision', text: c.title, verdict: c.resolved.verdict, note: c.resolved.note || '' });
    }
    if (completed) events.push({ t: completeByIssue[iss.id].t, kind: 'complete', text: 'Agent marked complete' });
    for (const pr of (proofByIssue[iss.id] || [])) events.push({ t: pr.t, kind: 'proof', text: `LaunchProof ${pr.verdict}`, verdict: pr.verdict, runId: pr.runId, test: pr.test });
    if (accepted) events.push({ t: acceptByIssue[iss.id].t, kind: 'accepted', text: 'Accepted — issue closed', note: acceptByIssue[iss.id].note || '' });
    events.sort((a, b) => new Date(a.t) - new Date(b.t));
    return {
      id: iss.id, title: iss.title, description: iss.description || '', project: iss.project,
      createdAt: iss.createdAt, state,
      agent: iss.agentSessionId ? { sessionId: iss.agentSessionId, cwd: iss.agentCwd || '', label: iss.agentLabel || 'agent' } : null,
      decisions: decisions.map((c) => ({ id: c.id, title: c.title, urgency: c.urgency, resolved: c.resolved || null })),
      openCount,
      proof: p ? { verdict: p.verdict, runId: p.runId, test: p.test, t: p.t, url: `${PROOF_DASHBOARD}/#${p.runId || ''}` } : null,
      acceptanceTest: iss.acceptanceTest || null,
      accepted, completed, timeline: events,
    };
  });
  const ISTATE = { 'needs-acceptance': 0, blocked: 1, 'in-progress': 2, open: 3, done: 4 };
  issueViews.sort((a, b) => (ISTATE[a.state] ?? 9) - (ISTATE[b.state] ?? 9) || b.createdAt - a.createdAt);

  const data = { generatedAt: Date.now(), cards, sessions: sess, issues: issueViews, system, guardrails: g };
  cache = { at: Date.now(), data };
  return data;
}

// ---------- Diffs ----------
function repoByName(n) { return (CONFIG.repos || []).find((r) => r.name === n); }
function safeRef(s) { return typeof s === 'string' && /^[0-9a-zA-Z._/-]{1,120}$/.test(s); }
async function getDiff({ repoName, ref, pr }) {
  const repo = repoByName(repoName);
  if (!repo) throw new Error('unknown repo');
  if (pr) {
    if (!/^\d+$/.test(String(pr))) throw new Error('bad pr number');
    const { stdout } = await pexec('gh', ['pr', 'diff', String(pr), '-R', repo.slug], { maxBuffer: 32 * 1024 * 1024, timeout: 25000 });
    return stdout;
  }
  if (ref) {
    if (!safeRef(ref)) throw new Error('bad ref');
    if (!repo.path) throw new Error('no local path configured for repo ' + repoName);
    const { stdout } = await pexec('git', ['-C', repo.path, 'show', '--no-color', '--stat', '--patch', ref], { maxBuffer: 32 * 1024 * 1024, timeout: 25000 });
    return stdout;
  }
  throw new Error('need ref or pr');
}

// ---------- HTTP ----------
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
function underRoots(p) {
  const rp = resolve(p);
  return (CONFIG.shotRoots || []).some((r) => rp === resolve(r) || rp.startsWith(resolve(r) + '/'));
}

// ---------- Safe file reads (evidence popups) ----------
// /file serves file/dir content for the in-cockpit evidence viewer, but ONLY
// under the configured fileRoots (falls back to shotRoots). The request path
// is realpath-resolved before the prefix check, so ../ tricks and symlinks
// pointing outside the roots are both rejected. Nothing else on the FS is
// reachable.
let FILE_ROOTS_REAL = null;
async function fileRootsReal() {
  if (!FILE_ROOTS_REAL) {
    FILE_ROOTS_REAL = [];
    const roots = (Array.isArray(CONFIG.fileRoots) && CONFIG.fileRoots.length ? CONFIG.fileRoots : CONFIG.shotRoots) || [];
    for (const r of roots) { try { FILE_ROOTS_REAL.push(await realpath(resolve(r))); } catch {} }
  }
  return FILE_ROOTS_REAL;
}
async function resolveUnderFileRoots(p) {
  if (typeof p !== 'string' || !p.startsWith('/')) return null;
  let rp;
  try { rp = await realpath(resolve(p)); } catch { return null; }
  const roots = await fileRootsReal();
  return roots.some((r) => rp === r || rp.startsWith(r + '/')) ? rp : null;
}
function readBody(req) {
  return new Promise((res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => res(b)); });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/') {
      const html = await readFile(join(DIR, 'public', 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(html);
    }
    if (url.pathname === '/api/state') {
      const data = await buildState(url.searchParams.get('force') === '1');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(data));
    }
    if (url.pathname === '/shot') {
      const p = url.searchParams.get('path') || '';
      if (!underRoots(p)) { res.writeHead(403); return res.end('forbidden'); }
      try {
        const img = await readFile(p);
        res.writeHead(200, { 'content-type': MIME[extname(p).toLowerCase()] || 'application/octet-stream' });
        return res.end(img);
      } catch { res.writeHead(404); return res.end('not found'); }
    }
    if (url.pathname === '/file') {
      const rp = await resolveUnderFileRoots(url.searchParams.get('path') || '');
      if (!rp) {
        res.writeHead(403, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'path is outside the configured fileRoots (or does not exist)' }));
      }
      try {
        const st = await stat(rp);
        if (st.isDirectory()) {
          const entries = (await readdir(rp, { withFileTypes: true }))
            .filter((d) => !d.name.startsWith('.'))
            .map((d) => ({ name: d.name, dir: d.isDirectory() }))
            .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, kind: 'dir', path: rp, entries }));
        }
        const ext = extname(rp).toLowerCase();
        if (MIME[ext]) {
          const img = await readFile(rp);
          res.writeHead(200, { 'content-type': MIME[ext] });
          return res.end(img);
        }
        const MAX = 512 * 1024;
        let buf = await readFile(rp);
        const truncated = buf.length > MAX;
        if (truncated) buf = buf.subarray(0, MAX);
        if (buf.includes(0)) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'binary file; not rendered' }));
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          ok: true, kind: ext === '.md' ? 'md' : 'text',
          content: buf.toString('utf8') + (truncated ? '\n\n[truncated at 512 KB]' : ''),
        }));
      } catch (e) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'not readable: ' + e.message }));
      }
    }
    if (url.pathname === '/diff') {
      try {
        const text = await getDiff({
          repoName: url.searchParams.get('repo'),
          ref: url.searchParams.get('ref'),
          pr: url.searchParams.get('pr'),
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, text }));
      } catch (e) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: (e.stderr && e.stderr.toString()) || e.message }));
      }
    }
    if (url.pathname === '/api/term' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      // fresh:true starts a NEW claude session (no resume) in the given cwd; we
      // mint its session id ourselves so the thread is attributable — and
      // therefore stoppable — from birth.
      const fresh = !!body.fresh;
      const sid = fresh ? randomUUID() : String(body.sessionId || '');
      const cwd = String(body.cwd || '');
      if (!/^[0-9a-fA-F-]{8,}$/.test(sid)) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'bad session id' })); }
      if (!TTYD_OK) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'ttyd is not installed. Run: brew install ttyd' })); }
      let entry = fresh ? null : TERMS.get(sid);
      if (!entry || entry.proc.exitCode !== null) {
        const port = nextTermPort++;
        const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
        const runline = (cwd ? `cd ${q(cwd)} && ` : '') + (fresh ? `exec claude --session-id ${sid}` : `exec claude --resume ${sid}`);
        const args = ['-W', '-i', '127.0.0.1', '-p', String(port),
          '-t', 'fontSize=13', '-t', 'fontFamily=ui-monospace, SFMono-Regular, Menlo, monospace',
          '-t', 'theme={"background":"#0b0e13","foreground":"#dce3ec","cursor":"#e6a13a"}',
          '-t', 'cursorBlink=true', '-t', 'scrollback=5000',
          // the terminal lives in a dockable iframe: closing the panel must not
          // trip ttyd's beforeunload guard (Chrome shows it as a whole-tab
          // "Leave site?" prompt)
          '-t', 'disableLeaveAlert=true',
          'zsh', '-lic', runline];
        // detached: own process group, so stopping the thread can kill
        // ttyd AND its zsh/claude children in one signal
        const proc = spawn('ttyd', args, { stdio: 'ignore', detached: true });
        proc.unref();
        entry = { port, proc };
        TERMS.set(sid, entry);
        await new Promise((r) => setTimeout(r, 700)); // let ttyd bind
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, url: `http://127.0.0.1:${entry.port}`, sessionId: sid }));
    }
    // panel closed / switched thread: end the cockpit's own terminal for this
    // sid (its process can never be reattached — reopening always spawns a
    // fresh resume). Leaves wakes and externally started processes alone.
    if (url.pathname === '/api/term/close' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const sid = String(body.sessionId || '');
      if (!/^[0-9a-fA-F-]{8,}$/.test(sid)) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'bad session id' })); }
      const killed = await stopThread(sid, { onlyTerm: true });
      cache = { at: 0, data: null };
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, killed }));
    }
    // the ⏹ control: stop everything live that belongs to this thread
    if (url.pathname === '/api/term/kill' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const sid = String(body.sessionId || '');
      if (!/^[0-9a-fA-F-]{8,}$/.test(sid)) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'bad session id' })); }
      const killed = await stopThread(sid);
      await appendFile(LEDGER, JSON.stringify({ t: new Date().toISOString(), kind: 'thread-stop', sessionId: sid, killed }) + '\n');
      cache = { at: 0, data: null };
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, killed }));
    }
    // the 🗑 control: stop + hide from the Threads list. The transcript stays
    // on disk; new activity on the session un-hides it.
    if (url.pathname === '/api/threads/hide' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const sid = String(body.sessionId || '');
      if (!/^[0-9a-fA-F-]{8,}$/.test(sid)) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'bad session id' })); }
      const killed = await stopThread(sid);
      const hidden = await loadHidden();
      hidden[sid] = Date.now();
      await writeFile(HIDDEN_FILE, JSON.stringify(hidden, null, 2));
      await appendFile(LEDGER, JSON.stringify({ t: new Date().toISOString(), kind: 'thread-hide', sessionId: sid, killed }) + '\n');
      cache = { at: 0, data: null };
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, killed }));
    }
    if (url.pathname === '/api/archive' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      await appendFile(LEDGER, JSON.stringify({ t: new Date().toISOString(), cardId: body.cardId, archive: true, note: body.note || '' }) + '\n');
      cache = { at: 0, data: null };
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (url.pathname === '/api/ask' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const id = (body.id && /^[a-zA-Z0-9._-]{1,80}$/.test(body.id)) ? body.id : ('ask-' + Date.now());
      const options = Array.isArray(body.options) && body.options.length ? body.options : ['Approve', 'Deny'];
      // ballot ask: several slots sharing this card's context, each its own call
      const decisions = (Array.isArray(body.decisions) ? body.decisions : [])
        .filter((d) => d && d.key && d.need)
        .map((d) => ({
          key: String(d.key), need: String(d.need),
          options: (Array.isArray(d.options) && d.options.length ? d.options : ['Approve', 'Deny']).map(String),
        }));
      const card = {
        id, project: body.project || '', type: 'decision', urgency: body.urgency || 'now',
        issueId: body.issueId || null,
        source: body.sessionId ? { kind: 'session', label: body.label || 'session', sessionId: body.sessionId, cwd: body.cwd || '' } : { kind: 'manual' },
        title: body.question || 'Decision needed',
        need: body.why || 'Answer to continue the session.',
        whoWhat: body.whoWhat || '',
        body: body.context || '',
        createdAt: Date.now(),
        ...(decisions.length
          ? { decisions, actions: [] }
          : { actions: options.map((o) => ({ kind: 'verdict', label: o, value: o })) }),
        ask: true,
      };
      await writeFile(join(INBOX, id + '.json'), JSON.stringify(card, null, 2));
      cache = { at: 0, data: null };
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, id }));
    }
    if (url.pathname === '/api/answer') {
      const cardId = url.searchParams.get('cardId');
      // ballot ask: answered only when every slot is ruled; the reply carries all verdicts
      let ballotCard = null;
      try { const c = JSON.parse(await readFile(join(INBOX, cardId + '.json'), 'utf8')); if (isBallot(c)) ballotCard = c; } catch {}
      if (ballotCard) {
        const ledger = await loadLedger();
        const slots = ballotSlots(ballotCard, ledger, (CONFIG.guardrails || {}).autoDecideFromLedger !== false);
        res.writeHead(200, { 'content-type': 'application/json' });
        if (slots.length && slots.every((s) => s.resolved)) {
          try { await unlink(join(INBOX, cardId + '.json')); cache = { at: 0, data: null }; } catch {}
          return res.end(JSON.stringify({
            answered: true,
            verdict: 'Verdicts: ' + slots.map(slotLine).join('; '),
            verdicts: slots.map((s) => ({ key: s.key, verdict: s.resolved.verdict, note: s.resolved.note, auto: !!s.resolved.auto })),
            note: '',
          }));
        }
        return res.end(JSON.stringify({ answered: false, ruled: slots.filter((s) => s.resolved).length, total: slots.length }));
      }
      let answer = null;
      try {
        const txt = await readFile(LEDGER, 'utf8');
        for (const line of txt.split('\n').filter(Boolean)) {
          try { const o = JSON.parse(line); if (o.cardId === cardId && o.verdict && !o.slot) answer = o; } catch {}
        }
      } catch {}
      if (answer) { try { await unlink(join(INBOX, cardId + '.json')); cache = { at: 0, data: null }; } catch {} }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(answer ? { answered: true, verdict: answer.verdict, note: answer.note || '' } : { answered: false }));
    }
    if (url.pathname === '/api/cards' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!body || !body.title) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'a card needs at least a title' }));
      }
      const id = (body.id && /^[a-zA-Z0-9._-]{1,80}$/.test(body.id)) ? body.id : ('card-' + Date.now());
      const card = { type: 'decision', urgency: 'soon', source: 'agent', ...body, id, createdAt: body.createdAt || Date.now() };
      await writeFile(join(INBOX, id + '.json'), JSON.stringify(card, null, 2));
      cache = { at: 0, data: null };
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, id }));
    }
    if (url.pathname === '/api/verdict' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      // with `slot`, this ruling resolves one slot of a ballot; the slot's key is its decisionKey
      const slot = body.slot ? String(body.slot) : null;
      const entry = {
        t: new Date().toISOString(), cardId: body.cardId, issueId: body.issueId || null,
        decisionKey: slot ? (body.decisionKey || slot) : (body.decisionKey || null),
        verdict: body.verdict, note: body.note || '',
      };
      if (slot) entry.slot = slot;
      await appendFile(LEDGER, JSON.stringify(entry) + '\n');
      cache = { at: 0, data: null };
      maybeDeliver(String(body.cardId || '')).catch(() => {});
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, entry }));
    }
    if (url.pathname === '/api/issues' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!body || !body.title) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'an issue needs at least a title' }));
      }
      const slug = String(body.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '').slice(0, 40) || 'issue';
      const id = (body.id && /^[a-zA-Z0-9._-]{1,80}$/.test(body.id)) ? body.id : (`issue-${Date.now()}-${slug}`);
      const issue = {
        id, title: body.title, description: body.description || '',
        project: body.project || CONFIG.defaultProject || 'vuoro',
        createdAt: body.createdAt || Date.now(),
        agentSessionId: body.agentSessionId || null, agentCwd: body.agentCwd || '', agentLabel: body.agentLabel || '',
        acceptanceTest: body.acceptanceTest || null,
      };
      await writeFile(join(ISSUES, id + '.json'), JSON.stringify(issue, null, 2));
      cache = { at: 0, data: null };
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, id }));
    }
    if (url.pathname === '/api/issue/assign' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const id = String(body.issueId || '');
      let issue;
      try { issue = JSON.parse(await readFile(join(ISSUES, id + '.json'), 'utf8')); }
      catch { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'no such issue' })); }
      issue.agentSessionId = body.agentSessionId || issue.agentSessionId || null;
      issue.agentCwd = body.agentCwd ?? issue.agentCwd ?? '';
      issue.agentLabel = body.agentLabel ?? issue.agentLabel ?? '';
      if (body.acceptanceTest !== undefined) issue.acceptanceTest = body.acceptanceTest;
      await writeFile(join(ISSUES, id + '.json'), JSON.stringify(issue, null, 2));
      cache = { at: 0, data: null };
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (url.pathname === '/api/complete' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!body.issueId) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'need issueId' })); }
      await appendFile(LEDGER, JSON.stringify({ t: new Date().toISOString(), issueId: body.issueId, kind: 'complete', sessionId: body.sessionId || '' }) + '\n');
      cache = { at: 0, data: null };
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (url.pathname === '/api/proof' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!body.issueId) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'need issueId' })); }
      await appendFile(LEDGER, JSON.stringify({
        t: new Date().toISOString(), issueId: body.issueId, kind: 'proof',
        test: body.test || '', verdict: body.verdict || 'INCONCLUSIVE', runId: body.runId || '', url: body.url || '',
      }) + '\n');
      cache = { at: 0, data: null };
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    res.writeHead(404);
    res.end('not found');
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('server error: ' + e.message);
  }
});

server.listen(PORT, () => {
  console.log(`VUORO cockpit → http://localhost:${PORT}`);
});
