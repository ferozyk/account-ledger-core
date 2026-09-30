# Rejected

Two parts: acceptance criteria I refused, and approaches I abandoned mid-build.

Every figure below comes from `npm run replay`. Criteria I accept are listed at the end with the reason, because being right about the correct ones is also part of the judgement.

## Refused acceptance criteria

### ❌ "E7 causes exactly one overdraft fee to be assessed, on Day 2."

E7 is a Day-2-valued debit of AED 620.00 that only arrives on Day 5. Once it lands, the closing balances by value date are:

| Value day | Before E7 | After E7 (before fees) |
|---|---|---|
| 1 | 250.00 | 250.00 |
| 2 | 250.00 | **−370.00** |
| 3 | 650.00 | 30.00 |
| 4 | 465.00 | **−155.00** |
| 5 | 465.00 | **−155.00** |

Three days go negative, not one. The fee rule is per day, per account, on "that day's closing ledger balance (all entries with value_date ≤ that day)". A debit that reaches back three days can therefore cause up to three fees. After fees are applied in day order, the result is:

- Day 2: −370.00 → fee → −395.00
- Day 3: 30.00 − 25.00 = 5.00 → still positive, **no fee**
- Day 4: −155.00 − 25.00 = −180.00 → fee → −205.00
- Day 5: −205.00 → fee → −230.00

So E7 causes **three** fees (Days 2, 4 and 5, AED 75.00 in total). Any correct reading gives more than one fee, or at least not a single fee on Day 2:

- If fees are only assessed for the current business day (the alternative I rejected, see AMBIGUITIES §1), E7 causes one fee, but on **Day 5**, not Day 2.
- Under no reading does it cause exactly one fee on Day 2.

### ❌ "After E9, all balances and fees return to their pre-E7 values."

The ledger is append-only. E9 is a compensating entry, not a deletion. It cancels E7's AED 620.00, but the three fees assessed at the end of Day 5 were correct when they were assessed, and they stay on the ledger. Final closing balances are lower than the pre-E7 figures in steps: −25.00 on Days 2–3, −50.00 on Day 4, and −75.00 on Days 5–6 (final Day 6: 390.00 against 465.00). Capitalized interest is therefore also lower (0.93 instead of 1.03).

Making this criterion true would need a fee-refund rule the specification does not contain. Adding one silently would invent policy. Mutating or deleting the fees would break the append-only rule outright.

What the criterion is really asking for (the customer should not end up paying for a debit that was reversed) is a legitimate product concern. It is captured as the annotated failing test in `test/known-failing/`, which states the rule we would need and shows that the current design does not implement it.

### ❌ "The three BHD instalments in E10 must each be BHD 3.334."

3 × 3.334 = 10.002 BHD, which is 2 fils more than the 10.000 BHD credit. The criterion creates money. BHD has 3 decimal places, so 10.000 cannot be split into three exactly equal amounts. The correct split keeps the total exact and makes the instalments differ by at most one minor unit: **3.334 + 3.333 + 3.333 = 10.000**. The extra fils goes to the first instalment (see NUMBERS.md).

### ❌ "If the rounded daily interest accruals do not sum to the capitalized total, the remainder is discarded."

This contradicts a non-negotiable rule: *the rounded daily accruals must sum exactly to the capitalized total*. The design never computes the capitalized total separately. It **is** the sum of the rounded daily accruals, so no remainder can exist. Discarding a remainder would mean that interest reported to the customer day by day differs from interest paid, which is exactly the reconciliation break the rule is meant to prevent.

## Accepted criteria

| Criterion | Why it holds |
|---|---|
| Day 2 closing balance at end of Day 5, before fees, is AED −370.00 | 1,200.00 − 950.00 − 620.00. Holds are not part of the ledger balance. |
| Day 4 settlement of Auth-A must be accepted | Auth-A was approved on Day 2 (available 250.00 − 200.00 = 50.00 ≥ 0). Settling for less than the hold is ordinary (the final amount comes in under the authorized amount). The unused AED 15.00 of the hold is released. |
| Unknown-auth settlements are rejected and funds do not move | Auth-Z has no authorization. It is rejected with `UNKNOWN_AUTHORIZATION` and no ledger entry is written. In real card processing, issuers sometimes cannot refuse a "force post". That production gap is covered in the Part 2 design notes. |
| If Auth-B is approved, its hold reduces available balance but not ledger balance | True as a rule, and tested. In this stream it **never applies**: on Day 5, after E7, available balance is −155.00, so Auth-B (90.00) is **declined**. The trap is approving Auth-B because a stale balance is used. |

## Approaches abandoned mid-build

_Appended as they happen._

1. **Re-sorting the stream by business day.** My first instinct was to sort events by `day` so that E10 (Day 5) lands before E9 (Day 6). I abandoned it because the brief says "replayed in this order", and because in production a message that arrives late cannot be processed on a day that has already closed. Sorting would also have hidden the late arrival from the report. E10 is now booked on Day 6 with value date Day 5 and a visible notice (AMBIGUITIES §3).
2. **Freezing daily interest at each end-of-day.** Considered and dropped before coding. A Day 2 accrual frozen on Day 2 (250.00) is wrong once E7/E9 and the fees restate Day 2 to 225.00, and freezing would have needed a separate interest-adjustment entry type. Accruals are now memo figures computed once, at capitalization, from final value-dated balances.
3. **A local copy of `roundHalfEven` in `interest.ts`.** It was introduced so two modules could be built in parallel, then removed in review. The copy was only correct for non-negative inputs. That was harmless where it was used, but it was a trap for the next caller, and two rounding implementations in a ledger means two sources of truth. `interest.ts` now uses `money.applyRate`.
4. **Probing for a missing fee configuration by calling the fee rule with a 1-fil placeholder fee.** The engine's first version asked "is any fee due?" by running `daysRequiringOverdraftFee` with a placeholder fee of 1 fil. The answer is correct (the first decision in the cascade does not depend on fee size), but only by that non-obvious argument. It was replaced in review with a direct check: some day that has not already been charged has a negative balance.
5. **Reporting an authorization as "APPLIED, no ledger entries" with no further detail.** The first report printed approved Auth-A and declined Auth-B identically on their event lines, so the reader had to cross-reference the authorization table. Both decisions now carry a notice with the available balance and the requested amount, which is the evidence for the decision.
6. **Tests pinned to hand-computed figures that were wrong.** My brainstorm had final ACC-001 at 415.00 with interest 0.96, because I left the Day 4 fee out of the post-reversal balances. The first interest unit test encoded those figures as "the AED scenario". The test still passed (the function was right for the inputs it was given), which is exactly why it was dangerous. Caught while writing this file. The expected figures are now 390.00 and 0.93, and the E2E test cross-checks them against the engine.
