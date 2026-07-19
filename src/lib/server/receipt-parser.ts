import type { OcrExtraction, PaymentMethod } from '$lib/types';

export interface OcrLine {
  text: string;
  confidence: number;
  top: number;
  left: number;
}

const positiveLabels = [
  '合計', '総計', '税込合計', '合計金額', 'お会計', 'お買上げ計', 'お買上計', 'ご請求額', '支払額', '今回計', '現計',
  'total', 'grand total', 'amount due', 'payment amount'
];
const negativeLabels = ['小計', '消費税', '内税', '外税', '値引', '割引', 'お預り', '預り', 'お釣り', 'おつり', '釣銭', 'subtotal'];

function normalized(value: string): string {
  return value.normalize('NFKC').replace(/[￥]/g, '¥').replace(/\s+/g, ' ').trim();
}

function amounts(value: string): number[] {
  const result: number[] = [];
  const matches = normalized(value).matchAll(/(?:¥\s*)?([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{2,8})\s*円?/g);
  for (const match of matches) {
    const amount = Number.parseInt(match[1].replaceAll(',', ''), 10);
    if (Number.isSafeInteger(amount) && amount > 0 && amount <= 100_000_000) result.push(amount);
  }
  return result;
}

function isoDate(value: string): string | null {
  const text = normalized(value);
  const match = text.match(/(20\d{2})\s*(?:年|[/.\-])\s*(\d{1,2})\s*(?:月|[/.\-])\s*(\d{1,2})\s*日?/);
  if (!match) return null;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
}

function payment(value: string): PaymentMethod {
  const text = normalized(value).toLowerCase();
  if (/クレジット|カード|visa|master|jcb|amex/.test(text)) return 'card';
  if (/現金|cash/.test(text)) return 'cash';
  return 'unknown';
}

function merchant(lines: OcrLine[]): string | null {
  for (const line of lines.slice(0, 10)) {
    const text = normalized(line.text);
    if (text.length < 2 || text.length > 80) continue;
    if (isoDate(text) || amounts(text).length > 1) continue;
    if (/領収書|レシート|receipt|電話|tel|〒|登録番号/i.test(text)) continue;
    if (!/[A-Za-z\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) continue;
    return text;
  }
  return null;
}

export function parseTsv(tsv: string): OcrLine[] {
  const grouped = new Map<string, { words: string[]; confidence: number[]; top: number; left: number }>();
  for (const row of tsv.split(/\r?\n/).slice(1)) {
    const columns = row.split('\t');
    if (columns.length < 12 || columns[0] !== '5') continue;
    const word = columns.slice(11).join('\t').trim();
    if (!word) continue;
    const key = `${columns[1]}:${columns[2]}:${columns[3]}:${columns[4]}`;
    const item = grouped.get(key) ?? { words: [], confidence: [], top: Number(columns[7]), left: Number(columns[6]) };
    item.words.push(word);
    const confidence = Number(columns[10]);
    if (confidence >= 0) item.confidence.push(confidence);
    grouped.set(key, item);
  }
  return [...grouped.values()]
    .map((item) => ({
      text: item.words.join(' '),
      confidence: item.confidence.length ? item.confidence.reduce((sum, value) => sum + value, 0) / item.confidence.length : 0,
      top: item.top,
      left: item.left
    }))
    .sort((a, b) => a.top - b.top || a.left - b.left);
}

export function parseReceiptLines(lines: OcrLine[], translatedText = ''): OcrExtraction {
  let amountYen: number | null = null;
  let sourceLine: string | null = null;
  let bestScore = -Infinity;

  lines.forEach((line, index) => {
    const text = normalized(line.text).toLowerCase();
    if (negativeLabels.some((label) => text.includes(label.toLowerCase()))) return;
    const label = positiveLabels.find((candidate) => text.includes(candidate.toLowerCase()));
    if (!label) return;
    const candidates = amounts(text);
    const next = lines[index + 1];
    const candidateAmounts = candidates.length ? candidates : next ? amounts(next.text) : [];
    for (const amount of candidateAmounts) {
      const score = 100 + line.confidence + (candidates.length ? 20 : 0) + index / Math.max(lines.length, 1) * 10;
      if (score > bestScore) {
        bestScore = score;
        amountYen = amount;
        sourceLine = candidates.length ? line.text : `${line.text} / ${next?.text ?? ''}`;
      }
    }
  });

  let usedTranslationFallback = false;
  if (amountYen === null && /\b(total|amount due|payment amount)\b/i.test(translatedText)) {
    usedTranslationFallback = true;
    const eligible = lines.filter((line) => !negativeLabels.some((label) => normalized(line.text).includes(label)));
    const lowerHalf = eligible.slice(Math.floor(eligible.length / 2));
    const fallback = lowerHalf.flatMap((line) => amounts(line.text).map((amount) => ({ amount, line })));
    if (fallback.length) {
      const selected = fallback.reduce((best, candidate) => candidate.amount > best.amount ? candidate : best);
      amountYen = selected.amount;
      sourceLine = selected.line.text;
      bestScore = 55;
    }
  }

  const date = lines.map((line) => isoDate(line.text)).find(Boolean) ?? null;
  const paymentMethod = lines.map((line) => payment(line.text)).find((value) => value !== 'unknown') ?? 'unknown';
  const confidence = amountYen === null ? 0 : Math.min(0.99, Math.max(0.25, bestScore / 220));
  return {
    merchant: merchant(lines),
    amountYen,
    transactionDate: date,
    paymentMethod,
    confidence,
    totalSourceLine: sourceLine,
    usedTranslationFallback
  };
}

export function linesToText(lines: OcrLine[]): string {
  return lines.map((line) => line.text).join('\n');
}
