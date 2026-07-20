import tempfile
import unittest
import uuid
from pathlib import Path

from hakui.config import BackendConfig, Config, OcrConfig, ReceiptConfig, ServerConfig, StorageConfig
from hakui.database import Database


class DatabaseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.database = Database(Config(
            server=ServerConfig("127.0.0.1", 3004, "http://127.0.0.1:3004"),
            backend=BackendConfig("127.0.0.1", 3005),
            storage=StorageConfig(root / "hakui.sqlite", root / "backups", root / "missing.csv"),
            receipts=ReceiptConfig(12_000_000, 25_000_000),
            ocr=OcrConfig(("eng",), 30, 1, False),
        ))

    def tearDown(self) -> None:
        self.database.close()
        self.temporary.cleanup()

    def test_initializes_and_round_trips_transaction(self) -> None:
        snapshot = self.database.snapshot()
        transaction_id = str(uuid.uuid4())
        created = self.database.upsert_transaction({
            "id": transaction_id,
            "legId": snapshot["legs"][0]["id"],
            "categoryId": snapshot["categories"][0]["id"],
            "merchant": "Test merchant",
            "amountYen": 1200,
            "transactionDate": "2026-07-20",
            "paymentMethod": "cash",
            "purchaseTiming": "during_trip",
            "notes": "",
            "source": "manual",
            "status": "confirmed",
            "revision": 1,
        })
        self.assertEqual(created["id"], transaction_id)
        self.assertEqual(self.database.health()["transactions"], 1)

    def test_recovers_interrupted_ocr_jobs(self) -> None:
        snapshot = self.database.snapshot()
        transaction_id = str(uuid.uuid4())
        receipt_id = str(uuid.uuid4())
        self.database.upsert_transaction({
            "id": transaction_id, "legId": None, "categoryId": None, "merchant": "Receipt scan", "amountYen": 0,
            "transactionDate": None, "paymentMethod": "unknown", "purchaseTiming": "during_trip", "notes": "",
            "source": "scan", "status": "pending_ocr", "revision": 1,
        })
        self.database.create_receipt(receipt_id, transaction_id, b"image", "application/octet-stream", 1)
        claimed = self.database.claim_ocr_job()
        self.assertEqual(claimed[0], receipt_id)
        self.database.recover_ocr_jobs()
        self.assertEqual(self.database.get_receipt(receipt_id)["ocrState"], "queued")

    def test_ocr_does_not_overwrite_a_newer_user_edit(self) -> None:
        transaction_id = str(uuid.uuid4())
        receipt_id = str(uuid.uuid4())
        original = {
            "id": transaction_id, "legId": None, "categoryId": None, "merchant": "Receipt scan", "amountYen": 0,
            "transactionDate": None, "paymentMethod": "unknown", "purchaseTiming": "during_trip", "notes": "",
            "source": "scan", "status": "pending_ocr", "revision": 1,
        }
        self.database.create_receipt_upload(receipt_id, original, b"image", "application/octet-stream")
        self.database.upsert_transaction({
            **original, "merchant": "Corrected", "transactionDate": "2026-07-20", "status": "confirmed", "revision": 2,
        })
        self.database.complete_receipt(receipt_id, "OCR", {
            "merchant": "Wrong OCR", "amountYen": 999, "transactionDate": "2026-07-19", "paymentMethod": "cash",
            "confidence": 0.9, "totalSourceLine": "合計 999", "usedTranslationFallback": False,
        }, "image/jpeg")
        transaction = next(item for item in self.database.snapshot()["transactions"] if item["id"] == transaction_id)
        self.assertEqual(transaction["merchant"], "Corrected")
        self.assertEqual(transaction["transactionDate"], "2026-07-20")
        self.assertEqual(transaction["status"], "confirmed")
        self.assertEqual(transaction["revision"], 2)

    def test_ocr_completion_advances_server_revision(self) -> None:
        transaction_id = str(uuid.uuid4())
        receipt_id = str(uuid.uuid4())
        transaction = {
            "id": transaction_id, "legId": None, "categoryId": None, "merchant": "Receipt scan", "amountYen": 0,
            "transactionDate": None, "paymentMethod": "unknown", "purchaseTiming": "during_trip", "notes": "",
            "source": "scan", "status": "pending_ocr", "revision": 1,
        }
        self.database.create_receipt_upload(receipt_id, transaction, b"image", "application/octet-stream")
        self.database.complete_receipt(receipt_id, "OCR", {
            "merchant": "Lawson", "amountYen": 500, "transactionDate": "2026-07-20", "paymentMethod": "cash",
            "confidence": 0.9, "totalSourceLine": "合計 500", "usedTranslationFallback": False,
        }, "image/jpeg")
        completed = next(item for item in self.database.snapshot()["transactions"] if item["id"] == transaction_id)
        self.assertEqual(completed["amountYen"], 500)
        self.assertEqual(completed["status"], "needs_review")
        self.assertEqual(completed["revision"], 1)


if __name__ == "__main__":
    unittest.main()
