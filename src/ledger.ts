import type { Account, AccountId, Day, EventId, LedgerEntry } from "./types.js";

export type EntryDraft = Omit<LedgerEntry, "entryId">;

interface AccountBook {
  readonly account: Account;
  readonly entries: LedgerEntry[];
  /** Net movement per value day; lets balances be computed without scanning entries. */
  readonly deltaByValueDay: Map<Day, bigint>;
}

const isPositiveInteger = (n: number): boolean => Number.isInteger(n) && n > 0;

function formatEntryId(sequence: number): string {
  return `L${String(sequence).padStart(4, "0")}`;
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) {
    map.set(key, [value]);
  } else {
    list.push(value);
  }
}

export class Ledger {
  private readonly books = new Map<AccountId, AccountBook>();
  private readonly log: LedgerEntry[] = [];
  private readonly bySourceEvent = new Map<EventId, LedgerEntry[]>();

  constructor(accounts: readonly Account[]) {
    for (const account of accounts) {
      if (this.books.has(account.id)) {
        throw new Error(`Duplicate account id: ${account.id}`);
      }
      this.books.set(account.id, {
        account: Object.freeze({ ...account }),
        entries: [],
        deltaByValueDay: new Map(),
      });
    }
  }

  /** All-or-nothing: every draft is validated before any entry is stored. */
  append(drafts: readonly EntryDraft[]): LedgerEntry[] {
    drafts.forEach((draft) => this.validate(draft));
    return drafts.map((draft) => this.store(draft));
  }

  entries(): readonly LedgerEntry[] {
    return [...this.log];
  }

  entriesForAccount(accountId: AccountId): readonly LedgerEntry[] {
    return [...(this.books.get(accountId)?.entries ?? [])];
  }

  entriesForSourceEvent(eventId: EventId): readonly LedgerEntry[] {
    return [...(this.bySourceEvent.get(eventId) ?? [])];
  }

  account(accountId: AccountId): Account | undefined {
    return this.books.get(accountId)?.account;
  }

  accounts(): readonly Account[] {
    return [...this.books.values()].map((book) => book.account);
  }

  /** Opening balance plus every entry valued on or before `day`. */
  closingBalance(accountId: AccountId, day: Day): bigint {
    const book = this.bookFor(accountId);
    let balance = book.account.openingBalanceMinor;
    for (const [valueDay, delta] of book.deltaByValueDay) {
      if (valueDay <= day) {
        balance += delta;
      }
    }
    return balance;
  }

  /** Element i is the closing balance of day i + 1, for days 1..throughDay. */
  closingBalances(accountId: AccountId, throughDay: Day): bigint[] {
    const book = this.bookFor(accountId);
    if (!Number.isInteger(throughDay) || throughDay < 0) {
      throw new RangeError(`throughDay must be a non-negative integer, got ${throughDay}`);
    }
    let balance = book.account.openingBalanceMinor;
    const balances: bigint[] = [];
    for (let day = 1; day <= throughDay; day++) {
      balance += book.deltaByValueDay.get(day) ?? 0n;
      balances.push(balance);
    }
    return balances;
  }

  private bookFor(accountId: AccountId): AccountBook {
    const book = this.books.get(accountId);
    if (book === undefined) {
      throw new Error(`Unknown account: ${accountId}`);
    }
    return book;
  }

  private validate(draft: EntryDraft): void {
    const account = this.bookFor(draft.accountId).account;
    if (draft.currency !== account.currency) {
      throw new Error(
        `Currency ${draft.currency} does not match account ${account.id} (${account.currency})`,
      );
    }
    if (!isPositiveInteger(draft.valueDate) || !isPositiveInteger(draft.bookingDay)) {
      throw new Error("valueDate and bookingDay must be positive integers");
    }
    if (draft.valueDate > draft.bookingDay) {
      throw new Error(
        `Future value dating: valueDate ${draft.valueDate} > bookingDay ${draft.bookingDay}`,
      );
    }
    if (draft.amountMinor === 0n) {
      throw new Error("Entry amount must be non-zero");
    }
  }

  private store(draft: EntryDraft): LedgerEntry {
    const entry: LedgerEntry = Object.freeze({
      ...draft,
      entryId: formatEntryId(this.log.length + 1),
    });
    const book = this.bookFor(entry.accountId);
    const previous = book.deltaByValueDay.get(entry.valueDate) ?? 0n;
    book.deltaByValueDay.set(entry.valueDate, previous + entry.amountMinor);
    book.entries.push(entry);
    this.log.push(entry);
    if (entry.sourceEventId !== undefined) {
      pushTo(this.bySourceEvent, entry.sourceEventId, entry);
    }
    return entry;
  }
}
