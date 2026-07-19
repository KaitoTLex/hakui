import type { RequestHandler } from './$types';
import { stringify } from 'csv-stringify/sync';
import { getSnapshot } from '$lib/server/database';

function spreadsheetSafe(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

export const GET: RequestHandler = () => {
  const snapshot = getSnapshot();
  const legs = new Map(snapshot.legs.map((leg) => [leg.id, leg.name]));
  const categories = new Map(snapshot.categories.map((category) => [category.id, category.name]));
  const csv = stringify(
    snapshot.transactions.map((transaction) => ({
      Expense: spreadsheetSafe(transaction.merchant),
      Cost: transaction.amountYen,
      Date: transaction.transactionDate ?? '',
      Leg: transaction.legId ? legs.get(transaction.legId) : '',
      Category: transaction.categoryId ? categories.get(transaction.categoryId) : '',
      Payment: transaction.paymentMethod,
      Timing: transaction.purchaseTiming,
      Notes: spreadsheetSafe(transaction.notes),
      Status: transaction.status
    })),
    { header: true }
  );
  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="hakui-transactions.csv"'
    }
  });
};
