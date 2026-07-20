from __future__ import annotations

import csv
import hashlib
import re
import sqlite3
import uuid
from pathlib import Path
from typing import Any


MONTHS = {
    "january": "01", "february": "02", "march": "03", "april": "04", "may": "05", "june": "06",
    "july": "07", "august": "08", "september": "09", "october": "10", "november": "11", "december": "12",
}


def parse_yen(value: str | None) -> int | None:
    if not value or not value.strip():
        return None
    normalized = re.sub(r"[¥￥,\s]", "", value)
    return int(normalized) if normalized.isdigit() else None


def parse_english_date(value: str | None) -> str | None:
    if not value or not value.strip():
        return None
    match = re.fullmatch(r"([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})", value.strip())
    if not match or match.group(1).lower() not in MONTHS:
        return None
    return f"{match.group(3)}-{MONTHS[match.group(1).lower()]}-{int(match.group(2)):02d}"


def category_for(merchant: str, notes: str) -> str:
    text = f"{merchant} {notes}".lower()
    rules = (
        (r"hotel|hostel|ryokan|airbnb", "Accommodation"),
        (r"train|rapit|metro|subway|bus|taxi|jr\b", "Transportation"),
        (r"pharmacy|drug|hair product|medicine", "Health & Personal Care"),
        (r"lawson|fami|familymart|7-eleven|combini", "Convenience Stores"),
        (r"tea|coffee|ucc|ito en|drink", "Snacks & Drinks"),
        (r"ticket|museum|stadium|baseball|kofun", "Attractions & Tickets"),
        (r"conan|subaru|citizen|merch|souvenir|stuff", "Shopping & Souvenirs"),
        (r"tax|fee", "Fees & Taxes"),
        (r"getting .*yen|atm|cash withdrawal", "Cash & ATM"),
        (r"karaage|kaarage|restaurant|ramen|food|meal", "Meals"),
    )
    return next((category for pattern, category in rules if re.search(pattern, text)), "Other")


def import_finance_csv(db: sqlite3.Connection, csv_path: Path) -> dict[str, int]:
    source = csv_path.read_bytes()
    source_hash = hashlib.sha256(source).hexdigest()
    rows = csv.DictReader(source.decode("utf-8-sig").splitlines())
    trip = db.execute("SELECT id FROM trips WHERE active = 1 LIMIT 1").fetchone()
    if trip is None:
        raise RuntimeError("No active trip exists")
    legs = {row["name"].lower(): row["id"] for row in db.execute("SELECT id, name FROM legs WHERE trip_id = ?", (trip["id"],))}
    categories = {row["name"]: row["id"] for row in db.execute("SELECT id, name FROM categories")}
    summary = {"imported": 0, "skipped": 0, "needsReview": 0, "totalYen": 0}

    for index, row in enumerate(rows, start=2):
        merchant = (row.get("Expense") or "").strip()
        amount = parse_yen(row.get("Cost"))
        if not merchant and amount is None:
            continue
        if db.execute("SELECT 1 FROM import_rows WHERE source_hash = ? AND source_row = ?", (source_hash, index)).fetchone():
            summary["skipped"] += 1
            continue
        notes = (row.get("Text") or "").strip()
        type_value = row.get("Type") or ""
        payment = "card" if "card" in type_value.lower() else "cash" if "cash" in type_value.lower() else "unknown"
        explicitly_pretrip = bool(re.search(r"pa(?:id|yed) before trip", type_value, re.IGNORECASE))
        inferred_pretrip = not explicitly_pretrip and bool(re.search(r"purchased before trip", notes, re.IGNORECASE))
        timing = "pre_trip" if explicitly_pretrip or inferred_pretrip else "during_trip"
        transaction_date = parse_english_date(row.get("Date of Transaction"))
        leg_id = legs.get((row.get("Segment of Pipeline") or "").strip().lower())
        category = category_for(merchant, notes)
        status = "needs_review" if (
            not merchant or amount is None or not transaction_date or not leg_id or payment == "unknown" or category == "Other" or inferred_pretrip
        ) else "confirmed"
        transaction_id = str(uuid.uuid4())
        db.execute(
            """INSERT INTO transactions (
                id, trip_id, leg_id, category_id, merchant, amount_yen, transaction_date,
                payment_method, purchase_timing, notes, source, status, revision
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'csv', ?, 1)""",
            (transaction_id, trip["id"], leg_id, categories.get(category), merchant or "Untitled expense", amount or 0,
             transaction_date, payment, timing, notes, status),
        )
        db.execute("INSERT INTO import_rows (source_hash, source_row, transaction_id) VALUES (?, ?, ?)", (source_hash, index, transaction_id))
        summary["imported"] += 1
        summary["totalYen"] += amount or 0
        summary["needsReview"] += int(status == "needs_review")
    return summary
