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
    // Forma de pagamento (opcional). Código de app/lib/payment-methods ou null.
    paymentMethod: z.string().optional().nullable(),
    // BLOCO B — vendedor da venda (id de usuário) ou null. Opcional: com a
    // flag desligada o campo nunca é preenchido e o payload fica idêntico.
    sellerUserId: z.string().optional().nullable(),
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

    // Bloco B — entrada + parcelamento do saldo. Campos de FORMULÁRIO: o
    // payload enviado é o `installmentPlan` derivado deles (ver
    // installment-plan.ts). Ausentes/false ⇒ venda à vista, fluxo atual.
    splitPayment: z.boolean().optional(),
    downPayment: z.number().optional().nullable(),

    // Itens de venda balcão (Fase 2). Opcional → preserva 100% o fluxo atual
    // sem itens. Persistido em ReceivableItem (receivable-only) na rota
    // (Fase 4). Quando presente, totalAmount continua editável pelo usuário;
    // a UI (Fase 5) é que pré-preenche.
    //
    // Cada item é CADASTRADO (productId, sem description) OU MANUAL
    // (description em texto livre, sem productId). O superRefine garante que
    // pelo menos um identificador esteja presente. scrapId é opcional em ambos
    // (vínculo de sucata por item).
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
            // Bloco F — opt-in "criar no catálogo" da linha do item manual.
            // Ausente = false no backend (default da coluna) = comportamento
            // atual; o item segue como venda avulsa sem produto.
            createCatalogProduct: z.boolean().optional(),
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

    // Bloco A — linhas de pagamento (PIX + dinheiro + cartão na mesma venda).
    // Opcional → sem o campo, o fluxo de uma forma só é byte-idêntico ao atual.
    // O fechamento (soma == totalAmount) é validado no superRefine, porque
    // depende de outro campo do formulário.
    payments: z
      .array(
        z.object({
          method: z.string().min(1, "Selecione a forma de pagamento"),
          amount: z.number().positive("Valor deve ser maior que zero"),
          // Só UI: quanto o cliente entregou em dinheiro, para calcular troco.
          // Nunca é enviado ao backend — troco é diferença de caixa e não é
          // persistido em lugar nenhum.
          tendered: z.number().optional().nullable(),
        }),
      )
      .optional(),
  })
  .superRefine((data, ctx) => {
    // Bloco B — entrada tem de existir e ser MENOR que o total. Entrada igual
    // ao total é venda à vista (desligue o parcelamento); maior é erro de
    // digitação. Entrada zero é fiado puro, que tem caminho próprio.
    if (data.splitPayment) {
      const entrada = Math.round(Number(data.downPayment ?? 0) * 100);
      const total = Math.round(Number(data.totalAmount ?? 0) * 100);
      if (entrada <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["downPayment"],
          message: "Informe o valor da entrada",
        });
      } else if (entrada >= total) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["downPayment"],
          message:
            "A entrada precisa ser menor que o total — para venda à vista, desligue o parcelamento",
        });
      } else if ((data.installments ?? 1) > total - entrada) {
        // Não dá para dividir R$ 3,00 em 400 parcelas.
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["installments"],
          message: "Parcelas demais para o saldo",
        });
      }
    }

    // Fechamento de caixa: a soma tem de bater com o total da venda.
    // Comparação em CENTAVOS INTEIROS — em float, 0.1 + 0.2 !== 0.3 e uma
    // venda legítima em três formas seria rejeitada por um centavo.
    if (Array.isArray(data.payments) && data.payments.length > 0) {
      const cents = (v: number) => Math.round(Number(v ?? 0) * 100);
      const soma = data.payments.reduce((acc, p) => acc + cents(p.amount), 0);
      // Com entrada + parcelas, as linhas de pagamento descrevem O QUE ENTROU
      // AGORA (a entrada). O saldo vira contas a receber e ainda não foi pago
      // por forma nenhuma. Precisa casar com a regra do backend
      // (finance.usecase.validatePayments), senão as duas se contradizem e a
      // venda fica impossível de salvar.
      const alvo = data.splitPayment
        ? cents(data.downPayment ?? 0)
        : cents(data.totalAmount);
      const oQue = data.splitPayment ? "a entrada" : "o total da venda";
      if (soma !== alvo) {
        const diff = (Math.abs(soma - alvo) / 100).toFixed(2);
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["payments"],
          message:
            soma < alvo
              ? `Faltam R$ ${diff} para fechar ${oQue}`
              : `Os pagamentos excedem ${oQue} em R$ ${diff}`,
        });
      }
    }

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
  paymentMethod: null,
  // BLOCO B — sem vendedor por padrão. Quem preenche é o formulário, com quem
  // está logado, e só quando a flag da UI está ligada.
  sellerUserId: null,
  totalAmount: 0,
  fineAmount: null,
  finePercent: null,
  interestPercent: null,
  toleranceDays: null,
  installments: 1,
  periodDays: 30,
  dueDate: "",
  splitPayment: false,
  downPayment: null,
};
