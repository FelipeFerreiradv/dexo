import { z } from "zod";
import { isValidCpf, onlyDigits } from "@/app/lib/masks";

export const financeEntrySchema = z
  .object({
    // Opcional na base: a obrigatoriedade é decidida no superRefine conforme
    // o modo (cliente existente vs. cadastro rápido).
    customerId: z.string().optional().default(""),

    // Cadastro rápido de cliente (Alteração B) — CPF-only, opcional.
    quickCreateCustomer: z.boolean().optional().default(false),
    newCustomerName: z.string().optional().nullable(),
    newCustomerCpf: z.string().optional().nullable(),

    // Opcional: conta pode não ter unidade (contas antigas e fluxo sem unidade).
    unidadeId: z.string().optional().nullable(),

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
  })
  .superRefine((data, ctx) => {
    if (data.quickCreateCustomer) {
      // Modo cadastro rápido: exige Nome; CPF é opcional (igual à aba
      // Clientes), validado apenas se preenchido.
      if (!data.newCustomerName || data.newCustomerName.trim().length < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["newCustomerName"],
          message: "Nome do cliente é obrigatório",
        });
      }
      if (
        data.newCustomerCpf &&
        onlyDigits(data.newCustomerCpf).length > 0 &&
        !isValidCpf(data.newCustomerCpf)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["newCustomerCpf"],
          message: "CPF inválido",
        });
      }
    } else if (!data.customerId || data.customerId.length < 1) {
      // Fluxo atual inalterado: cliente existente é obrigatório,
      // mesma mensagem de antes.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["customerId"],
        message: "Selecione um cliente",
      });
    }
  });

export type FinanceEntryFormData = z.infer<typeof financeEntrySchema>;

export const DEFAULT_FINANCE_VALUES: FinanceEntryFormData = {
  customerId: "",
  quickCreateCustomer: false,
  newCustomerName: "",
  newCustomerCpf: "",
  unidadeId: null,
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
