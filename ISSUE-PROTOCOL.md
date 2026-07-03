# Issue protocol

An **issue** is the spine of VUORO: a seed description an agent works, with the
decisions you rule on and the proof of completion all linked back to it. One issue
tells the whole story — *what was asked, what we decided, and the proof it's done*.

The loop, and the flags an agent uses at each step:

```
   you                      agent (bound to $VUORO_ISSUE)                VUORO
 ───────────────────────────────────────────────────────────────────────────────
 1. create issue  ─────────────────────────────────────────────►  issues/<id>.json
 2. spin agent    ─────────►  export VUORO_ISSUE=<id>
 3. (offline)                 hits a fork ──► node ask.mjs "..." ──►  decision card
    rule on card  ◄───────────────────────────────────────────────  (queued)
                              continues on your answer
 4.                          done? ──► node complete.mjs         ──►  marks complete
 5.                          prove ──► LaunchProof run (issue-bound) ─► proof attached
 6. accept card   ◄──────────────────────────────────────────────  acceptance card
    → issue closed
```

## 1. Create an issue

```
node issue.mjs "<title>" --desc "<what + acceptance intent>" [--project vuoro] [--test <launchproof-test>]
```
Prints the new issue id. Or create it in the cockpit (Issues → **+ new**). `--test`
records which LaunchProof test is this issue's acceptance check.

## 2. Spin an agent, bound to the issue

Start a Claude Code session for the work and bind it to the issue so everything it
emits links back:
```
export VUORO_ISSUE=<id>
```
`issue.mjs` stamps the creating session as the agent; otherwise assign later via
`POST /api/issue/assign { issueId, agentSessionId, agentCwd, agentLabel }`. The issue
view then shows the agent and an **open thread** button.

## 3. Raise decisions against the issue

Every clarification the agent needs is a blocking ask **linked to the issue**:
```
node ask.mjs "<question>" --why "<one line>" --options "A,B" --issue $VUORO_ISSUE
```
(`--issue` defaults to `$VUORO_ISSUE`.) The card queues on your decision board showing
which issue and which agent session it came from; your ruling routes back to the paused
session and is recorded on the issue's history with your note.

## 4. Mark complete

When the agent believes the issue is done:
```
node complete.mjs            # uses $VUORO_ISSUE
```
This raises the **acceptance card** — the gate that closes the issue.

## 5. Attach proof (e2e is the acceptance evidence)

Run the issue's LaunchProof test with the harness webhook pointed at VUORO, so the verdict
auto-attaches to the issue as its proof (the harness lives at `$LAUNCHPROOF_HOME`, default
`~/Projects/launchproof`; this repo holds only the specs under `.launchproof/`):
```
LAUNCHPROOF_DIR="$PWD/.launchproof" TARGET_URL=http://localhost:4319 \
  LAUNCHPROOF_WEBHOOK=http://localhost:4319/api/proof \
  LAUNCHPROOF_WEBHOOK_EXTRA="{\"issueId\":\"$VUORO_ISSUE\"}" \
  node "$LAUNCHPROOF_HOME/run.mjs" <test>
```
The acceptance card then shows WORKING (green — accept) or BROKEN (red — bounce), with a
link to the recording. To attach a run by hand: `node proof.mjs --issue <id> --test <t> --verdict WORKING --run <runId>`.

## 6. Accept

On the acceptance card you hit **Accept & close issue** (or **Bounce to agent** with a
note). Accepting writes to the ledger and moves the issue to **Done**, proof and all.

## Issue states (derived, not stored)

`open` → `in-progress` (agent assigned) → `blocked` (decisions waiting on you) →
`needs-acceptance` (agent complete, awaiting your ruling) → `done` (accepted).

## Files & endpoints

- `issues/<id>.json` — the seed (title, description, project, agent binding, acceptanceTest).
- Decisions link via `issueId` on the card; proof/complete/accept are ledger events keyed by `issueId`.
- `POST /api/issues` · `POST /api/issue/assign` · `POST /api/complete` · `POST /api/proof` · `POST /api/verdict {issueId}`.
- Helpers: `issue.mjs` · `ask.mjs --issue` · `complete.mjs` · `proof.mjs`, and LaunchProof's `LAUNCHPROOF_WEBHOOK` → `/api/proof` auto-post.
