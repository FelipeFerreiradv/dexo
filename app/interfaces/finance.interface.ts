export type FinanceStatus = "PENDENTE" | "PAGA" | "VENCIDA" | "CANCELADA";
export type FinanceKind = "receivable" | "payable";

export interface FinanceEntry {
  id: string;
  userId: string;
  customerId: string;

  document: string | null;
  reason: string | null;
  debtDetails: string | null;
  totalAmount: number;

  fineAmount: number | null;
  finePercent: number | null;
  interestPercent: number | null;
  toleranceDays: number | null;

  installments: number;
  periodDays: number | null;
  dueDate: Date;

  status: FinanceStatus;
  paidAt: Date | null;

  // Forma de pagamento (código estável de app/lib/payment-methods.ts) ou null.
  paymentMethod: string | null;

  createdAt: Date;
  updatedAt: Date;

  // join
  customer?: {
    id: string;
    name: string;
    cpf: string | null;
    email: string | null;
  } | null;
  unidade?: {
    id: string;
    name: string;
  } | null;

  // Itens de venda balcão — ausente quando não houver. Snapshot do preço no
  // momento da venda (unitPrice é imutável).
  items?: ReceivableItemSnapshot[];

  // Bloco A — linhas de pagamento quando a venda foi paga de forma combinada
  // (PIX + dinheiro + cartão). Ausente/vazio = uma forma só, e aí a verdade
  // está em `paymentMethod`. Quando presente, `paymentMethod` guarda o método
  // PREDOMINANTE (maior valor) e a soma das linhas bate com `totalAmount`.
  payments?: ReceivablePaymentSnapshot[];

  // ── Bloco B: split entrada + parcelas ──
  // Preenchidos SÓ nas contas-parcela. NULL numa conta normal — e é o NULL em
  // 100% das linhas existentes que mantém tudo intacto.
  parentReceivableId?: string | null;
  installmentNumber?: number | null;
  installmentTotal?: number | null;

  // ── BLOCO D: motivo do cancelamento ──
  // Preenchidos só por `POST /receivables/:id/reverse`, e só com a flag
  // ligada. NULL em toda conta não cancelada, em todo cancelamento sem motivo
  // informado e em qualquer conta a PAGAR (o conceito não se aplica lá).
  cancelReasonCode?: string | null;
  cancelReason?: string | null;
  cancelledAt?: Date | null;

  // ── BLOCO B: vendedor da venda ──
  // Quem VENDEU, que pode não ser quem operou o caixa. NULL em venda anterior
  // ao recurso, em lançamento sem vendedor, em toda conta a PAGAR e nas
  // PARCELAS (o vendedor é da venda-mãe, que carrega os itens).
  sellerUserId?: string | null;
  seller?: { id: string; name: string | null; email: string | null } | null;

  // ── BLOCO A (2ª metade): liquidação ──
  // Marca EXPLÍCITA de que o dinheiro caiu. NULL ≠ "não caiu": significa
  // "ninguém marcou", e aí a regra por forma decide em read-time
  // (`saleSettledAt` / `lineSettledAt` em lib/settlement.ts).
  settledAt?: Date | null;

  // ── BLOCO A: conta de destino/origem do dinheiro ──
  // NULL = não informado. Vale para receivable E payable (entrada e saída).
  bankAccountId?: string | null;
  bankAccount?: {
    id: string;
    name: string;
    kind: string | null;
    bankName: string | null;
  } | null;

  // ── BLOCO F: estágio operacional ──
  // Segunda dimensão, ortogonal ao `status`. NULL = venda anterior ao recurso;
  // quem exibe DERIVA para o primeiro estágio (deriveSaleStage). Nunca governa
  // receber, estornar, editar ou emitir nota.
  saleStage?: string | null;

  // Preenchidos só na conta-ENTRADA de uma venda parcelada, e só na listagem
  // do PDV (agregado das filhas). Servem para a tela mostrar o TAMANHO DA
  // VENDA (`totalAmount + installmentsAmount`) sem inflar o caixa do dia, que
  // continua somando apenas o que entrou. Ausentes = venda à vista.
  installmentsCount?: number;
  installmentsAmount?: number;
}

/**
 * Bloco B — plano de parcelamento enviado no ato da venda.
 *
 * As linhas vêm PRONTAS do cliente (que já as exibe na prévia), e o backend
 * valida a soma. Assim não há aritmética de datas duplicada entre front e
 * back, que é a origem clássica de divergência de centavo e de fuso.
 */
export interface InstallmentPlanInput {
  /** Valor recebido no ato. Vira o `totalAmount` da conta-entrada. */
  downPayment: number;
  /** Parcelas do saldo, cada uma vira uma conta a receber própria. */
  installments: Array<{ dueDate: string | Date; amount: number }>;
}

// Bloco A — uma forma de pagamento e o quanto foi pago nela.
export interface ReceivablePaymentInput {
  /** Código estável de app/lib/payment-methods.ts. */
  method: string;
  /** Valor aplicado À VENDA nesta forma. NUNCA o valor entregue pelo cliente:
   *  troco é diferença de caixa e não é persistido em lugar nenhum. */
  amount: number;
  /**
   * BLOCO A — conta de destino DESTA forma ("o PIX caiu no Itaú, o dinheiro
   * ficou no caixa"). Ausente/null ⇒ vale o `Receivable.bankAccountId`, mesma
   * precedência de `ReceivableItem.scrapId`.
   */
  bankAccountId?: string | null;
  /**
   * BLOCO A (2ª metade) — marca explícita de que ESTA forma caiu. Ausente ⇒
   * a regra por forma decide (PIX cai no ato; crédito, não).
   */
  settledAt?: Date | string | null;
}

export interface ReceivablePaymentSnapshot extends ReceivablePaymentInput {
  // Opcional desde a Fase 1.1: o DETALHE (findById) traz o id, a LISTAGEM não.
  // Trafegar um cuid por linha de pagamento em toda página seria egress puro —
  // e nenhum consumidor lê este campo (o único, o mapeamento fiscal em
  // finance.usecase.ts, usa apenas `method` e `amount`).
  id?: string;
  createdAt?: Date;
}

// Cadastro rápido de cliente (Alteração B) — CPF-only, opcional.
export interface NewCustomerInput {
  name: string;
  cpf?: string | null;
}

// Item de venda balcão (Fase 2 — venda balcão → estoque).
// receivable-only: payables nunca recebem items (validado no usecase). Tudo
// opcional na criação para preservar 100% o fluxo atual sem itens.
export interface ReceivableItemInput {
  // Item CADASTRADO: productId setado, description null.
  // Item MANUAL: productId null, description setada (texto livre).
  productId?: string | null;
  description?: string | null;
  // Sucata de origem (override explícito; precede Product.scrapId).
  scrapId?: string | null;
  listingId?: string | null;
  quantity: number;
  unitPrice: number; // snapshot — não acompanha mudanças em Product.price

  // Bloco F — opt-in "criar no catálogo" da linha do item manual. Quando true,
  // o pagamento promove esta peça a Product real (SKU automático), com entrada
  // e saída de estoque na mesma operação. Ausente/false = comportamento atual.
  createCatalogProduct?: boolean;
}

export interface ReceivableItemSnapshot extends ReceivableItemInput {
  id: string;
  product?: { id: string; sku: string; name: string } | null;
  createdAt?: Date;
  // Bloco F — este `productId` nasceu deste item manual? Âncora do estorno
  // simétrico (a saída compensatória só se aplica a estes itens).
  autoCreatedProduct?: boolean;
}

export interface FinanceEntryCreate {
  userId: string;
  customerId: string;
  // Quando presente, o cliente é criado na MESMA transação da conta
  // (atômico). Mutuamente exclusivo com customerId no fluxo de cadastro
  // rápido. Ausente => fluxo atual 100% inalterado.
  newCustomer?: NewCustomerInput;
  unidadeId?: string | null;

  document?: string | null;
  reason?: string | null;
  debtDetails?: string | null;
  totalAmount: number;

  fineAmount?: number | null;
  finePercent?: number | null;
  interestPercent?: number | null;
  toleranceDays?: number | null;

  installments?: number;
  periodDays?: number | null;
  dueDate: string | Date;

  status?: FinanceStatus;
  paidAt?: string | Date | null;

  // Forma de pagamento (opcional/nulável). Ausente = fluxo atual inalterado.
  paymentMethod?: string | null;

  // BLOCO B — vendedor (receivable apenas). AUSENTE (undefined) ⇒ nenhuma
  // chave nova no objeto Prisma ⇒ INSERT byte-idêntico ao de hoje. `null`
  // é explicitamente "sem vendedor".
  sellerUserId?: string | null;

  // BLOCO A — conta de destino (receivable) / origem (payable). Mesma regra:
  // AUSENTE ⇒ nenhuma chave nova; `null` = sem conta.
  bankAccountId?: string | null;

  // Itens de venda balcão — opcional, receivable-only. Ausente = fluxo atual
  // 100% inalterado (nada de estoque/produto). Persistido em `ReceivableItem`
  // na mesma transação da Receivable.
  items?: ReceivableItemInput[];

  // Bloco A — linhas de pagamento, opcional e receivable-only. Ausente = fluxo
  // atual 100% inalterado (só `paymentMethod`). Quando presente, a soma tem de
  // bater com `totalAmount` e o backend deriva `paymentMethod` daqui
  // (predominante), gravando tudo na MESMA transação da Receivable.
  payments?: ReceivablePaymentInput[];

  // Bloco B — opcional e receivable-only. Ausente = fluxo atual 100%
  // inalterado (uma conta só). Presente => o backend cria a conta-entrada
  // (com os itens) + N contas-parcela na MESMA transação, e `totalAmount` do
  // payload passa a significar o TOTAL DA VENDA, que é dividido entre elas.
  installmentPlan?: InstallmentPlanInput;
}

export type FinanceEntryUpdate = Partial<Omit<FinanceEntryCreate, "userId">>;

export interface FinanceListFilters {
  search?: string;
  status?: FinanceStatus;
  /**
   * BLOCO C — filtro por status da VENDA, com múltipla seleção. Lista separada
   * por vírgula no vocabulário de `lib/finance-status-filters.ts`
   * (ABERTA, VENCIDA, RECEBIDA, PARCELADA, FATURADA, CANCELADA), que NÃO é o
   * mesmo dos 4 valores de `FinanceStatus` — três dos rótulos são derivados.
   *
   * Campo NOVO em vez de sobrecarregar `status`: aquele continua aceitando um
   * único `FinanceStatus` literal, como sempre. Ausente ⇒ consulta idêntica.
   */
  statusIn?: string;
  customerId?: string;
  // undefined/ausente = todas (comportamento atual); "sem_unidade" = unidadeId NULL;
  // qualquer outro valor = filtra por aquela unidade.
  unidadeId?: string;
  // Filtro por forma de pagamento (código). Ausente/"" = todas (atual).
  paymentMethod?: string;
  // Filtro "só vendas balcão" (contas com itens) — usado pelo PDV. Ausente/
  // false = todas (comportamento atual, where inalterado). receivable-only:
  // em payable é ignorado (Payable não tem relação items).
  hasItems?: boolean;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

export interface FinanceListResult {
  items: FinanceEntry[];
  total: number;
  totalPages: number;
}

export interface FinanceSummary {
  receivables: {
    totalCount: number;
    totalAmount: number;
    overdueCount: number;
    overdueAmount: number;
    pendingAmount: number;
    paidAmount: number;
  };
  payables: {
    totalCount: number;
    totalAmount: number;
    overdueCount: number;
    overdueAmount: number;
    pendingAmount: number;
    paidAmount: number;
  };
}
