export type PaymentMethod = 'cash' | 'card' | 'unknown';
export type PurchaseTiming = 'during_trip' | 'pre_trip';
export type TransactionStatus = 'confirmed' | 'needs_review' | 'pending_ocr';
export type TransactionSource = 'manual' | 'scan' | 'csv';

export interface Trip {
  id: string;
  name: string;
  currency: 'JPY';
  overallBudgetYen: number;
  startsOn: string | null;
  endsOn: string | null;
  active: boolean;
  settingsRevision: number;
}

export interface Leg {
  id: string;
  tripId: string;
  name: string;
  budgetYen: number;
  startsOn: string | null;
  endsOn: string | null;
  sortOrder: number;
}

export interface Category {
  id: string;
  name: string;
  color: string;
  sortOrder: number;
  active: boolean;
}

export interface Transaction {
  id: string;
  tripId: string;
  legId: string | null;
  categoryId: string | null;
  merchant: string;
  amountYen: number;
  transactionDate: string | null;
  paymentMethod: PaymentMethod;
  purchaseTiming: PurchaseTiming;
  notes: string;
  source: TransactionSource;
  status: TransactionStatus;
  revision: number;
  receiptId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Receipt {
  id: string;
  transactionId: string;
  mimeType: string;
  ocrState: 'queued' | 'processing' | 'complete' | 'failed';
  ocrText: string | null;
  extractedJson: string | null;
  confidence: number | null;
  processingError: string | null;
}

export interface OcrExtraction {
  merchant: string | null;
  amountYen: number | null;
  transactionDate: string | null;
  paymentMethod: PaymentMethod;
  confidence: number;
  totalSourceLine: string | null;
  usedTranslationFallback: boolean;
}

export interface AppSnapshot {
  trip: Trip;
  legs: Leg[];
  categories: Category[];
  transactions: Transaction[];
  currentLegId: string | null;
}

export interface TransactionInput {
  id: string;
  legId: string | null;
  categoryId: string | null;
  merchant: string;
  amountYen: number;
  transactionDate: string | null;
  paymentMethod: PaymentMethod;
  purchaseTiming: PurchaseTiming;
  notes: string;
  source: TransactionSource;
  status: TransactionStatus;
  revision: number;
}

export interface SettingsInput {
  operationId: string;
  expectedRevision: number;
  overallBudgetYen: number;
  currentLegId: string | null;
  legs: Array<{
    id: string;
    budgetYen: number;
    startsOn: string | null;
    endsOn: string | null;
  }>;
}
