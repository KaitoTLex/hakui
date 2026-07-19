import { describe, expect, it } from 'vitest';
import { parseReceiptLines, type OcrLine } from './receipt-parser';

function lines(values: string[]): OcrLine[] {
  return values.map((text, index) => ({ text, confidence: 90, top: index * 20, left: 0 }));
}

describe('Japanese receipt parsing', () => {
  it('extracts a labeled total while rejecting larger cash tendered values', () => {
    const result = parseReceiptLines(lines([
      'ローソン 新大阪店',
      '2026年7月19日',
      '小計 ¥1,000',
      '消費税 ¥100',
      '合計 ¥1,100',
      'お預り ¥2,000',
      'お釣り ¥900',
      '現金'
    ]));

    expect(result.merchant).toBe('ローソン 新大阪店');
    expect(result.amountYen).toBe(1100);
    expect(result.transactionDate).toBe('2026-07-19');
    expect(result.paymentMethod).toBe('cash');
    expect(result.totalSourceLine).toContain('合計');
  });

  it('uses an amount on the line following a total label', () => {
    const result = parseReceiptLines(lines(['株式会社テスト', 'ご請求額', '¥3,525', 'VISA']));
    expect(result.amountYen).toBe(3525);
    expect(result.paymentMethod).toBe('card');
  });

  it('keeps uncertain receipts empty rather than choosing the largest number', () => {
    const result = parseReceiptLines(lines(['レシート', '商品A ¥300', '商品B ¥500', 'お預り ¥2,000']));
    expect(result.amountYen).toBeNull();
    expect(result.confidence).toBe(0);
  });

  it('marks translation-based extraction as low-confidence fallback', () => {
    const result = parseReceiptLines(lines(['店舗', '商品 ¥450', '金額 ¥800']), 'Store\nAmount due');
    expect(result.amountYen).toBe(800);
    expect(result.usedTranslationFallback).toBe(true);
    expect(result.confidence).toBeLessThan(0.5);
  });
});
