import { z } from 'zod';

export const transactionInputSchema = z.object({
  id: z.uuid(),
  legId: z.uuid().nullable(),
  categoryId: z.uuid().nullable(),
  merchant: z.string().trim().min(1).max(160),
  amountYen: z.number().int().min(0).max(100_000_000),
  transactionDate: z.iso.date().nullable(),
  paymentMethod: z.enum(['cash', 'card', 'unknown']),
  purchaseTiming: z.enum(['during_trip', 'pre_trip']),
  notes: z.string().max(2000),
  source: z.enum(['manual', 'scan', 'csv']),
  status: z.enum(['confirmed', 'needs_review', 'pending_ocr']),
  revision: z.number().int().min(1)
});

export const settingsSchema = z.object({
  overallBudgetYen: z.number().int().min(0).max(1_000_000_000),
  currentLegId: z.uuid().nullable(),
  legs: z.array(
    z.object({
      id: z.uuid(),
      budgetYen: z.number().int().min(0).max(1_000_000_000),
      startsOn: z.iso.date().nullable(),
      endsOn: z.iso.date().nullable()
    })
  )
});
