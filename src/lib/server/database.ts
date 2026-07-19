import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config';
import { importFinanceCsv } from './importer';
import type { AppSnapshot, Category, Leg, OcrExtraction, Receipt, Transaction, TransactionInput, Trip } from '$lib/types';

let instance: Database.Database | undefined;

const categorySeeds = [
  ['Accommodation', '#d96c9d'],
  ['Transportation', '#54aaa7'],
  ['Meals', '#ef8c62'],
  ['Snacks & Drinks', '#e9b44c'],
  ['Convenience Stores', '#6fbb78'],
  ['Attractions & Tickets', '#678dd7'],
  ['Entertainment & Events', '#9f79d1'],
  ['Shopping & Souvenirs', '#e05f88'],
  ['Health & Personal Care', '#56a6bd'],
  ['Fees & Taxes', '#8b8794'],
  ['Cash & ATM', '#a98a62'],
  ['Other', '#98909c']
] as const;

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS trips (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      currency TEXT NOT NULL CHECK (currency = 'JPY'),
      overall_budget_yen INTEGER NOT NULL DEFAULT 0 CHECK (overall_budget_yen >= 0),
      starts_on TEXT,
      ends_on TEXT,
      active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
      current_leg_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS legs (
      id TEXT PRIMARY KEY,
      trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      budget_yen INTEGER NOT NULL DEFAULT 0 CHECK (budget_yen >= 0),
      starts_on TEXT,
      ends_on TEXT,
      sort_order INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (trip_id, name)
    );

    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      leg_id TEXT REFERENCES legs(id) ON DELETE SET NULL,
      category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
      merchant TEXT NOT NULL,
      amount_yen INTEGER NOT NULL CHECK (amount_yen >= 0),
      transaction_date TEXT,
      payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'card', 'unknown')),
      purchase_timing TEXT NOT NULL CHECK (purchase_timing IN ('during_trip', 'pre_trip')),
      notes TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL CHECK (source IN ('manual', 'scan', 'csv')),
      status TEXT NOT NULL CHECK (status IN ('confirmed', 'needs_review', 'pending_ocr')),
      revision INTEGER NOT NULL DEFAULT 1,
      receipt_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS receipts (
      id TEXT PRIMARY KEY,
      transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
      image BLOB NOT NULL,
      mime_type TEXT NOT NULL,
      ocr_state TEXT NOT NULL CHECK (ocr_state IN ('queued', 'processing', 'complete', 'failed')),
      ocr_text TEXT,
      extracted_json TEXT,
      confidence REAL,
      processing_error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS import_rows (
      source_hash TEXT NOT NULL,
      source_row INTEGER NOT NULL,
      transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
      PRIMARY KEY (source_hash, source_row)
    );

    CREATE INDEX IF NOT EXISTS transactions_trip_date ON transactions(trip_id, transaction_date);
    CREATE INDEX IF NOT EXISTS transactions_leg ON transactions(leg_id);
    CREATE INDEX IF NOT EXISTS transactions_category ON transactions(category_id);
  `);
}

function seed(db: Database.Database): void {
  const tripCount = (db.prepare('SELECT COUNT(*) AS count FROM trips').get() as { count: number }).count;
  if (tripCount === 0) {
    const tripId = randomUUID();
    db.prepare("INSERT INTO trips (id, name, currency, active) VALUES (?, 'Japan 2026', 'JPY', 1)").run(tripId);
    const insertLeg = db.prepare('INSERT INTO legs (id, trip_id, name, sort_order) VALUES (?, ?, ?, ?)');
    ['Osaka', 'Kyoto', 'Tokyo'].forEach((name, index) => insertLeg.run(randomUUID(), tripId, name, index));
    const firstLeg = db.prepare('SELECT id FROM legs WHERE trip_id = ? ORDER BY sort_order LIMIT 1').get(tripId) as { id: string };
    db.prepare('UPDATE trips SET current_leg_id = ? WHERE id = ?').run(firstLeg.id, tripId);
  }

  const insertCategory = db.prepare(
    'INSERT OR IGNORE INTO categories (id, name, color, sort_order) VALUES (?, ?, ?, ?)'
  );
  categorySeeds.forEach(([name, color], index) => insertCategory.run(randomUUID(), name, color, index));
}

function maybeImportCsv(db: Database.Database): void {
  const config = loadConfig();
  const count = (db.prepare('SELECT COUNT(*) AS count FROM transactions').get() as { count: number }).count;
  if (count === 0 && existsSync(config.storage.initialCsvPath)) {
    importFinanceCsv(db, config.storage.initialCsvPath);
  }
}

export function getDatabase(): Database.Database {
  if (instance) return instance;
  const config = loadConfig();
  mkdirSync(dirname(config.storage.databasePath), { recursive: true });
  instance = new Database(config.storage.databasePath);
  instance.pragma('journal_mode = WAL');
  instance.pragma('foreign_keys = ON');
  instance.pragma('busy_timeout = 5000');
  migrate(instance);
  seed(instance);
  maybeImportCsv(instance);
  return instance;
}

function mapTrip(row: Record<string, unknown>): Trip {
  return {
    id: String(row.id),
    name: String(row.name),
    currency: 'JPY',
    overallBudgetYen: Number(row.overall_budget_yen),
    startsOn: row.starts_on ? String(row.starts_on) : null,
    endsOn: row.ends_on ? String(row.ends_on) : null,
    active: Boolean(row.active)
  };
}

function mapLeg(row: Record<string, unknown>): Leg {
  return {
    id: String(row.id),
    tripId: String(row.trip_id),
    name: String(row.name),
    budgetYen: Number(row.budget_yen),
    startsOn: row.starts_on ? String(row.starts_on) : null,
    endsOn: row.ends_on ? String(row.ends_on) : null,
    sortOrder: Number(row.sort_order)
  };
}

function mapCategory(row: Record<string, unknown>): Category {
  return {
    id: String(row.id),
    name: String(row.name),
    color: String(row.color),
    sortOrder: Number(row.sort_order),
    active: Boolean(row.active)
  };
}

function mapTransaction(row: Record<string, unknown>): Transaction {
  return {
    id: String(row.id),
    tripId: String(row.trip_id),
    legId: row.leg_id ? String(row.leg_id) : null,
    categoryId: row.category_id ? String(row.category_id) : null,
    merchant: String(row.merchant),
    amountYen: Number(row.amount_yen),
    transactionDate: row.transaction_date ? String(row.transaction_date) : null,
    paymentMethod: row.payment_method as Transaction['paymentMethod'],
    purchaseTiming: row.purchase_timing as Transaction['purchaseTiming'],
    notes: String(row.notes),
    source: row.source as Transaction['source'],
    status: row.status as Transaction['status'],
    revision: Number(row.revision),
    receiptId: row.receipt_id ? String(row.receipt_id) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export function getSnapshot(): AppSnapshot {
  const db = getDatabase();
  const tripRow = db.prepare('SELECT * FROM trips WHERE active = 1 LIMIT 1').get() as Record<string, unknown>;
  return {
    trip: mapTrip(tripRow),
    legs: (db.prepare('SELECT * FROM legs WHERE trip_id = ? ORDER BY sort_order').all(tripRow.id) as Record<string, unknown>[]).map(
      mapLeg
    ),
    categories: (db.prepare('SELECT * FROM categories ORDER BY sort_order').all() as Record<string, unknown>[]).map(mapCategory),
    transactions: (
      db.prepare('SELECT * FROM transactions WHERE trip_id = ? AND deleted_at IS NULL ORDER BY transaction_date DESC, created_at DESC').all(
        tripRow.id
      ) as Record<string, unknown>[]
    ).map(mapTransaction),
    currentLegId: tripRow.current_leg_id ? String(tripRow.current_leg_id) : null
  };
}

export function getTransactionRevision(id: string): number | null {
  const row = getDatabase().prepare('SELECT revision FROM transactions WHERE id = ?').get(id) as { revision: number } | undefined;
  return row?.revision ?? null;
}

export function upsertTransaction(input: TransactionInput): Transaction {
  const db = getDatabase();
  const trip = db.prepare('SELECT id FROM trips WHERE active = 1 LIMIT 1').get() as { id: string };
  const existing = db.prepare('SELECT * FROM transactions WHERE id = ?').get(input.id) as Record<string, unknown> | undefined;
  if (existing) {
    const same =
      Number(existing.revision) === input.revision &&
      existing.leg_id === input.legId &&
      existing.category_id === input.categoryId &&
      existing.merchant === input.merchant &&
      Number(existing.amount_yen) === input.amountYen &&
      existing.transaction_date === input.transactionDate &&
      existing.payment_method === input.paymentMethod &&
      existing.purchase_timing === input.purchaseTiming &&
      existing.notes === input.notes &&
      existing.source === input.source &&
      existing.status === input.status &&
      existing.deleted_at === null;
    if (same) return mapTransaction(existing);
    if (input.revision !== Number(existing.revision) + 1) {
      throw new Error('A newer or conflicting version of this transaction already exists.');
    }
  } else if (input.revision !== 1) {
    throw new Error('A new transaction must start at revision 1.');
  }

  db.prepare(`
    INSERT INTO transactions (
      id, trip_id, leg_id, category_id, merchant, amount_yen, transaction_date,
      payment_method, purchase_timing, notes, source, status, revision
    ) VALUES (@id, @tripId, @legId, @categoryId, @merchant, @amountYen, @transactionDate,
      @paymentMethod, @purchaseTiming, @notes, @source, @status, @revision)
    ON CONFLICT(id) DO UPDATE SET
      leg_id = excluded.leg_id,
      category_id = excluded.category_id,
      merchant = excluded.merchant,
      amount_yen = excluded.amount_yen,
      transaction_date = excluded.transaction_date,
      payment_method = excluded.payment_method,
      purchase_timing = excluded.purchase_timing,
      notes = excluded.notes,
      source = excluded.source,
      status = excluded.status,
      revision = excluded.revision,
      deleted_at = NULL,
      updated_at = CURRENT_TIMESTAMP
  `).run({ ...input, tripId: trip.id });

  return mapTransaction(db.prepare('SELECT * FROM transactions WHERE id = ?').get(input.id) as Record<string, unknown>);
}

export function deleteTransaction(id: string, expectedRevision: number): void {
  const db = getDatabase();
  const existing = db.prepare('SELECT revision, deleted_at FROM transactions WHERE id = ?').get(id) as
    | { revision: number; deleted_at: string | null }
    | undefined;
  if (!existing) return;
  if (existing.deleted_at && existing.revision === expectedRevision + 1) return;
  if (existing.deleted_at || existing.revision !== expectedRevision) {
    throw new Error('This transaction changed before it could be deleted.');
  }
  db.prepare('UPDATE transactions SET deleted_at = CURRENT_TIMESTAMP, revision = revision + 1 WHERE id = ? AND revision = ?').run(
    id,
    expectedRevision
  );
}

export function updateTripSettings(input: {
  overallBudgetYen: number;
  currentLegId: string | null;
  legs: Array<{ id: string; budgetYen: number; startsOn: string | null; endsOn: string | null }>;
}): void {
  const db = getDatabase();
  const trip = db.prepare('SELECT id FROM trips WHERE active = 1 LIMIT 1').get() as { id: string };
  const update = db.transaction(() => {
    db.prepare('UPDATE trips SET overall_budget_yen = ?, current_leg_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
      input.overallBudgetYen,
      input.currentLegId,
      trip.id
    );
    const updateLeg = db.prepare(
      'UPDATE legs SET budget_yen = ?, starts_on = ?, ends_on = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND trip_id = ?'
    );
    input.legs.forEach((leg) => updateLeg.run(leg.budgetYen, leg.startsOn, leg.endsOn, leg.id, trip.id));
  });
  update();
}

export function getReceipt(id: string): (Receipt & { image: Buffer }) | null {
  const row = getDatabase().prepare('SELECT * FROM receipts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: String(row.id),
    transactionId: String(row.transaction_id),
    mimeType: String(row.mime_type),
    ocrState: row.ocr_state as Receipt['ocrState'],
    ocrText: row.ocr_text ? String(row.ocr_text) : null,
    extractedJson: row.extracted_json ? String(row.extracted_json) : null,
    confidence: row.confidence === null ? null : Number(row.confidence),
    processingError: row.processing_error ? String(row.processing_error) : null,
    image: row.image as Buffer
  };
}

export function createReceipt(id: string, transactionId: string, image: Uint8Array, mimeType: string): Receipt['ocrState'] {
  const db = getDatabase();
  const existing = db.prepare('SELECT ocr_state FROM receipts WHERE id = ?').get(id) as { ocr_state: Receipt['ocrState'] } | undefined;
  if (existing) return existing.ocr_state;
  const insert = db.transaction(() => {
    db.prepare("INSERT INTO receipts (id, transaction_id, image, mime_type, ocr_state) VALUES (?, ?, ?, ?, 'queued')").run(
      id,
      transactionId,
      Buffer.from(image),
      mimeType
    );
    db.prepare('UPDATE transactions SET receipt_id = ? WHERE id = ?').run(id, transactionId);
  });
  insert();
  return 'queued';
}

export function beginReceipt(id: string): void {
  getDatabase().prepare("UPDATE receipts SET ocr_state = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
}

export function completeReceipt(id: string, text: string, extraction: OcrExtraction, detectedMimeType: string): void {
  const db = getDatabase();
  const receipt = db.prepare('SELECT transaction_id FROM receipts WHERE id = ?').get(id) as { transaction_id: string };
  const transaction = db.prepare('SELECT * FROM transactions WHERE id = ?').get(receipt.transaction_id) as Record<string, unknown>;
  const complete = db.transaction(() => {
    db.prepare(`UPDATE receipts SET mime_type = ?, ocr_state = 'complete', ocr_text = ?, extracted_json = ?, confidence = ?, processing_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
      detectedMimeType,
      text,
      JSON.stringify(extraction),
      extraction.confidence,
      id
    );
    db.prepare(`
      UPDATE transactions SET merchant = ?, amount_yen = ?, transaction_date = ?, payment_method = ?,
        status = 'needs_review', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      String(transaction.merchant) === 'Receipt scan' && extraction.merchant ? extraction.merchant : transaction.merchant,
      Number(transaction.amount_yen) === 0 && extraction.amountYen !== null ? extraction.amountYen : transaction.amount_yen,
      extraction.transactionDate ?? transaction.transaction_date,
      String(transaction.payment_method) === 'unknown' && extraction.paymentMethod !== 'unknown'
        ? extraction.paymentMethod
        : transaction.payment_method,
      receipt.transaction_id
    );
  });
  complete();
}

export function failReceipt(id: string, message: string): void {
  const db = getDatabase();
  const receipt = db.prepare('SELECT transaction_id FROM receipts WHERE id = ?').get(id) as { transaction_id: string } | undefined;
  const fail = db.transaction(() => {
    db.prepare("UPDATE receipts SET ocr_state = 'failed', processing_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(
      message.slice(0, 1000),
      id
    );
    if (receipt) db.prepare("UPDATE transactions SET status = 'needs_review', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(receipt.transaction_id);
  });
  fail();
}
