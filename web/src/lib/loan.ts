export type Loan = { borrower: string; facility?: string; maturity?: string };

/** Rounds store the loan as one string; the app writes JSON, older rounds may hold plain text. */
export function parseLoan(raw: string): Loan {
  try {
    const v = JSON.parse(raw);
    if (v && typeof v.borrower === "string") return v;
  } catch {
    /* plain text */
  }
  return { borrower: raw };
}

export const encodeLoan = (loan: Loan) => JSON.stringify(loan);
