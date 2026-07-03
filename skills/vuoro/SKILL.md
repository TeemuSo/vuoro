---
name: vuoro
description: Reach the human through their VUORO decision inbox instead of asking in-chat. Use at any fork only the human can rule (approve/deny, pick a direction, permission for something risky), when several such calls share one context (ballot), when starting a unit of work that should be tracked as an issue, when marking issue work complete, or when attaching e2e proof to an issue. Also use when the user says "ask me on vuoro", "raise a card", "make it an issue", or mentions the decision inbox / cockpit.
---

# VUORO — reach the human as decisions, not chat

VUORO is the human's decision inbox (a local cockpit, default http://localhost:4319). They
rule on cards in short batches; a blocking ask pauses your turn and resumes it the moment
they decide. All helpers are zero-dependency Node scripts that work from any directory.

Resolve paths and port once per session:
```bash
VUORO="${CLAUDE_PLUGIN_ROOT:-$HOME/Projects/vuoro}"   # where the scripts live
export VUORO_PORT="${VUORO_PORT:-4319}"
```
If a script exits 2, the cockpit isn't running — tell the human to start it
(`VUORO_DATA=~/.vuoro node "$VUORO/server.mjs"`); don't start it yourself unless asked.

## The one rule

Decide everything you can yourself. Emit only the irreducible question — the part that
needs the human's intent — as ONE card: the decision first, one line of why, evidence
collapsed one layer down. If they'd have to read a document to find the decision, rewrite
the card. Classify urgency honestly: `now`/`soon` genuinely need them; `later`/`watch` wait.

## Blocking ask — a fork you can't resolve

```bash
node "$VUORO/ask.mjs" "<question>" --why "<one line>" --options "Approve,Deny" [--context "..."]
```
Blocks until the human rules, prints the verdict (plus any note they typed), and exits —
continue on that answer.

Several calls sharing ONE context go on one **ballot** (blocks until all slots are ruled).
Group by context, never by time or count; unrelated questions stay separate cards:
```bash
node "$VUORO/ask.mjs" "<title>" --why "<shared context>" \
  --decision "key|need|OptionA,OptionB" --decision "key2|need2|Yes,No"
```
Use stable decision keys for recurring forks — the human's first ruling is remembered and
auto-applies the next time the same key appears, so they never answer twice.

## Issues — a whole unit of work

```bash
node "$VUORO/issue.mjs" "<title>" --desc "<what + acceptance intent>"   # prints <id>
export VUORO_ISSUE=<id>                                                  # bind this session
node "$VUORO/ask.mjs" "<question>" --issue "$VUORO_ISSUE" ...            # forks, as you hit them
node "$VUORO/complete.mjs"                                               # done → acceptance card
```

## Proof — e2e evidence on the acceptance card

Attach a real e2e verdict to the issue. Any harness works; the contract is one webhook:
```bash
node "$VUORO/proof.mjs" --issue "$VUORO_ISSUE" --test <name> --verdict WORKING --run <id> --url <recording-link>
# equivalently: POST /api/proof {"issueId","test","verdict","runId","url"}
# harnesses with a webhook setting can auto-post this payload after each run
```
`verdict` is WORKING / BROKEN / INCONCLUSIVE; `url`, when present, becomes the "watch the
recording" link on the acceptance card. WORKING → the human accepts and the issue closes;
BROKEN → expect a bounce with a note.

## Fire-and-forget cards

For non-blocking decisions or FYIs, POST `/api/cards` (full schema:
`"$VUORO/CARD-PROTOCOL.md"`). Always set `source` (kind/label/sessionId/cwd) so the human's
reply routes back to the session that asked.
