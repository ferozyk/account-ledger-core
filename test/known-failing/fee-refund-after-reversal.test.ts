/**
 * KNOWN FAILING — deliberately. Run with `npm run test:known-failing`.
 * Excluded from `npm test` so the main suite stays a trustworthy green signal.
 *
 * What it asserts: a customer should not pay overdraft fees that exist only because of a debit
 * that was later reversed. E7 (AED 620.00, value Day 2) is reversed in full by E9, yet the three
 * fees it caused (Days 2, 4, 5 = AED 75.00) stay on the ledger.
 *
 * Why the design fails it — three decisions that are each defensible alone combine into this:
 *   1. Append-only: fees can't be deleted, only offset by a new compensating entry.
 *   2. Fees are decided at a point in time (each EOD) and, per (account, day), only once.
 *      EOD 6 does see that Days 2/4/5 are no longer negative before fees, but it only ever
 *      ADDS fees; nothing in the engine revisits a fee whose trigger has disappeared.
 *   3. Nothing links a fee to the entries that caused it. A FEE entry has no sourceEventId, so
 *      when E7 is reversed there is no way to find "the fees E7 caused" — we'd have to recompute
 *      the whole fee history without E7 and diff it, and fee cascades make that non-trivial
 *      (without E7's Day-2 fee, the Day-4 fee might also not exist).
 *
 * What it reveals: the brief's rule set has no refund policy, and the REJECTED criterion
 * "after E9 all balances and fees return to their pre-E7 values" is actually a product
 * requirement in disguise. Making this pass needs a real design decision, not a patch:
 *   - a FEE_REVERSAL entry kind (compensating, append-only),
 *   - fee entries that record the balance/trigger they were assessed on, and
 *   - an EOD "fee re-evaluation" step that, for each already-charged day whose recomputed
 *     balance (excluding its own and later fees) is no longer negative, books a reversal.
 * That rule is also regulatory (CBUAE consumer-protection expectations on unfair charges), so it
 * belongs to a policy owner, not to the engine author. See REJECTED.md and the design notes.
 */
import { describe, expect, it } from "vitest";
import { replay } from "../../src/engine.js";
import { noopLogger } from "../../src/logger.js";
import { SCENARIO_CONFIG, SCENARIO_EVENTS } from "../../src/scenario.js";

describe("overdraft fees after a full reversal (known gap)", () => {
  it("given E7 is fully reversed by E9, when the window closes, then its fees are refunded", () => {
    // Given the brief's stream, where E9 reverses E7 in full
    const result = replay(SCENARIO_CONFIG, SCENARIO_EVENTS, noopLogger);

    // When we net every FEE-related entry on ACC-001 (a refund would be a positive offset)
    const acc001 = result.restated.accounts.find((a) => a.accountId === "ACC-001");
    const netFeesMinor = result.dayReports
      .flatMap((d) => d.accounts.filter((a) => a.accountId === "ACC-001"))
      .flatMap((a) => a.feesAssessed)
      .reduce((sum, fee) => sum + fee.amountMinor, 0n);

    // Then the customer has paid no net fees for a debit that never took effect…
    //   ACTUAL: -7500n (three AED 25.00 fees on value days 2, 4, 5 remain)
    expect(netFeesMinor).toBe(0n);

    // …and Day 6 closes where it would have without E7: 465.00 + interest on the pre-E7 balances
    // (0.10 + 0.10 + 0.26 + 0.19 + 0.19 + 0.19 = 1.03) = 466.03.
    //   ACTUAL: 390.93 AED
    expect(acc001?.days.at(-1)?.closingMinor).toBe(46603n);
  });
});
