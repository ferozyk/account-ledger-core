# account-ledger-core

An in-memory, append-only, value-dated account ledger core in TypeScript. It has no web layer, no persistence and no database. A replay script runs the six-day event stream and prints, for each day, the closing ledger balance, fee assessments, authorization states and errors.

## Run it

Requires Node.js 22+. Start with `npm install`.

| Command | What it does |
|---|---|
| `npm run validate` | **Everything in one go:** typecheck, lint, format check, tests, build, then run the built app |
| `npm run build` | Compile `src/` to JavaScript in `dist/` (deleted and rebuilt each time) |
| `npm start` | Run the compiled app (`dist/replay.js`); needs `npm run build` first |
| `npm run replay` | Run straight from TypeScript source, with no build step (handy while developing) |
| `npm test` | All tests: unit, integration and end-to-end |
| `npm run test:unit` / `test:integration` / `test:e2e` | One test level only |
| `npm run test:known-failing` | The one deliberately failing test (see below) |
| `npm run check` | Typecheck, lint, format check and tests, without building |

The app writes the report to stdout and JSON logs to stderr. To see only the report, add `2>/dev/null`:

```sh
npm start 2>/dev/null
npm start 2>logs.jsonl      # keep the logs in a file
```

## Reading the output

The report has two parts, because back-dated entries mean there are two correct answers to "what was Day N's closing balance?".

**1. `=== Day N (end of day, as known) ===`**: printed as each day closes, showing what an operator would have seen that evening.

- **Balances**: the ledger balance (all entries with value date ≤ N that have been booked so far, including fees and interest booked at this end-of-day), active holds, and available balance (ledger balance minus holds).
- **Fees assessed**: fees booked at *this* end-of-day. The *value day* can be earlier than N: at the end of Day 5, fees are booked for value days 2, 4 and 5 because E7 was back-dated to Day 2.
- **Interest capitalized**: only on the last day of the window.
- **Authorizations**: every authorization known so far and its state (`APPROVED`, `DECLINED` or `SETTLED`, with the settled amount).
- **Events booked this day**: `APPLIED` with the ledger postings it created, or `REJECTED` with a code and reason. Notes flag late arrivals and give the figures behind each authorization decision.

**2. `=== Restated by value date (final) ===`**: after the window closes, every day's closing balance recomputed from all entries. It also shows each day's balance before interest (what interest was calculated on), the daily accrual, and a check that the daily accruals sum exactly to the capitalized amount.

Worked example: the **Day 5** report shows ACC-001 at −230.00. The **restated** Day 5 is 390.00, because E9 (booked on Day 6) reverses E7 back to Day 2. The fees stay.

## Results for the given stream

| | ACC-001 (AED) | ACC-002 (BHD) |
|---|---|---|
| Overdraft fees | 3 × 25.00 (value days 2, 4, 5; booked Day 5) | none |
| Interest capitalized (end of Day 6) | 0.93 | 0.008 |
| Final balance | 390.93 | 10.008 |

Auth-A was approved and later settled for 185.00. Auth-B was declined. The Auth-Z settlement was rejected with `UNKNOWN_AUTHORIZATION`. E10 arrived late and was booked on Day 6, value-dated Day 5.

## Layout

| Path | What it does |
|---|---|
| `src/types.ts` | Domain contract: events, entries, outcomes, reports |
| `src/money.ts` | bigint minor units, strict parsing, half-even rounding, exact allocation |
| `src/ledger.ts` | Append-only entry store; balances by value date in O(days) |
| `src/authorizations.ts` | Authorization and hold lifecycle |
| `src/fees.ts` | Overdraft fee rule, including the cascade to later days |
| `src/interest.ts` | Daily accrual; the capitalized amount is the sum of the rounded accruals |
| `src/engine.ts` | Event validation, per-type handlers, end-of-day processing, `replay()` |
| `src/scenario.ts` | The brief's accounts, constants and event stream |
| `src/report.ts`, `src/replay.ts` | Text report and CLI entry point |
| `test/unit`, `test/integration`, `test/e2e` | Tests by level; the E2E tests also spawn the real CLI |
| `test/known-failing` | The annotated failing test |

## Documents

- [AMBIGUITIES.md](AMBIGUITIES.md): every ambiguity found and how it was resolved
- [REJECTED.md](REJECTED.md): the acceptance criteria I refused, and approaches abandoned mid-build
- [NUMBERS.md](NUMBERS.md): every constant, and why that value rather than half of it
- [Architecture-and-Tradeoffs.pdf](Architecture-and-Tradeoffs.pdf): the Part 2 document (3 pages), generated from [DESIGN.md](DESIGN.md)
- [WORKLOG.md](WORKLOG.md): timestamped worklog

## The failing test

`test/known-failing/fee-refund-after-reversal.test.ts` asserts that fees caused only by a debit that was later reversed are refunded. It fails (−75.00 AED of fees remain) because of three design decisions: append-only entries, fees decided at a point in time, and no link from a fee to the entries that caused it. The comments in the file explain what a fix would require and why it is a policy decision, not a bug fix. It is kept out of `npm test` so that a red main suite always means a regression.
