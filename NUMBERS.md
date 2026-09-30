# Numbers

Every constant in the codebase, where it lives, and why it has that value rather than half of it. Constants given by the brief are marked **given**. For those, "why not half" means what would break if it were halved.

## Business constants (`src/scenario.ts`)

| Constant | Value | Source |
|---|---|---|
| Overdraft fee | AED 25.00 = `2500n` fils | given |
| Daily interest rate | `4n / 10000n` (0.04%) | given |
| Window | 6 days | given |
| AED precision | 2 decimal places | given |
| BHD precision | 3 decimal places | given |
| E10 instalments | 3 | given |
| Opening balances | 0 | given |

**Overdraft fee, 2500 fils.** Stored as an integer number of fils, never `25.0`. Halving it (12.50) would change every fee figure but not the logic. The value is interesting because it is large compared with the balances nearby: a Day 2 fee reduces Day 3 from 30.00 to **5.00**. A fee of 30.01 or more would push Day 3 negative and cause a fourth fee. So the cascade logic in `fees.ts` has to carry each new fee forward to later days, and `fees.test.ts` covers the case where the cascade leaves a day at exactly zero.

**Interest rate, stored as the fraction 4/10000, not the float `0.0004`.** `0.0004` has no exact binary representation, so multiplying a bigint balance by it would bring back the floating-point error that minor units exist to avoid. The denominator is 10000 (basis points), not 5000, so the stored figures match the published rate: 4 basis points a day reads as the brief states it. At this rate, 0.04% of 390.00 AED is 15.6 fils, so every daily accrual in the scenario needs rounding. Halving the rate is more interesting than it looks: at 0.02%, Day 2's 225.00 accrues exactly **4.5 fils**, a true tie, so the choice of rounding mode would change the capitalized total (half-even gives 4, half-up gives 5). At the actual rate, no scenario accrual is a tie.

**Window, 6 days.** Days are integers, 1-based. There is no calendar. The rule "capitalize at end of window" is tied to `windowDays`, not to a literal 6, so a shorter window (3) only changes when capitalization happens. With a 3-day window, every event from E5 (Day 4) onward would be rejected as `OUTSIDE_WINDOW`.

**Precision.** `CURRENCY_DECIMALS = { AED: 2, BHD: 3 }` in `src/money.ts`. BHD's third decimal is what makes E10's split uneven, and why criterion 7 (3 × 3.334) creates 2 fils. Minor units are stored as `bigint`, not `number`, because `number` loses integer precision above 2^53 (≈ 9 × 10^15). That is about 90 trillion AED in fils, which seems safe until you sum a large bank's ledger.

## Choices I made

| Constant | Value | Where |
|---|---|---|
| Rounding mode | round-half-even | `money.roundHalfEven` |
| Instalment remainder placement | earliest instalments | `money.allocate` |
| Authorization approval threshold | available after hold `>= 0` | `authorizations.ts` |
| Fee trigger | closing balance `< 0` | `fees.ts` |
| Entry ID padding | 4 digits (`L0001`) | `ledger.ts` |
| Complexity cap (eslint) | 8 per function | `eslint.config.js` |
| Max nesting depth (eslint) | 3 | `eslint.config.js` |

**Round-half-even.** Interest is the only place amounts are rounded. Half-up rounds every exact half upward, so across millions of accruals the bank systematically overpays. Half-even is unbiased on average. In this scenario no accrual lands exactly on a half, so half-up would give identical output (at half the rate it would not; see above). The choice matters at scale, not here, and `money.test.ts` pins down the tie cases (0.5→0, 1.5→2, 2.5→2, −0.5→0, −1.5→−2).

**Remainder to the earliest instalments (3.334, 3.333, 3.333).** It has to go somewhere, since the total is fixed at 10.000. Putting it first means the customer gets the extra fils sooner, and the rule stays deterministic for any number of parts: the first `total mod n` parts get +1. Putting it last would be equally valid in this window, because all instalments share value date Day 5. The first-instalment choice would matter if instalments were ever value-dated on different days.

**Approval at `>= 0`, fee at `< 0`.** Both come from the brief ("at or above zero", "is negative"). They are the same boundary seen from both sides: a balance of exactly 0.00 is approved and not charged a fee. Both boundaries are unit-tested one minor unit either side.

**Entry ID padding of 4.** Only for readable output. IDs keep growing past `L9999` (tested). Padding to 2 would make the sample output line up badly, and has no effect on correctness.

**Complexity cap of 8, max depth 3.** eslint's default cap is 20, which is too loose to enforce anything. At 8, each event handler has to be a small guard-clause function, which is the style the design asks for. Half of that (4) would force validation guards to be split into single-check functions, making the code harder to read rather than easier.

## Test constants

| Constant | Value | Why |
|---|---|---|
| Allocation property loop | totals 0–200 × parts 1–13 | Covers every remainder class for small part counts, including parts larger than the total (e.g. 5 fils in 13 parts). Halving the range still covers most of them. The full range costs well under a millisecond. |
| CLI spawn test timeout | generous (tens of seconds) | Starting `tsx` on a cold machine is slow. The test verifies the entry point, not its speed, and a tight timeout would make the suite flaky. |
