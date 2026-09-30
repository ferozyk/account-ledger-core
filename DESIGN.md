# Design notes: architecture, trade-offs, production

## Append-only at scale

**What breaks first at 100× volume.** End-of-day fee assessment. For every account, every night, `closeDay` does three things:

1. rebuilds that account's closing balance for every day in the window (`closingBalances`);
2. scans **all** of the account's entries to find which days already carry a fee (`chargedFeeDays`);
3. scans all authorizations to sum the active holds (`activeHoldsMinor` filters the full `AuthorizationBook`).

So one end-of-day costs roughly O(accounts × (days in window + entries per account) + accounts × all authorizations). The last term is quadratic in the customer base. At 100× accounts it grows by 10,000×, and it would dominate long before the ledger itself becomes large.

**Where state grows without limit:**

- The entry log, the per-account entry arrays, and `bySourceEvent` in `Ledger`. Append-only means they are never pruned.
- `deltaByValueDay`: one key per distinct value day, per account, for all time. The balance code only ever needs the window.
- `outcomeLog` and the `seen` map in the engine. `seen` is the duplicate-event guard, so it has to retain every event ID ever processed.
- `AuthorizationBook`: settled and declined authorizations are kept for good and still scanned for holds.
- The "look back over every day" fee re-assessment. Its cost grows with how far back a value date may reach, and nothing limits that except the window.

**The cheapest structural change: a closed-period checkpoint.** When a day moves outside the back-dating horizon (say T−N), fold it into a per-account **carried-forward balance** plus the set of days already charged a fee, and stop allowing value dates before it. Then:

- balances start from the checkpoint rather than from opening;
- fee assessment only looks at days after the horizon;
- fee idempotency reads a small per-account set instead of scanning entries.

The entries themselves are not deleted, so the log stays the audit record. They move out of the hot path. Two smaller fixes belong alongside it: index active holds by account (a `Map<AccountId, Set<AuthId>>` that drops an authorization when it leaves `APPROVED`), and give the duplicate-event guard a time limit (IDs are unique within the horizon, and older IDs are checked against cold storage). None of this changes the event model. It adds one boundary: *value dates may not reach behind the checkpoint*. That boundary is also the control proposed below.

## Value-dated entries in production

Value dates separate *when we learned about something* from *when it counts*. In a UAE-licensed bank, that has consequences in several places:

- **Money owed to or by the customer.** Every back-dated entry reprices past days: interest owed, overdraft fees (this build charged three fees that the final restated view no longer justifies), and any tiered or minimum-balance charges. CBUAE consumer-protection rules expect fees to be fair and transparent. A fee charged on a balance that a later reversal has restated needs a defined refund policy, not an accident of processing order.
- **Statements and disclosures.** A statement already issued for Day 2 is now wrong. The bank has to decide whether it issues corrected statements, shows the adjustment on the next statement, or both. Customers can dispute either.
- **Regulatory and financial reporting.** Daily and period-end returns to CBUAE, liquidity and reserve positions, and the general ledger all take balances at a cut-off time. Back-dating across a reporting cut-off changes figures that have already been reported. Every submitted figure needs to be reproducible as it was known at the time (a booking-date view), alongside the corrected value-date view. This design keeps both dates on every entry for that reason.
- **AML and fraud.** Back-dating is a classic way to disguise a transaction's timing: moving it before a limit reset, out of a reporting window, or hiding an overdraft. Monitoring must look at booking time as well as value date.
- **Accounting periods and Islamic products.** Back-dating across a closed month or year crosses an audited period. For Islamic accounts, profit distribution is calculated per period and cannot simply be recalculated after the fact.

**One control to add before go-live:** a **back-dating limit with maker-checker approval above it.** Any entry whose value date is earlier than the booking day by more than N business days, or earlier than the last closed accounting period, is rejected from automated channels. It can only be posted through an operations workflow that needs a second approver and a reason code, and every such posting feeds a daily exception report to Finance and Compliance. It is the same boundary as the checkpoint in the previous section, so a single control addresses both scaling and regulatory risk.

## Authorization lifecycle

An authorization in this model is `APPROVED`, `DECLINED` or `SETTLED`. A settlement for **less** than the hold (Auth-A) still counts as a matching settlement: the leftover is released. Every way an authorization can end other than a matching settlement:

| How it ends | Real-world scenario | Behaviour I would require |
|---|---|---|
| **Declined at request** (Auth-B) | Not enough available funds at the point of sale | Recorded as history and never places a hold. Any settlement against it is rejected (`AUTHORIZATION_NOT_APPROVED`). The customer and the merchant get a decline reason code. |
| **Never settled: the hold expires** (Auth-B, had it been approved; *not modelled*) | The merchant never sends the settlement: a cancelled order, a hotel or car-rental deposit, a failed batch | Holds must have an expiry set by merchant category (days for retail, longer for hotels and car rental). An expiry job releases the hold with an audit event. If a settlement arrives after expiry, it is still posted (see force post below), even if that pushes the account into overdraft. |
| **Merchant cancellation or authorization reversal** (*not modelled*) | Customer cancels, the terminal times out, or the purchase is voided on the same day | A dedicated `AUTHORIZATION_REVERSAL` event that releases the hold immediately and is idempotent by original authorization ID. It must not be expressed as a ledger `REVERSAL`, because no money has moved. |
| **Settlement over the hold** (rejected here: `SETTLEMENT_EXCEEDS_HOLD`) | Tips, fuel pre-authorizations, currency conversion differences | Accept within a per-category tolerance (e.g. +20% for restaurants, capped for fuel). Above that, send it to operations for review rather than rejecting it outright, because the scheme will still claim the money. |
| **Second settlement of an already-settled authorization** (rejected here: `AUTHORIZATION_NOT_APPROVED`) | A duplicate clearing record, or a legitimate split shipment | Deduplicate by clearing reference. Multi-capture authorizations need an explicit "remaining hold" instead of this model's single-capture release. |
| **Settlement with no authorization** (Auth-Z: `UNKNOWN_AUTHORIZATION`) | An offline or floor-limit transaction, or a force post by the merchant | Card-scheme rules often **oblige** the issuer to accept these. Production should post the debit and raise a dispute or chargeback case, not refuse it. Rejecting it, as this model does, leaves the bank owing the scheme money it never took from the customer. |
| **Incremental authorization** (*not modelled*) | A hotel extends a stay, or a car rental is extended | Increases the existing hold under the same authorization ID, re-checking available funds only for the increase. |
| **Account closed or frozen while a hold is active** (*not modelled*) | A compliance freeze or a closed account | The hold stays in place until expiry or settlement. A settlement is posted and then goes to account recovery. |

## What I cut, and why

| Simplification | Production risk it defers |
|---|---|
| Everything in memory, single process, no persistence | A crash loses all state. Production needs a durable, ordered event log (replayable, which this design already assumes), transactional appends, and snapshots. |
| No concurrency: events are processed strictly one at a time | Two authorizations on the same account at the same moment could both pass the available-balance check. Production needs per-account serialisation (single-writer partitioning or row-level locks) with idempotency keys. |
| Integer days, no calendar, no time zones or holidays | Real value dates use business-day calendars (UAE weekend, public holidays, per-currency settlement calendars), and the end-of-day cut-off time matters. |
| No FX; fees only configured for AED | A BHD account going negative raises `FEE_NOT_CONFIGURED` rather than being charged. Multi-currency fee schedules and FX sourcing are not designed. |
| No fee refund or re-evaluation policy | Customers pay fees caused by reversed transactions (see the failing test). This is conduct risk under CBUAE consumer protection. |
| Single-capture authorizations, no expiry, no authorization reversal, no over-capture tolerance, force posts rejected | Holds can stay forever, available balance falls without reason, and scheme obligations aren't met. See the authorization table above. |
| No back-dating limit | Any value date inside the window is accepted from any caller. See the control above. |
| Duplicate detection by event ID only, kept forever | Unbounded memory. It also misses duplicates from upstream that arrive with *different* IDs (the same clearing record resent). Production needs deduplication by business key, with a time limit. |
| Interest is simple daily accrual on the ledger balance, with no tiers, day-count convention, or minimum-balance rules | Real products need day-count conventions (Actual/365, Actual/360), tiered rates, and rules for accrual on holidays. |
| Rejected events can't be resubmitted with the same ID | A client that retries a corrected event with the same ID is rejected as a duplicate. Needs a documented contract for retries versus corrections. |
| Report is plain text, logs go to stderr, no metrics | No latency percentiles, fee and decline counters, or alerts on `FEE_NOT_CONFIGURED` and late events. The JSON logs carry event IDs for correlation but are not shipped anywhere. |
| No authentication or authorization, and no input from untrusted sources | The engine trusts its caller. Any API in front of it needs auth, schema validation (`parseMoney` is already strict), and rate limiting. |
