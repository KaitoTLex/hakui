import unittest

from hakui.importer import parse_english_date, parse_yen


class ImporterTests(unittest.TestCase):
    def test_parses_integer_yen(self) -> None:
        self.assertEqual(parse_yen("¥23,222"), 23222)
        self.assertEqual(parse_yen("￥ 170"), 170)
        self.assertIsNone(parse_yen(""))
        self.assertIsNone(parse_yen("12.50"))

    def test_parses_english_date_without_timezone(self) -> None:
        self.assertEqual(parse_english_date("July 15, 2026"), "2026-07-15")
        self.assertIsNone(parse_english_date("not a date"))
        self.assertIsNone(parse_english_date(None))


if __name__ == "__main__":
    unittest.main()
