import { z } from "zod";

export const financeEntrySchema = z.object({
  customerId: z.string().min(1, "Selecione um cliente"),

  document: z.string().max(100).optional().nullable(),
  reason: z.string().max(200).optional().nullable(),
  debtDetails: z.string().max(1000).optional().nullable(),
  totalAmount: z
    .number({ invalid_type_error: "Informe o valor total" })
    .positive("Valor deve ser maior que zero"),

  fineAmount: z.number().min(0).optional().nullable(),
  finePercent: z.number().min(0).max(100).optional().nullable(),
  interestPercent: z.number().min(0).max(100).optional().nullable(),
  toleranceDays: z
    .number()
    .int()
    .min(0, "Tolerância deve ser zero ou positiva")
    .optional()
    .nullable(),

  installments: z
    .number()
    .int()
    .min(1, "Mínimo 1 parcela")
    .max(360, "Máximo 360 parcelas"),
  periodDays: z.number().int().min(0).optional().nullable(),
  dueDate: z.string().min(1, "Data de vencimento é obrigatória"),
});

export type FinanceEntryFormData = z.infer<typeof financeEntrySchema>;

export const DEFAULT_FINANCE_VALUES: FinanceEntryFormData = {
  customerId: "",
  document: "",
  reason: "",
  debtDetails: "",
  totalAmount: 0,
  fineAmount: null,
  finePercent: null,
  interestPercent: null,
  toleranceDays: null,
  installments: 1,
  periodDays: 30,
  dueDate: "",
};
