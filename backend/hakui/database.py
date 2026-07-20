from __future__ import annotations

import json
import logging
import sqlite3
import threading
import uuid
from contextlib import nullcontext
from pathlib import Path
from typing import Any

from .config import Config
from .importer import import_finance_csv


logger = logging.getLogger(__name__)

CATEGORY_SEEDS = (
    ("Accommodation", "#d96c9d"),
    ("Transportation", "#54aaa7"),
    ("Meals", "#ef8c62"),
    ("Snacks & Drinks", "#e9b44c"),
    ("Convenience Stores", "#6fbb78"),
    ("Attractions & Tickets", "#678dd7"),
    ("Entertainment & Events", "#9f79d1"),
    ("Shopping & Souvenirs", "#e05f88"),
    ("Health & Personal Care", "#56a6bd"),
    ("Fees & Taxes", "#8b8794"),
    ("Cash & ATM", "#a98a62"),
    ("Other", "#98909c"),
)


class ConflictError(Exception):
    pass


class Database:
    def __init__(self, config: Config):
        self.config = config
        self.lock = threading.RLock()
        self.startup_warning: str | None = None
        config.storage.database_path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(config.storage.database_path, timeout=5, check_same_thread=False)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA journal_mode = WAL")
        self.connection.execute("PRAGMA foreign_keys = ON")
        self.connection.execute("PRAGMA busy_timeout = 5000")
        self._migrate()
        self._seed()
        self._maybe_import_csv()
        self.recover_ocr_jobs()

    def close(self) -> None:
        with self.lock:
            self.connection.close()

    def _migrate(self) -> None:
        with self.lock, self.connection:
            self.connection.executescript(
                """
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
                  input_revision INTEGER,
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
                CREATE INDEX IF NOT EXISTS receipts_ocr_state ON receipts(ocr_state, created_at);
                INSERT OR IGNORE INTO schema_migrations (version) VALUES (1);
                """
            )
            receipt_columns = {row["name"] for row in self.connection.execute("PRAGMA table_info(receipts)")}
            if "input_revision" not in receipt_columns:
                self.connection.execute("ALTER TABLE receipts ADD COLUMN input_revision INTEGER")
                self.connection.execute(
                    """UPDATE receipts SET input_revision = (
                         SELECT revision FROM transactions WHERE transactions.id = receipts.transaction_id
                       ) WHERE ocr_state IN ('queued', 'processing')"""
                )

    def _seed(self) -> None:
        with self.lock, self.connection:
            count = self.connection.execute("SELECT COUNT(*) FROM trips").fetchone()[0]
            if count == 0:
                trip_id = str(uuid.uuid4())
                self.connection.execute("INSERT INTO trips (id, name, currency, active) VALUES (?, 'Japan 2026', 'JPY', 1)", (trip_id,))
                first_leg_id = None
                for sort_order, name in enumerate(("Osaka", "Kyoto", "Tokyo")):
                    leg_id = str(uuid.uuid4())
                    first_leg_id = first_leg_id or leg_id
                    self.connection.execute(
                        "INSERT INTO legs (id, trip_id, name, sort_order) VALUES (?, ?, ?, ?)",
                        (leg_id, trip_id, name, sort_order),
                    )
                self.connection.execute("UPDATE trips SET current_leg_id = ? WHERE id = ?", (first_leg_id, trip_id))
            for sort_order, (name, color) in enumerate(CATEGORY_SEEDS):
                self.connection.execute(
                    "INSERT OR IGNORE INTO categories (id, name, color, sort_order) VALUES (?, ?, ?, ?)",
                    (str(uuid.uuid4()), name, color, sort_order),
                )

    def _maybe_import_csv(self) -> None:
        with self.lock:
            count = self.connection.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
            path = self.config.storage.initial_csv_path
            if count or not path.exists():
                return
            try:
                with self.connection:
                    import_finance_csv(self.connection, path)
            except Exception as error:
                self.startup_warning = f"Initial CSV import skipped: {error}"
                logger.exception("Initial CSV import failed; continuing with an empty database")

    @staticmethod
    def _trip(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"], "name": row["name"], "currency": "JPY",
            "overallBudgetYen": row["overall_budget_yen"], "startsOn": row["starts_on"],
            "endsOn": row["ends_on"], "active": bool(row["active"]),
        }

    @staticmethod
    def _leg(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"], "tripId": row["trip_id"], "name": row["name"], "budgetYen": row["budget_yen"],
            "startsOn": row["starts_on"], "endsOn": row["ends_on"], "sortOrder": row["sort_order"],
        }

    @staticmethod
    def _category(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"], "name": row["name"], "color": row["color"],
            "sortOrder": row["sort_order"], "active": bool(row["active"]),
        }

    @staticmethod
    def _transaction(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"], "tripId": row["trip_id"], "legId": row["leg_id"], "categoryId": row["category_id"],
            "merchant": row["merchant"], "amountYen": row["amount_yen"], "transactionDate": row["transaction_date"],
            "paymentMethod": row["payment_method"], "purchaseTiming": row["purchase_timing"], "notes": row["notes"],
            "source": row["source"], "status": row["status"], "revision": row["revision"], "receiptId": row["receipt_id"],
            "createdAt": row["created_at"], "updatedAt": row["updated_at"],
        }

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            trip = self.connection.execute("SELECT * FROM trips WHERE active = 1 LIMIT 1").fetchone()
            if trip is None:
                raise RuntimeError("No active trip exists")
            legs = self.connection.execute("SELECT * FROM legs WHERE trip_id = ? ORDER BY sort_order", (trip["id"],)).fetchall()
            categories = self.connection.execute("SELECT * FROM categories ORDER BY sort_order").fetchall()
            transactions = self.connection.execute(
                "SELECT * FROM transactions WHERE trip_id = ? AND deleted_at IS NULL ORDER BY transaction_date DESC, created_at DESC",
                (trip["id"],),
            ).fetchall()
            return {
                "trip": self._trip(trip),
                "legs": [self._leg(row) for row in legs],
                "categories": [self._category(row) for row in categories],
                "transactions": [self._transaction(row) for row in transactions],
                "currentLegId": trip["current_leg_id"],
            }

    def health(self) -> dict[str, Any]:
        with self.lock:
            self.connection.execute("SELECT 1").fetchone()
            queued = self.connection.execute("SELECT COUNT(*) FROM receipts WHERE ocr_state IN ('queued', 'processing')").fetchone()[0]
            transactions = self.connection.execute("SELECT COUNT(*) FROM transactions WHERE deleted_at IS NULL").fetchone()[0]
        result: dict[str, Any] = {"status": "ok", "database": "ok", "transactions": transactions, "ocrPending": queued}
        if self.startup_warning:
            result["warning"] = self.startup_warning
        return result

    def transaction_revision(self, transaction_id: str) -> int | None:
        with self.lock:
            row = self.connection.execute("SELECT revision FROM transactions WHERE id = ?", (transaction_id,)).fetchone()
            return row["revision"] if row else None

    def upsert_transaction(self, data: dict[str, Any], *, commit: bool = True) -> dict[str, Any]:
        with self.lock, self.connection if commit else nullcontext():
            trip = self.connection.execute("SELECT id FROM trips WHERE active = 1 LIMIT 1").fetchone()
            if trip is None:
                raise RuntimeError("No active trip exists")
            existing = self.connection.execute("SELECT * FROM transactions WHERE id = ?", (data["id"],)).fetchone()
            if existing:
                same = (
                    existing["revision"] == data["revision"] and existing["leg_id"] == data["legId"] and
                    existing["category_id"] == data["categoryId"] and existing["merchant"] == data["merchant"] and
                    existing["amount_yen"] == data["amountYen"] and existing["transaction_date"] == data["transactionDate"] and
                    existing["payment_method"] == data["paymentMethod"] and existing["purchase_timing"] == data["purchaseTiming"] and
                    existing["notes"] == data["notes"] and existing["source"] == data["source"] and
                    existing["status"] == data["status"] and existing["deleted_at"] is None
                )
                if same:
                    return self._transaction(existing)
                if data["revision"] != existing["revision"] + 1:
                    raise ConflictError("A newer or conflicting version of this transaction already exists.")
            elif data["revision"] != 1:
                raise ConflictError("A new transaction must start at revision 1.")

            self.connection.execute(
                """INSERT INTO transactions (
                  id, trip_id, leg_id, category_id, merchant, amount_yen, transaction_date,
                  payment_method, purchase_timing, notes, source, status, revision
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  leg_id = excluded.leg_id, category_id = excluded.category_id, merchant = excluded.merchant,
                  amount_yen = excluded.amount_yen, transaction_date = excluded.transaction_date,
                  payment_method = excluded.payment_method, purchase_timing = excluded.purchase_timing,
                  notes = excluded.notes, source = excluded.source, status = excluded.status,
                  revision = excluded.revision, deleted_at = NULL, updated_at = CURRENT_TIMESTAMP""",
                (data["id"], trip["id"], data["legId"], data["categoryId"], data["merchant"], data["amountYen"],
                 data["transactionDate"], data["paymentMethod"], data["purchaseTiming"], data["notes"], data["source"],
                 data["status"], data["revision"]),
            )
            row = self.connection.execute("SELECT * FROM transactions WHERE id = ?", (data["id"],)).fetchone()
            return self._transaction(row)

    def create_receipt_upload(self, receipt_id: str, data: dict[str, Any], image: bytes, mime_type: str) -> None:
        with self.lock, self.connection:
            self.upsert_transaction(data, commit=False)
            self.connection.execute(
                """INSERT INTO receipts (id, transaction_id, image, mime_type, ocr_state, input_revision)
                   VALUES (?, ?, ?, ?, 'queued', ?)""",
                (receipt_id, data["id"], image, mime_type, data["revision"]),
            )
            self.connection.execute("UPDATE transactions SET receipt_id = ? WHERE id = ?", (receipt_id, data["id"]))

    def delete_transaction(self, transaction_id: str, expected_revision: int) -> None:
        with self.lock, self.connection:
            existing = self.connection.execute(
                "SELECT revision, deleted_at FROM transactions WHERE id = ?", (transaction_id,)
            ).fetchone()
            if not existing:
                return
            if existing["deleted_at"] and existing["revision"] == expected_revision + 1:
                return
            if existing["deleted_at"] or existing["revision"] != expected_revision:
                raise ConflictError("This transaction changed before it could be deleted.")
            self.connection.execute(
                "UPDATE transactions SET deleted_at = CURRENT_TIMESTAMP, revision = revision + 1 WHERE id = ? AND revision = ?",
                (transaction_id, expected_revision),
            )

    def update_settings(self, data: dict[str, Any]) -> dict[str, Any]:
        with self.lock, self.connection:
            trip = self.connection.execute("SELECT id FROM trips WHERE active = 1 LIMIT 1").fetchone()
            if trip is None:
                raise RuntimeError("No active trip exists")
            valid_legs = {row["id"] for row in self.connection.execute("SELECT id FROM legs WHERE trip_id = ?", (trip["id"],))}
            if data["currentLegId"] is not None and data["currentLegId"] not in valid_legs:
                raise ValueError("Current leg does not belong to the active trip.")
            if {leg["id"] for leg in data["legs"]} - valid_legs:
                raise ValueError("One or more legs do not belong to the active trip.")
            self.connection.execute(
                "UPDATE trips SET overall_budget_yen = ?, current_leg_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (data["overallBudgetYen"], data["currentLegId"], trip["id"]),
            )
            for leg in data["legs"]:
                self.connection.execute(
                    "UPDATE legs SET budget_yen = ?, starts_on = ?, ends_on = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND trip_id = ?",
                    (leg["budgetYen"], leg["startsOn"], leg["endsOn"], leg["id"], trip["id"]),
                )
        return self.snapshot()

    def get_receipt(self, receipt_id: str, include_image: bool = False) -> dict[str, Any] | None:
        columns = "*" if include_image else "id, transaction_id, mime_type, ocr_state, ocr_text, extracted_json, confidence, processing_error"
        with self.lock:
            row = self.connection.execute(f"SELECT {columns} FROM receipts WHERE id = ?", (receipt_id,)).fetchone()
        if not row:
            return None
        result = {
            "id": row["id"], "transactionId": row["transaction_id"], "mimeType": row["mime_type"],
            "ocrState": row["ocr_state"], "ocrText": row["ocr_text"], "extractedJson": row["extracted_json"],
            "confidence": row["confidence"], "processingError": row["processing_error"],
            "extraction": json.loads(row["extracted_json"]) if row["extracted_json"] else None,
        }
        if include_image:
            result["image"] = row["image"]
        return result

    def create_receipt(self, receipt_id: str, transaction_id: str, image: bytes, mime_type: str, input_revision: int) -> str:
        with self.lock, self.connection:
            existing = self.connection.execute("SELECT ocr_state FROM receipts WHERE id = ?", (receipt_id,)).fetchone()
            if existing:
                return existing["ocr_state"]
            self.connection.execute(
                """INSERT INTO receipts (id, transaction_id, image, mime_type, ocr_state, input_revision)
                   VALUES (?, ?, ?, ?, 'queued', ?)""",
                (receipt_id, transaction_id, image, mime_type, input_revision),
            )
            self.connection.execute("UPDATE transactions SET receipt_id = ? WHERE id = ?", (receipt_id, transaction_id))
            return "queued"

    def requeue_receipt(self, receipt_id: str, image: bytes, mime_type: str, input_revision: int) -> None:
        with self.lock, self.connection:
            self.connection.execute(
                """UPDATE receipts SET image = ?, mime_type = ?, ocr_state = 'queued', processing_error = NULL, input_revision = ?,
                   updated_at = CURRENT_TIMESTAMP WHERE id = ?""",
                (image, mime_type, input_revision, receipt_id),
            )

    def recover_ocr_jobs(self) -> None:
        with self.lock, self.connection:
            self.connection.execute(
                "UPDATE receipts SET ocr_state = 'queued', processing_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE ocr_state = 'processing'"
            )

    def claim_ocr_job(self) -> tuple[str, bytes] | None:
        with self.lock, self.connection:
            row = self.connection.execute(
                "SELECT id, image FROM receipts WHERE ocr_state = 'queued' ORDER BY created_at LIMIT 1"
            ).fetchone()
            if not row:
                return None
            changed = self.connection.execute(
                "UPDATE receipts SET ocr_state = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND ocr_state = 'queued'",
                (row["id"],),
            ).rowcount
            return (row["id"], row["image"]) if changed else None

    def complete_receipt(self, receipt_id: str, text: str, extraction: dict[str, Any], mime_type: str) -> None:
        with self.lock, self.connection:
            receipt = self.connection.execute("SELECT transaction_id, input_revision FROM receipts WHERE id = ?", (receipt_id,)).fetchone()
            if not receipt:
                return
            transaction = self.connection.execute("SELECT * FROM transactions WHERE id = ?", (receipt["transaction_id"],)).fetchone()
            self.connection.execute(
                """UPDATE receipts SET mime_type = ?, ocr_state = 'complete', ocr_text = ?, extracted_json = ?,
                   confidence = ?, processing_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?""",
                (mime_type, text, json.dumps(extraction, ensure_ascii=False), extraction["confidence"], receipt_id),
            )
            if transaction and transaction["revision"] == receipt["input_revision"] and transaction["status"] == "pending_ocr":
                self.connection.execute(
                    """UPDATE transactions SET merchant = ?, amount_yen = ?, transaction_date = ?, payment_method = ?,
                       status = 'needs_review', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND revision = ?""",
                    (extraction["merchant"] if transaction["merchant"] == "Receipt scan" and extraction["merchant"] else transaction["merchant"],
                     extraction["amountYen"] if transaction["amount_yen"] == 0 and extraction["amountYen"] is not None else transaction["amount_yen"],
                     extraction["transactionDate"] or transaction["transaction_date"],
                     extraction["paymentMethod"] if transaction["payment_method"] == "unknown" and extraction["paymentMethod"] != "unknown" else transaction["payment_method"],
                     receipt["transaction_id"], receipt["input_revision"]),
                )

    def fail_receipt(self, receipt_id: str, message: str) -> None:
        with self.lock, self.connection:
            receipt = self.connection.execute("SELECT transaction_id, input_revision FROM receipts WHERE id = ?", (receipt_id,)).fetchone()
            self.connection.execute(
                "UPDATE receipts SET ocr_state = 'failed', processing_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (message[:1000], receipt_id),
            )
            if receipt:
                self.connection.execute(
                    """UPDATE transactions SET status = 'needs_review', updated_at = CURRENT_TIMESTAMP
                       WHERE id = ? AND revision = ? AND status = 'pending_ocr'""",
                    (receipt["transaction_id"], receipt["input_revision"]),
                )
