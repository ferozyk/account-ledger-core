# Worklog

Times are local (Asia/Dubai, UTC+04). Entries are appended as work happens; nothing is back-filled.

| Time (2026-09-30) | Entry |
|---|---|
| ~23:25 | Read the brief. Hand-replayed the whole event stream on paper before designing anything, to find which acceptance criteria are wrong (2, 6, 7, 8) and where the rules are ambiguous. |
| ~23:35 | Design decisions settled: bitemporal entries (booking day + value date), bigint minor units, fees re-assessed over all past days at each EOD, interest computed from final value-dated balances, E10 booked late on Day 6. |
| 23:43 | Scaffold: TypeScript (strict), vitest, eslint (complexity cap 8), prettier. Wrote `src/types.ts` as the contract for all modules. Fixed an npm peer-dependency clash between `eslint@9` and `@eslint/js@10` by moving both to current majors. |
| 23:46 | Delegated two modules in parallel to Sonnet subagents (money + ledger; authorizations + fees + interest) against the `types.ts` contract. Reviewed both. Fixes applied in review: removed a duplicated `roundHalfEven` in `interest.ts` (only correct for non-negative inputs) in favour of `money.applyRate`, and corrected the "AED scenario" interest test, which encoded my own arithmetic slip from the brainstorm (I had left the Day 4 fee out of post-reversal balances: final Day 6 is 390.00 and interest 0.93, not 415.00 / 0.96). 128 tests green. |
