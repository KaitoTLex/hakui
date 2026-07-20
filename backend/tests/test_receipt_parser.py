import unittest

from hakui.receipt_parser import OcrLine, parse_receipt_lines


def lines(values: list[str]) -> list[OcrLine]:
    return [OcrLine(text=value, confidence=90, top=index * 20, left=0) for index, value in enumerate(values)]


class ReceiptParserTests(unittest.TestCase):
    def test_extracts_labeled_total_and_rejects_cash_tendered(self) -> None:
        result = parse_receipt_lines(lines([
            "ローソン 新大阪店", "2026年7月19日", "小計 ¥1,000", "消費税 ¥100",
            "合計 ¥1,100", "お預り ¥2,000", "お釣り ¥900", "現金",
        ]))
        self.assertEqual(result["merchant"], "ローソン 新大阪店")
        self.assertEqual(result["amountYen"], 1100)
        self.assertEqual(result["transactionDate"], "2026-07-19")
        self.assertEqual(result["paymentMethod"], "cash")

    def test_uses_amount_after_total_label(self) -> None:
        result = parse_receipt_lines(lines(["株式会社テスト", "ご請求額", "¥3,525", "VISA"]))
        self.assertEqual(result["amountYen"], 3525)
        self.assertEqual(result["paymentMethod"], "card")

    def test_does_not_guess_without_total_label(self) -> None:
        result = parse_receipt_lines(lines(["レシート", "商品A ¥300", "商品B ¥500", "お預り ¥2,000"]))
        self.assertIsNone(result["amountYen"])
        self.assertEqual(result["confidence"], 0)

    def test_translation_is_low_confidence_fallback(self) -> None:
        result = parse_receipt_lines(lines(["店舗", "商品 ¥450", "金額 ¥800"]), "Store\nAmount due")
        self.assertEqual(result["amountYen"], 800)
        self.assertTrue(result["usedTranslationFallback"])
        self.assertLess(result["confidence"], 0.5)


if __name__ == "__main__":
    unittest.main()
