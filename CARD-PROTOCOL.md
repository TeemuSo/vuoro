# Card protocol

A card is one decision. Any agent, hook, or CI job can create one, two ways:

1. **Drop a file:** write `cards/<id>.json`.
2. **POST it:** `curl -X POST localhost:4319/api/cards -H 'content-type: application/json' -d '{ ... }'`

Both land in the same inbox and appear in the cockpit within seconds.

## Schema

```json
{
  "id": "unique-id",
  "project": "myapp",
  "type": "review | action | decision | info",
  "urgency": "now | soon | later | watch",
  "title": "one line: the decision itself",
  "need": "the single thing you must do",
  "whoWhat": "who did what, with what outcome",
  "body": "optional short context",
  "decisionKey": "stable key so an identical decision is auto applied from the ledger",
  "source": { "kind": "session", "label": "myapp build", "sessionId": "<uuid>", "cwd": "/abs/path" },
  "evidence": [
    { "kind": "diff", "label": "Eyeball the diff", "repo": "myapp", "pr": 283 },
    { "kind": "diff", "label": "Eyeball the diff", "repo": "myapp", "ref": "<sha>" },
    { "kind": "shot", "label": "Screenshot", "path": "/abs/path/to/image.png" },
    { "kind": "log",  "label": "Context", "value": "any text block" },
    { "kind": "file", "label": "Read the doc", "path": "/abs/path/to/file-or-dir" },
    { "kind": "link", "label": "Open in browser", "value": "https://..." }
  ],
  "actions": [
    { "kind": "verdict", "label": "Ship it", "value": "ship" },
    { "kind": "copy",    "label": "Copy command", "value": "gh pr merge 283 ..." },
    { "kind": "link",    "label": "Open console", "value": "https://..." }
  ]
}
```

Only `title` is strictly required. Sensible defaults fill the rest (`type: decision`, `urgency: soon`, `source: agent`, `createdAt: now`).

Evidence opens inside the cockpit. A `file` entry, or a `log`/`link` whose value is an absolute path, opens an overlay viewer: markdown renders as markdown, text as monospace, images inline, and a directory as a browsable listing. The server reads only under the `fileRoots` config list (paths are realpath-resolved before the check, so `../` and symlink escapes are rejected); everything else is refused.

## The one rule: compress to the decision

Do not hand the human your work product. Decide everything you can. Emit only the irreducible question, with evidence collapsed one layer down: a diff to open, a screenshot to glance at, a log to expand. If the human has to read a document to find the decision, the card is wrong. Rewrite it until the decision is the first thing they see.

## decisionKey and guardrails

Give recurring decisions a stable `decisionKey`. When the human rules once, VUORO writes it to the ledger and auto applies the same verdict to any future card carrying that key (unless `guardrails.autoDecideFromLedger` is false). This is how the human avoids answering the same question twice.

The human sets the level at which they want to be involved with `guardrails.surfaceAtOrAbove`. A card below that urgency waits in "Later / watching" rather than "Needs you." Classify honestly: reserve `now` and `soon` for things that genuinely need a human, and use `later` or `watch` for things they can review when they feel like it.

## Ballot cards (one context, several calls)

Group by context, never by time or count: when several decisions share one context, put them on ONE card so the human loads that context once. Unrelated questions stay separate cards. Add an optional `decisions` array of slots; everything else on the card (title, whoWhat, body, evidence) is the shared context, rendered once.

```json
{
  "title": "Pricing rewrite: 3 calls needed",
  "whoWhat": "Rewrote /pricing; three forks only you can rule",
  "decisions": [
    { "key": "hook-direction", "need": "Pick the hero hook", "options": ["A: ...", "B: ...", "C: ..."] },
    { "key": "annual-anchor",  "need": "Ship $69/yr next to $29/mo?", "options": ["Yes", "Not yet"] },
    { "key": "contact-email",  "need": "hello@ everywhere?", "options": ["Yes", "No"] }
  ]
}
```

Semantics:

- Each slot's `key` IS its decisionKey. Every slot ruling is its own ledger event, so auto-apply works per slot: a later ballot that reuses a key arrives with that slot already ruled (marked auto), and only the genuinely new slots ask. If every slot auto-applies, the card closes without surfacing.
- Keys must be unique within a card. Missing `options` default to `Approve,Deny`.
- Partial rulings persist (they live in the ledger), including across server restarts. The card closes and moves to Archive only when ALL slots are ruled.
- Each slot takes an optional note that rides back with that slot's verdict.
- A card without `decisions` behaves exactly as before: one verdict, unchanged lifecycle.
- A ballot always delivers as ONE message carrying all slot verdicts and notes, whether the source is a blocking ask or a session card delivered by resume.

## Provenance, delivery, and lifecycle

Always set `source` to the thread that emitted the card, so the human can see where a decision came from and route a reply back to it. Three kinds:

- `{ "kind": "session", "label": "...", "sessionId": "<uuid>", "cwd": "/abs/path" }` — a Claude Code session. A response is delivered by waking that session **in the background**: `claude -p --resume <sessionId> "<message>"` appends the human's message to the same session transcript and runs the agent's next turn headlessly — nothing opens on the human's screen. The woken turn runs with `--permission-mode` from `delivery.permissionMode` (default `acceptEdits`; set `bypassPermissions` only if you accept unattended full access, or `default` to rely purely on each repo's allowlists). Its output is written to `deliveries/<stamp>-<session>.log` and a `kind: "delivery-result"` ledger event records how it ended. Delivery is coalesced per session: rulings queue by `sessionId` and flush as ONE combined wake message after `delivery.coalesceSeconds` of quiet (config, default 120; set 0 to deliver each ruling immediately). A ballot is always one message with all its slot verdicts. Set `delivery.dryRun: true` to log instead of waking; `delivery.claudeBin` points at the CLI if it isn't on the server's PATH. A failed or pending-at-shutdown delivery is written to the ledger carrying the interactive command (`claude --resume ...`) to run by hand; the verdicts themselves are already in the ledger either way. Blocking asks skip this queue: the paused session picks its answer up from `/api/answer` instantly.
- `{ "kind": "pr", "label": "PR #123", "repo": "owner/name", "pr": 123 }` — a GitHub PR. A response is posted as a PR comment; a bounce prepends `@claude` to re-run the agent.
- `{ "kind": "manual" }` or a plain string — no live thread. A response is only recorded; nothing is delivered.

A Claude Code session knows its own id (hooks receive `session_id`; the SDK exposes it), so an agent should stamp the card with its `sessionId` and `cwd` when it emits one.

Lifecycle: a card is a decision, not an artifact you keep editing. It closes on a verdict or an explicit "Close" and moves to the Archive lane. Recurring cards (PRs) reopen if the thread sees new activity after you closed them; one-shot cards stay closed.

## The blocking ask (one pending decision, one paused session)

The strongest card is one an agent emits while it waits. Instead of dropping a file, the agent calls the `ask.mjs` helper at a decision point:

```
node ask.mjs "<question>" --why "<one line>" --options "Approve,Deny" [--context "..."] [--project x]
```

It posts a `decision` card (bound to the calling session), then blocks until you rule, prints your verdict to stdout, and exits. Because the agent's turn is paused on that command, it continues the instant you decide. This makes the mapping literal: one pending decision is one blocked session, and answering it resumes exactly that thread.

For several calls that share one context, post a ballot with repeated `--decision "key|need|optA,optB"` flags:

```
node ask.mjs "<title>" --why "<the shared context>" --decision "hook-direction|Pick the hero hook|A,B,C" --decision "annual-anchor|Ship $69/yr next to $29/mo?|Yes,Not yet"
```

It blocks until the whole ballot is ruled (slots auto-applied from the ledger count as ruled), then prints all verdicts on one line: `Verdicts: hook-direction = B; annual-anchor = Not yet (note: ...)`.

Package everything the human needs into the `--why` and `--context` so they can decide without opening the terminal. The terminal ("open thread") is for when they choose to look, not a requirement for the decision.
