# Working with VUORO (for AI agents)

**Read this first if you are an AI agent operating in or for this repo.** It orients you;
the details live in [`CARD-PROTOCOL.md`](CARD-PROTOCOL.md) and
[`ISSUE-PROTOCOL.md`](ISSUE-PROTOCOL.md).

## What VUORO is

VUORO is a **decision inbox** for a human who runs many AI agents at once. You (the agents)
build, test, and verify; VUORO is where you bring the human the *small number of decisions
only they can make*. The human rules on them in a few short turns a day. A local web cockpit
(`node server.mjs`, default http://localhost:4319) shows the queue.

## The one rule: compress to the decision

Do **not** hand the human your work product or a status report. Decide everything you can.
Emit only the irreducible question — the part that needs their intent — as **one card**, with
evidence collapsed one layer down (a diff to open, a screenshot, a log). If they must read a
document to find the decision, the card is wrong. Rewrite until the decision is the first
thing they see. Classify urgency honestly (`now`/`soon` genuinely need them; `later`/`watch`
can wait).

## Two ways to reach the human

**1. A single decision** — you hit a fork you can't resolve. Post a card. The strongest form
is a *blocking ask*: it posts the card and waits, so your turn resumes the instant they rule.
```
node ask.mjs "<question>" --why "<one line>" --options "Approve,Deny" [--issue $VUORO_ISSUE]
```
Several calls that share ONE context go on one ballot card: repeat
`--decision "key|need|optA,optB"` (blocks until all are ruled; see `CARD-PROTOCOL.md`).
Group by context, never by time or count; unrelated questions stay separate cards.
Any agent/hook/CI can also drop a card by writing `cards/<id>.json` or POSTing `/api/cards`
(see `CARD-PROTOCOL.md`). Always set `source` so the reply can route back to your thread.

**2. A whole unit of work** — use an **issue** as the spine. The human creates issues; an agent
is bound to each via `VUORO_ISSUE`. The loop:
```
export VUORO_ISSUE=<id>                 # bind this session to the issue
node ask.mjs "..." --issue $VUORO_ISSUE  # raise decisions as you hit them
node complete.mjs                        # when done → raises an acceptance card
# then attach e2e proof (see below); WORKING → human accepts & the issue closes
```
Full lifecycle, states, and helpers: `ISSUE-PROTOCOL.md`.

## Proof: don't say "done", show it

A feature isn't done because the build is green. Prove it with **LaunchProof** — a real
browser drives the app and records a WORKING/BROKEN/INCONCLUSIVE verdict + video. The harness
is a shared checkout at `$LAUNCHPROOF_HOME` (default `~/Projects/launchproof`); this repo keeps
only its specs under `.launchproof/tests/`. Run, and point the webhook at VUORO so the verdict
auto-attaches to the issue as its proof:
```
LAUNCHPROOF_DIR="$PWD/.launchproof" TARGET_URL=http://localhost:4319 \
  LAUNCHPROOF_WEBHOOK=http://localhost:4319/api/proof \
  LAUNCHPROOF_WEBHOOK_EXTRA="{\"issueId\":\"$VUORO_ISSUE\"}" \
  node "$LAUNCHPROOF_HOME/run.mjs" <feature>
```
See the `launchproof` skill (`.claude/skills/launchproof/`) for writing tests.

## Command reference

| Do | Command |
|----|---------|
| Run the cockpit | `node server.mjs` → http://localhost:4319 |
| Create an issue | `node issue.mjs "<title>" --desc "..." [--test <launchproof-test>]` · or Issues → **+ new** |
| List issues | `node issue.mjs --list` |
| Ask a decision (blocking) | `node ask.mjs "<q>" --why "..." --options "A,B" --issue $VUORO_ISSUE` |
| Ask several calls sharing one context (ballot, blocks until all ruled) | `node ask.mjs "<title>" --why "..." --decision "key\|need\|A,B" --decision "key2\|need2\|Yes,No"` |
| Mark an issue complete | `node complete.mjs --issue $VUORO_ISSUE` |
| Attach proof by hand | `node proof.mjs --issue <id> --test <t> --verdict WORKING --run <runId>` |
| Prove a feature | LaunchProof (above) |

All scripts are zero-dependency Node and honor `VUORO_PORT` (default 4319).

## Repo map

- `server.mjs` — the cockpit (HTTP + state assembly). Zero dependencies.
- `public/index.html` — the UI (Decisions board + Issues view).
- `ask.mjs` / `issue.mjs` / `complete.mjs` / `proof.mjs` — the agent-facing CLI.
- `cards/` `issues/` `ledger.jsonl` — local runtime data (gitignored). `ledger.jsonl` is the
  append-only record of every verdict, proof, and acceptance.
- `CARD-PROTOCOL.md` · `ISSUE-PROTOCOL.md` — the full protocols.
