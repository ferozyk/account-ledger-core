# Ambiguities

Each entry lists what is unclear, the options considered, what I chose, and what would make me revisit it. Where the choice changes the output, the effect is quantified.

## 1. When a back-valued entry makes an earlier day negative, when is that day's fee assessed?

The fee rule defines the closing balance by value date ("all entries with value_date ≤ that day") and books the fee "with value_date equal to the day assessed". It does not say when the assessment runs.

- **Option A:** each end-of-day assesses only that business day. A back-valued debit only triggers a fee if the negative balance carries through to the current day.
- **Option B (chosen):** each end-of-day re-evaluates every day in the window up to today, in day order, and books any fee not already booked for that (account, day).

**Why B:** The rule is written in terms of value-dated balances. Option A would make the fee depend on when an entry was booked rather than on its value date, so an early-booked debit and a late-booked debit with the same value date would be charged differently. Option B is also the only reading under which criterion 1 ("Day 2 closing … evaluated at end of Day 5 and before any fee is assessed") makes sense: it implies a fee assessment for Day 2 that happens at the end of Day 5.

**Consequence:** E7 produces fees on Days 2, 4 and 5 (AED 75.00). Under Option A it would have produced one fee on Day 5, and final Day 6 would have been 440.00 instead of 390.00.

Fees are booked with `bookingDay` = the day the assessment ran and `valueDate` = the day assessed, so the audit trail shows both dates.

## 2. Fees on a day that later becomes positive again (after a reversal)

After E9, Days 2, 4 and 5 are no longer negative under the final view, but their fees are already booked.

- **Chosen:** the fees stand. They were correct on the information available at the time. The ledger is append-only, and the specification has no refund rule.
- **Not chosen:** automatic compensating fee reversals. That is a product and regulatory decision (see Part 2), not something to invent. The gap is captured as the annotated failing test.

## 3. E10 is listed after a Day 6 event, but its business day is Day 5

The stream is "replayed in this order", and E10 comes after E9 (Day 6).

- **Option A:** re-sort by business day. Rejected because it contradicts "replayed in this order", and because in production a late message cannot travel back in time to a day that has already closed.
- **Option B:** reject E10 as out of sequence. Rejected because nothing is wrong with the event itself: it is a valid credit that arrived late.
- **Chosen:** Day 5 is already closed, so E10 is **booked on Day 6 with value date Day 5**. The outcome carries a notice so the late arrival is visible in the report and logs.

**Consequence:** the Day 5 report (as known at the end of Day 5) shows ACC-002 at 0.000. The restated final view shows 10.000 from Day 5. Interest for Day 5 is still accrued, because interest is computed from final value-dated balances (§4).

## 4. Which "closing ledger balance" is used for daily interest?

Back-valued entries mean that the Day 2 closing balance on Day 2 differs from the Day 2 closing balance on Day 6.

- **Chosen:** daily accruals are memo figures recomputed from **final value-dated balances** at capitalization (end of Day 6). Only the capitalization is written to the ledger, as a single entry. Accrual figures printed in daily reports are provisional.
- **Not chosen:** freeze each day's accrual at its own end-of-day. The capitalized amount would then include interest on money that was later reversed out (or miss interest on back-valued credits such as E10), and a separate interest-adjustment process would be needed.

## 5. Does Day 6 interest include its own capitalization credit?

No. That would be circular (the credit would depend on itself). The Day 6 accrual is computed on the Day 6 closing balance **before** the capitalization entry is posted.

## 6. Which balance does an authorization check?

- **Chosen:** at the moment the authorization is processed: ledger balance (all entries booked so far with value date ≤ the booking day) minus active holds. The decision is never revisited when back-valued entries arrive later.

**Consequence:** Auth-A was correctly approved on Day 2 (available 50.00), even though E7 later makes Day 2 negative. Auth-B is declined on Day 5 because E7 had already been processed earlier that day.

## 7. Settlement amount differs from the hold

- **Under the hold** (Auth-A: 185.00 against 200.00): accepted. The whole hold is released, since this is a single-capture model, so the unused 15.00 is freed.
- **Over the hold:** rejected (`SETTLEMENT_EXCEEDS_HOLD`). Card schemes tolerate some over-capture (tips, fuel). Accepting it without a tolerance rule would let a settlement debit money that was never reserved. It doesn't occur in this stream.
- A settlement is **not** re-checked against available balance: the funds were reserved at authorization time.

## 8. What counts as "not present in the ledger" for a settlement

Authorizations are not ledger entries (a hold never moves ledger balance), so the criterion is read as "no authorization was ever recorded". I also reject settlements against:

- a **declined** authorization (`AUTHORIZATION_NOT_APPROVED`, because there is no hold to settle);
- an **already-settled** authorization (same code, which stops duplicate captures);
- an authorization **belonging to another account**. This returns `UNKNOWN_AUTHORIZATION` rather than a distinct code, so the response does not confirm that the ID exists elsewhere.

## 9. "Three equal instalments" of an amount that does not divide evenly

10.000 BHD / 3 is not representable at 3 decimal places. The split is 3.334 + 3.333 + 3.333, with the remainder going to the earliest instalments. See REJECTED.md for why 3 × 3.334 is wrong, and NUMBERS.md for why the remainder goes first rather than last. All three instalments share value date Day 5, so the order has no balance effect inside the window.

## 10. The overdraft fee is quoted in AED; ACC-002 is BHD

The specification gives no BHD fee and no FX rate. ACC-002 never goes negative in this stream, so it doesn't matter here. The engine takes a per-currency fee schedule. If an account without a configured fee goes negative, it **reports an error** (`FEE_NOT_CONFIGURED`) instead of silently skipping the fee or converting at an invented rate.

## 11. Rounding mode

The only rounding in the system is daily interest. I chose round-half-even (banker's rounding), which is unbiased over many accruals. In this stream no accrual lands exactly on a half, so half-up would give identical output. Reasoning is in NUMBERS.md.

## 12. What "Day" means and when a day closes

Days are business days 1..6 with no calendar or holiday semantics. A day closes when the first event of a later day arrives, or at the end of the stream. Days with no events (none in this stream) are still closed, so fees and reports are never skipped. Value dates later than the booking day (future-dated entries) are rejected, as are value dates outside the window.

## 13. Reversal semantics

- A reversal compensates **every** ledger entry produced by the target event (e.g. all three instalments of a split credit), with the target's value date. The ledger entries carry the reversal's own value date, which in E9's case equals E7's (Day 2).
- Reversing an event that is not in the stream, was rejected, is a reversal, or is an authorization/settlement is rejected. Authorizations and settlements have their own lifecycle and are not reversed via REVERSAL.
- Reversing the same event twice is rejected (`ALREADY_REVERSED`).
- The reversal's value date must equal the target's value date. A mismatch is rejected, because a reversal with a different value date would leave a window where both the original and the reversal disagree. E9 satisfies this.

## 14. Zero amounts, duplicates, malformed input

- Zero or negative amounts on money-moving events are rejected (`INVALID_AMOUNT`).
- Amounts with more decimal places than the currency allows are rejected rather than rounded. Silently rounding inbound money is a reconciliation bug.
- A repeated event ID is rejected (`DUPLICATE_EVENT`), which makes replay idempotent per event.
- An event in a currency other than the account's is rejected (`CURRENCY_MISMATCH`).

## 15. Opening balances

Both accounts open at zero. Opening balance is modelled as an account attribute rather than a ledger entry, so it sits "before Day 1" for every value-date query.

## 16. Output "per day"

The brief asks for the per-day closing balance, fees, authorization states and errors. Because of back-valuation there are two legitimate "Day N closing balances". The replay prints both:

1. an **as-known** report at each end-of-day (what an operator would have seen that evening);
2. a final **restated** view by value date after the window closes, including the interest accrual for each day.
