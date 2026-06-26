import { z } from "zod";
import { isValidCpf, onlyDigits } from "@/app/lib/masks";

// Schema do Orçamento (BLOCO 1). Espelha o financeEntrySchema nos blocos
// REUSADOS (cliente existente/rápido + itens de venda balcão, com os MESMOS
// nomes de campo `customerId`/`quickCreateCustomer`/`newCustomerName`/
// `newCustomerCpf`/`items`/`reason`/`totalAmount`, para o CustomerStep e o
// ProductPickerBlock funcionarem sem alteração), mas SEM encargos, parcelamento
// nem dueDate. Campos próprios: `notes` e `validUntil`.
export const budgetSchema = z
  .object({
    customerId: z.string().optional().default(""),

    quickCreateCustomer: z.boolean().optional().default(false),
    newCustomerName: z.string().optional().nullable(),
    newCustomerCpf: z.string().optional().nullable(),

    unidadeId: z.string().optional().nullable(),
    // Vendedor atribuído (id do colaborador/admin). Opcional.
    vendedorId: z.string().optional().nullable(),

    document: z.string().max(100).optional().nullable(),
    reason: z.string().max(200).optional().nullable(),
    // Observações / condições do orçamento (texto livre).
    notes: z.string().max(1000).optional().nullable(),
    totalAmount: z
      .number({ invalid_type_error: "Informe o valor total" })
      .positive("Valor deve ser maior que zero"),

    // Validade do orçamento (data). Opcional — alimenta o badge EXPIRADO.
    validUntil: z.string().optional().nullable(),

    // Itens — MESMA forma do balcão (cadastrado OU manual). Reuso direto do
    // ProductPickerBlock, que escreve neste array.
    items: z
      .array(
        z
          .object({
            productId: z.string().min(1).optional().nullable(),
            description: z
              .string()
              .trim()
              .min(1, "Descrição obrigatória")
              .max(200, "Descrição muito longa (máx. 200)")
              .optional()
              .nullable(),
            scrapId: z.string().optional().nullable(),
            listingId: z.string().optional().nullable(),
            quantity: z.number().int().positive("Quantidade deve ser positiva"),
            unitPrice: z.number().nonnegative("Preço unitário deve ser ≥ 0"),
          })
          .superRefine((it, ctx) => {
            const hasProduct = !!it.productId && it.productId.length > 0;
            const hasDescription =
              !!it.description && it.description.trim().length > 0;
            if (!hasProduct && !hasDescription) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["description"],
                message:
                  "Informe um produto cadastrado ou a descrição do item manual",
              });
            }
          }),
      )
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (data.quickCreateCustomer) {
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
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["customerId"],
        message: "Selecione um cliente",
      });
    }
  });

export type BudgetFormData = z.infer<typeof budgetSchema>;

export const DEFAULT_BUDGET_VALUES: BudgetFormData = {
  customerId: "",
  quickCreateCustomer: false,
  newCustomerName: "",
  newCustomerCpf: "",
  unidadeId: null,
  vendedorId: null,
  document: "",
  reason: "",
  notes: "",
  totalAmount: 0,
  validUntil: "",
};
