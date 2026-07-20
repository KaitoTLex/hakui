from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class OcrLine:
    text: str
    confidence: float
    top: int
    left: int


POSITIVE_LABELS = (
    "合計", "総計", "税込合計", "合計金額", "お会計", "お買上げ計", "お買上計", "ご請求額", "支払額", "今回計", "現計",
    "total", "grand total", "amount due", "payment amount",
)
NEGATIVE_LABELS = ("小計", "消費税", "内税", "外税", "値引", "割引", "お預り", "預り", "お釣り", "おつり", "釣銭", "subtotal")


def normalized(value: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", value).replace("￥", "¥")).strip()


def amounts(value: str) -> list[int]:
    result: list[int] = []
    for match in re.finditer(r"(?:¥\s*)?([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{2,8})\s*円?", normalized(value)):
        amount = int(match.group(1).replace(",", ""))
        if 0 < amount <= 100_000_000:
            result.append(amount)
    return result


def iso_date(value: str) -> str | None:
    match = re.search(r"(20\d{2})\s*(?:年|[/.-])\s*(\d{1,2})\s*(?:月|[/.-])\s*(\d{1,2})\s*日?", normalized(value))
    if not match:
        return None
    month, day = int(match.group(2)), int(match.group(3))
    if not 1 <= month <= 12 or not 1 <= day <= 31:
        return None
    return f"{match.group(1)}-{month:02d}-{day:02d}"


def payment(value: str) -> str:
    text = normalized(value).lower()
    if re.search(r"クレジット|カード|visa|master|jcb|amex", text):
        return "card"
    if re.search(r"現金|cash", text):
        return "cash"
    return "unknown"


def merchant(lines: list[OcrLine]) -> str | None:
    for line in lines[:10]:
        text = normalized(line.text)
        if not 2 <= len(text) <= 80 or iso_date(text) or len(amounts(text)) > 1:
            continue
        if re.search(r"領収書|レシート|receipt|電話|tel|〒|登録番号", text, re.IGNORECASE):
            continue
        if re.search(r"[A-Za-z\u3040-\u30ff\u3400-\u9fff]", text):
            return text
    return None


def parse_tsv(tsv: str) -> list[OcrLine]:
    grouped: dict[str, dict[str, Any]] = {}
    for row in tsv.splitlines()[1:]:
        columns = row.split("\t")
        if len(columns) < 12 or columns[0] != "5":
            continue
        word = "\t".join(columns[11:]).strip()
        if not word:
            continue
        key = ":".join(columns[1:5])
        item = grouped.setdefault(key, {"words": [], "confidence": [], "top": int(columns[7]), "left": int(columns[6])})
        item["words"].append(word)
        confidence = float(columns[10])
        if confidence >= 0:
            item["confidence"].append(confidence)

    lines = []
    for item in grouped.values():
        confidences = item["confidence"]
        lines.append(OcrLine(
            text=" ".join(item["words"]),
            confidence=sum(confidences) / len(confidences) if confidences else 0,
            top=item["top"],
            left=item["left"],
        ))
    return sorted(lines, key=lambda line: (line.top, line.left))


def parse_receipt_lines(lines: list[OcrLine], translated_text: str = "") -> dict[str, Any]:
    amount_yen: int | None = None
    source_line: str | None = None
    best_score = float("-inf")

    for index, line in enumerate(lines):
        text = normalized(line.text).lower()
        if any(label.lower() in text for label in NEGATIVE_LABELS):
            continue
        if not any(label.lower() in text for label in POSITIVE_LABELS):
            continue
        current_amounts = amounts(text)
        following = lines[index + 1] if index + 1 < len(lines) else None
        candidates = current_amounts or (amounts(following.text) if following else [])
        for candidate in candidates:
            score = 100 + line.confidence + (20 if current_amounts else 0) + index / max(len(lines), 1) * 10
            if score > best_score:
                best_score = score
                amount_yen = candidate
                source_line = line.text if current_amounts else f"{line.text} / {following.text if following else ''}"

    used_translation = False
    if amount_yen is None and re.search(r"\b(total|amount due|payment amount)\b", translated_text, re.IGNORECASE):
        used_translation = True
        eligible = [line for line in lines if not any(label in normalized(line.text) for label in NEGATIVE_LABELS)]
        candidates = [(amount, line) for line in eligible[len(eligible) // 2:] for amount in amounts(line.text)]
        if candidates:
            amount_yen, selected = max(candidates, key=lambda candidate: candidate[0])
            source_line = selected.text
            best_score = 55

    return {
        "merchant": merchant(lines),
        "amountYen": amount_yen,
        "transactionDate": next((date for line in lines if (date := iso_date(line.text))), None),
        "paymentMethod": next((method for line in lines if (method := payment(line.text)) != "unknown"), "unknown"),
        "confidence": 0 if amount_yen is None else min(0.99, max(0.25, best_score / 220)),
        "totalSourceLine": source_line,
        "usedTranslationFallback": used_translation,
    }


def lines_to_text(lines: list[OcrLine]) -> str:
    return "\n".join(line.text for line in lines)
