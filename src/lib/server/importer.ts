import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';
import type Database from 'better-sqlite3';
import type { PaymentMethod, PurchaseTiming, TransactionStatus } from '$lib/types';

interface FinanceRow {
  Expense?: string;
  Cost?: string;
  'Date of Transaction'?: string;
  'Segment of Pipeline'?: string;
  Text?: string;
  Type?: string;
}

export interface ImportSummary {
  imported: number;
  skipped: number;
  needsReview: number;
  totalYen: number;
}

const months: Record<string, string> = {
  january: '01',
  february: '02',
  march: '03',
  april: '04',
  may: '05',
  june: '06',
  july: '07',
  august: '08',
  september: '09',
  october: '10',
  november: '11',
  december: '12'
};

export function parseYen(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const normalized = value.replace(/[¥￥,\s]/g, '');
  if (!/^\d+$/.test(normalized)) return null;
  return Number.parseInt(normalized, 10);
}

export function parseEnglishDate(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  const match = value.trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (!match) return null;
  const month = months[match[1].toLowerCase()];
  if (!month) return null;
  return `${match[3]}-${month}-${match[2].padStart(2, '0')}`;
}

function categoryFor(merchant: string, notes: string): string {
  const text = `${merchant} ${notes}`.toLowerCase();
  if (/hotel|hostel|ryokan|airbnb/.test(text)) return 'Accommodation';
  if (/train|rapit|metro|subway|bus|taxi|jr\b/.test(text)) return 'Transportation';
  if (/pharmacy|drug|hair product|medicine/.test(text)) return 'Health & Personal Care';
  if (/lawson|fami|familymart|7-eleven|combini/.test(text)) return 'Convenience Stores';
  if (/tea|coffee|ucc|ito en|drink/.test(text)) return 'Snacks & Drinks';
  if (/ticket|museum|stadium|baseball|kofun/.test(text)) return 'Attractions & Tickets';
  if (/conan|subaru|citizen|merch|souvenir|stuff/.test(text)) return 'Shopping & Souvenirs';
  if (/tax|fee/.test(text)) return 'Fees & Taxes';
  if (/getting .*yen|atm|cash withdrawal/.test(text)) return 'Cash & ATM';
  if (/karaage|kaarage|restaurant|ramen|food|meal/.test(text)) return 'Meals';
  return 'Other';
}

function paymentFor(value: string): PaymentMethod {
  const normalized = value.toLowerCase();
  if (normalized.includes('card')) return 'card';
  if (normalized.includes('cash')) return 'cash';
  return 'unknown';
}

function timingFor(type: string, notes: string): { timing: PurchaseTiming; inferred: boolean } {
  if (/pa(?:id|yed) before trip/i.test(type)) return { timing: 'pre_trip', inferred: false };
  if (/purchased before trip/i.test(notes)) return { timing: 'pre_trip', inferred: true };
  return { timing: 'during_trip', inferred: false };
}

export function importFinanceCsv(db: Database.Database, csvPath: string): ImportSummary {
  const source = readFileSync(csvPath);
  const sourceHash = createHash('sha256').update(source).digest('hex');
  const rows = parse(source.toString('utf8').replace(/^\uFEFF/, ''), {
    columns: true,
    skip_empty_lines: false,
    trim: true,
    relax_column_count: true
  }) as FinanceRow[];

  const trip = db.prepare('SELECT id FROM trips WHERE active = 1 LIMIT 1').get() as { id: string };
  const legs = new Map(
    (db.prepare('SELECT id, lower(name) AS name FROM legs WHERE trip_id = ?').all(trip.id) as Array<{ id: string; name: string }>).map(
      (leg) => [leg.name, leg.id]
    )
  );
  const categories = new Map(
    (db.prepare('SELECT id, name FROM categories').all() as Array<{ id: string; name: string }>).map((category) => [
      category.name,
      category.id
    ])
  );

  const alreadyImported = db.prepare('SELECT 1 FROM import_rows WHERE source_hash = ? AND source_row = ?');
  const recordImport = db.prepare('INSERT INTO import_rows (source_hash, source_row, transaction_id) VALUES (?, ?, ?)');
  const insert = db.prepare(`
    INSERT INTO transactions (
      id, trip_id, leg_id, category_id, merchant, amount_yen, transaction_date,
      payment_method, purchase_timing, notes, source, status, revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'csv', ?, 1)
  `);

  const summary: ImportSummary = { imported: 0, skipped: 0, needsReview: 0, totalYen: 0 };
  const run = db.transaction(() => {
    rows.forEach((row, index) => {
      const sourceRow = index + 2;
      const merchant = row.Expense?.trim() ?? '';
      const amountYen = parseYen(row.Cost);
      if (!merchant && amountYen === null) return;
      if (alreadyImported.get(sourceHash, sourceRow)) {
        summary.skipped += 1;
        return;
      }

      const notes = row.Text?.trim() ?? '';
      const paymentMethod = paymentFor(row.Type ?? '');
      const { timing, inferred } = timingFor(row.Type ?? '', notes);
      const transactionDate = parseEnglishDate(row['Date of Transaction']);
      const legId = legs.get((row['Segment of Pipeline'] ?? '').trim().toLowerCase()) ?? null;
      const categoryName = categoryFor(merchant, notes);
      const categoryId = categories.get(categoryName) ?? null;
      const status: TransactionStatus =
        !merchant || amountYen === null || !transactionDate || !legId || paymentMethod === 'unknown' || categoryName === 'Other' || inferred
          ? 'needs_review'
          : 'confirmed';
      const id = randomUUID();
      insert.run(
        id,
        trip.id,
        legId,
        categoryId,
        merchant || 'Untitled expense',
        amountYen ?? 0,
        transactionDate,
        paymentMethod,
        timing,
        notes,
        status
      );
      recordImport.run(sourceHash, sourceRow, id);
      summary.imported += 1;
      summary.totalYen += amountYen ?? 0;
      if (status === 'needs_review') summary.needsReview += 1;
    });
  });
  run();
  return summary;
}
