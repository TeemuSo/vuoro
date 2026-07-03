# VUORO

One inbox for the decisions your AI agents need from you.

"Vuoro" is Finnish for "turn" or "shift." You run a company of AI agents. They build, test, review, and deploy. VUORO is where they bring you the small number of decisions only you can make, so you can rule on them in a few short turns a day and get back to your life.

## The idea

Modern AI development inverts the old bottleneck. Writing code is cheap. Knowing what to build and verifying that it works is the scarce human input. When you run many agents at once you become the verifier for all of them at the same time, and that constant context switching is what burns you out.

VUORO removes that load with one rule: **agents bring you decisions, not presentations.** Everything an agent can decide, it decides. Only the irreducible question, the part that needs your intent, reaches you. It arrives as a single card with the evidence one layer down. You answer, and the answer routes back to the thread that asked.

This is the oracle problem stated as an interface. "Correct" is an external intention that cannot be derived from the code, so a human has to say "yes, that is what I meant." VUORO makes saying that as cheap as possible, and remembers it so you never say it twice.

## Where cards come from

- **GitHub:** open PRs on your delivery branch, with CI turned into a plain verdict (ready / not ready / in flight), and the diff viewable inline.
- **Agents:** any agent, hook, or CI job drops a card into the inbox. See [CARD-PROTOCOL.md](CARD-PROTOCOL.md).
- **You:** hand written cards for actions no agent can take (a console click, a message to send).

## The loop

Two modes, nothing in between:

- **Decide.** A card carries enough context to rule without opening anything: which thread, the call, one line of why, evidence collapsed one click away. You hit a verdict. The card leaves.
- **Dive.** When you want to see or steer the thread itself, "open thread" drops you into the real terminal (the actual Claude Code session), embedded in the cockpit. One dive, not five half-built chat boxes.

The star case is a **blocking ask**: an agent hits a point where it needs your intent, pauses, and hands its context to a card. You decide, and the paused session continues on your answer. One pending decision maps to one blocked session. See "Blocking ask" below.

Every verdict is written to an append only ledger. A decision carrying a stable `decisionKey` is auto applied the next time the same fork appears, instead of asking you again.

## Blocking ask

An agent calls `ask.mjs` at a decision point. It posts a card, then blocks until you answer, prints your answer, and exits, so the calling session's turn is paused on that command and continues the moment you decide.

```
node ask.mjs "Approve the destructive migration?" --why "Runs against the shared DB." --options "Approve,Deny" --project myapp
```

The card is bound to the calling session (via `CLAUDE_SESSION_ID`, or the newest transcript for the current directory), so "open thread" opens exactly that session.

## What a card is

One card is one decision, in the frame "who did what, with what outcome, is this OK?". It carries a one line `need` (the single thing you must do), a `whoWhat` context line, collapsed `evidence` (a diff to open, a screenshot to glance at, a log to expand), and `actions` (a verdict, a copyable command, an external link). Full schema in [CARD-PROTOCOL.md](CARD-PROTOCOL.md).

## Guardrails (configurable)

Set the level at which you want to be involved, in `config.json`:

- `surfaceAtOrAbove`: the urgency at which a card counts as "needs you." Lower priority cards wait quietly in "Later / watching."
- `autoDecideFromLedger`: reuse your prior ruling for any card with the same `decisionKey`.
- `staleAfterHours`: flag an unanswered card as stale, so nothing silently stalls.

## Install

One command, no dependencies, no config:

```
npx degit TeemuSo/vuoro vuoro && cd vuoro && node server.mjs
```

Open http://localhost:4319. Out of the box VUORO finds your Claude Code sessions in `~/.claude/projects` and starts serving the inbox; agents can post cards immediately (`node ask.mjs ...`, or POST `/api/cards` from anything).

Prefer git? `git clone https://github.com/TeemuSo/vuoro && cd vuoro && node server.mjs`. Node 18+ is the only requirement.

Optional, when you want more:

- **GitHub PR cards**: authenticate the `gh` CLI and copy `config.example.json` to `config.json` to point at your repos.
- **Embedded terminal ("open thread")**: `brew install ttyd`. Without it the rest works and the card tells you it is unavailable.
- **Hand-written action cards**: copy `manual-cards.example.json` to `manual-cards.json`.

## Open a thread

Every session-bound card and every entry in the right rail has "open thread". It opens the real Claude Code session, embedded in the cockpit via ttyd, as a focused overlay (Esc to close). This is the single dive: you interact with the actual session, not a reconstruction of it.

## Status

Early and honest.

Working: the inbox, GitHub cards with CI verdicts and inline diffs, screenshots and logs as evidence, the ledger with auto decide, guardrail thresholds, provenance on every card, the embedded terminal dive, the blocking ask (an agent pauses on a card and continues on your answer, proven end to end), ballot cards (several calls sharing one context, ruled slot by slot, auto applied per slot), and coalesced delivery (rulings on session cards ride back as one combined message per session, waking the source session headlessly in the background — no terminal pops up; `delivery.coalesceSeconds`, `delivery.permissionMode`), and thread lifecycle controls (⏹ stops a thread's live Claude processes, 🗑 stops and removes it from the list without touching the transcript, ＋ starts a fresh Claude in the focused context; closing the terminal panel ends its process instead of leaking it).

Not yet built: verdict buttons that execute the merge (today a verdict records and closes; the merge command is handed to you); push notification so a new card reaches you without watching the tab.

## Roadmap

1. Executing verdicts: `ship` runs the merge.
2. Push: notify when a card needs you, so the cockpit comes to you instead of being polled.
3. More sources as small providers: error trackers, deploy status, calendars, chat.

## Prior art and credit

The human in the loop pattern is well established. [HumanLayer](https://www.humanlayer.dev) provides an SDK where an agent can require approval or contact a human as a tool, with routing and learned auto approvals. [Arahi](https://arahi.ai) offers a single inbox of pending approvals across agents. VUORO differs in two ways: it sits over the fleet you already run (Claude Code sessions, GitHub, chat) rather than agents built on one SDK, and it compresses each item to a decision rather than an artifact to review.

## License

MIT.
