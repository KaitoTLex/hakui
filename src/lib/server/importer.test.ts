import { describe, expect, it } from 'vitest';
import { parseEnglishDate, parseYen } from './importer';

describe('CSV finance parsing', () => {
  it('converts formatted yen to integer values', () => {
    expect(parseYen('¥23,222')).toBe(23222);
    expect(parseYen('￥ 170')).toBe(170);
    expect(parseYen('')).toBeNull();
    expect(parseYen('12.50')).toBeNull();
  });

  it('converts the Notion date format without timezone shifts', () => {
    expect(parseEnglishDate('July 15, 2026')).toBe('2026-07-15');
    expect(parseEnglishDate('not a date')).toBeNull();
    expect(parseEnglishDate(undefined)).toBeNull();
  });
});
