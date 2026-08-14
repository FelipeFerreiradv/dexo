import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import {
  FinanceEntry,
  FinanceEntryCreate,
  FinanceEntryUpdate,
  FinanceKind,
  FinanceListFilters,
  FinanceListResult,
  FinanceStatus,
  FinanceSummary,
} from "../interfaces/finance.interface";

function model(kind: FinanceKind): any {
  return kind === "receivable"
    ? prisma.receivable
    : prisma.payable;
}

function parseDate(v: string | Date | null | undefined): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function toNumberOrNull(v: any): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

// Itens só são incluídos no include de receivable (payable não tem relação).
// Quando incluído, `raw.items` é um array (possivelmente vazio); quando não
// incluído, é undefined — preserva-se no toEntry para não alterar payloads
// que historicamente não traziam itens.
function toEntry(raw: any): FinanceEntry {
  return {
    id: raw.id,
    userId: raw.userId,
    customerId: raw.customerId,
    document: raw.document,
    reason: raw.reason,
    debtDetails: raw.debtDetails,
    totalAmount: Number(raw.totalAmount),
    fineAmount: toNumberOrNull(raw.fineAmount),
    finePercent: toNumberOrNull(raw.finePercent),
    interestPercent: toNumberOrNull(raw.interestPercent),
    toleranceDays: raw.toleranceDays,
    installments: raw.installments,
    periodDays: raw.periodDays,
    dueDate: raw.dueDate,
    status: raw.status,
    paidAt: raw.paidAt,
    paymentMethod: raw.paymentMethod ?? null,
    // Bloco B — split entrada/parcelas. NULL em conta normal.
    parentReceivableId: raw.parentReceivableId ?? null,
    installmentNumber: raw.installmentNumber ?? null,
    installmentTotal: raw.installmentTotal ?? null,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    customer: raw.customer
      ? {
          id: raw.customer.id,
          name: raw.customer.name,
          cpf: raw.customer.cpf,
          email: raw.customer.email,
        }
      : null,
    unidade: raw.unidade
      ? {
          id: raw.unidade.id,
          name: raw.unidade.name,
        }
      : null,
    items: Array.isArray(raw.items)
      ? raw.items.map((i: any) => ({
          id: i.id,
          productId: i.productId ?? null,
          description: i.description ?? null,
          scrapId: i.scrapId ?? null,
          listingId: i.listingId ?? null,
          quantity: i.quantity,
          unitPrice: Number(i.unitPrice),
          createdAt: i.createdAt,
          // Bloco F — flags da promoção a produto de catálogo.
          createCatalogProduct: i.createCatalogProduct ?? false,
          autoCreatedProduct: i.autoCreatedProduct ?? false,
          product: i.product
            ? { id: i.product.id, sku: i.product.sku, name: i.product.name }
            : null,
        }))
      : undefined,
    // Bloco A: mesma disciplina dos itens — quando a relação não é incluída o
    // campo fica `undefined` e o payload continua idêntico ao histórico.
    payments: Array.isArray(raw.payments)
      ? raw.payments.map((p: any) => ({
          id: p.id,
          method: p.method,
          amount: Number(p.amount),
          createdAt: p.createdAt,
        }))
      : undefined,
  };
}

// Include de itens (somente receivable). Não-receivable ignora.
// NB: o `scrapId` (escalar) já vem na linha do ReceivableItem e é o que a
// agregação/reconcile usam; NÃO fazemos JOIN com Scrap aqui — nenhum consumidor
// de findById/findItems exibe o rótulo da sucata (edição não recarrega itens;
// cupom/fiscal usam só product). Evita egress desnecessário.
const itemsInclude = {
  orderBy: { createdAt: "asc" as const },
  include: {
    product: { select: { id: true, sku: true, name: true } },
  },
};

// Bloco A — linhas de pagamento (somente receivable). Ordem de criação, que é
// a ordem em que o operador digitou: o cupom deve listar igual à tela.
const paymentsInclude = {
  orderBy: { createdAt: "asc" as const },
};

function buildInclude(kind: FinanceKind, withItems: boolean): any {
  const include: any = {
    customer: { select: { id: true, name: true, cpf: true, email: true } },
    unidade: { select: { id: true, name: true } },
  };
  if (withItems && kind === "receivable") {
    include.items = itemsInclude;
    // Viaja junto com os itens: quem precisa do detalhe da venda (edição,
    // cupom, rascunho fiscal) precisa dos dois, e são as MESMAS chamadas.
    include.payments = paymentsInclude;
  }
  return include;
}

export class FinanceRepository {
  async create(
    kind: FinanceKind,
    data: FinanceEntryCreate,
    tx?: Prisma.TransactionClient,
  ): Promise<FinanceEntry> {
    const wantsItems =
      kind === "receivable" && Array.isArray(data.items) && data.items.length > 0;
    // Bloco A: linhas de pagamento também são filhas e também exigem tx.
    const wantsPayments =
      kind === "receivable" &&
      Array.isArray(data.payments) &&
      data.payments.length > 0;

    // Bloco B: o plano de parcelamento também exige tx (mãe + N filhas).
    const wantsSplit =
      kind === "receivable" &&
      !!data.installmentPlan &&
      Array.isArray(data.installmentPlan.installments) &&
      data.installmentPlan.installments.length > 0;

    if (wantsSplit) {
      if (tx) return this.createWithSplit(data, tx);
      return prisma.$transaction((txClient) =>
        this.createWithSplit(data, txClient),
      );
    }

    // Sem filhos => caminho atual 100% inalterado (sem $transaction se o caller
    // também não passou tx; com tx se o caller forneceu — ex.: quick-create).
    if (!wantsItems && !wantsPayments) {
      return this.createSingle(kind, data, tx);
    }

    // Com filhos => atomicidade obrigatória (Receivable + ReceivableItem +
    // ReceivablePayment na MESMA transação). Se o caller já abriu tx (ex.:
    // quick-create), reusa.
    if (tx) {
      return this.createWithItems(kind, data, tx);
    }
    return prisma.$transaction((txClient) =>
      this.createWithItems(kind, data, txClient),
    );
  }

  // Caminho histórico — preservado byte-idêntico ao da Fase 1.
  private async createSingle(
    kind: FinanceKind,
    data: FinanceEntryCreate,
    tx?: Prisma.TransactionClient,
  ): Promise<FinanceEntry> {
    const db: Prisma.TransactionClient = tx ?? prisma;
    const delegate: any = kind === "receivable" ? db.receivable : db.payable;
    const created = await delegate.create({
      data: {
        userId: data.userId,
        customerId: data.customerId,
        unidadeId: data.unidadeId ?? null,
        document: data.document ?? null,
        reason: data.reason ?? null,
        debtDetails: data.debtDetails ?? null,
        totalAmount: data.totalAmount,
        fineAmount: data.fineAmount ?? null,
        finePercent: data.finePercent ?? null,
        interestPercent: data.interestPercent ?? null,
        toleranceDays: data.toleranceDays ?? null,
        installments: data.installments ?? 1,
        periodDays: data.periodDays ?? null,
        dueDate: parseDate(data.dueDate)!,
        status: (data.status as FinanceStatus) ?? "PENDENTE",
        paidAt: parseDate(data.paidAt ?? null),
        paymentMethod: data.paymentMethod ?? null,
      },
      include: {
        customer: { select: { id: true, name: true, cpf: true, email: true } },
        unidade: { select: { id: true, name: true } },
      },
    });
    return toEntry(created);
  }

  // Caminho com itens — só receivable, sempre dentro de uma tx (o create
  // wrapper garante isso). Cria Receivable + ReceivableItems e re-busca com
  // include de itens.
  private async createWithItems(
    kind: FinanceKind,
    data: FinanceEntryCreate,
    tx: Prisma.TransactionClient,
  ): Promise<FinanceEntry> {
    if (kind !== "receivable") {
      // Defesa-em-profundidade — o usecase já bloqueia este caminho.
      throw new Error(
        "Itens inválidos: somente contas a receber aceitam itens",
      );
    }
    const delegate: any = (tx as any).receivable;
    const created = await delegate.create({
      data: {
        userId: data.userId,
        customerId: data.customerId,
        unidadeId: data.unidadeId ?? null,
        document: data.document ?? null,
        reason: data.reason ?? null,
        debtDetails: data.debtDetails ?? null,
        totalAmount: data.totalAmount,
        fineAmount: data.fineAmount ?? null,
        finePercent: data.finePercent ?? null,
        interestPercent: data.interestPercent ?? null,
        toleranceDays: data.toleranceDays ?? null,
        installments: data.installments ?? 1,
        periodDays: data.periodDays ?? null,
        dueDate: parseDate(data.dueDate)!,
        status: (data.status as FinanceStatus) ?? "PENDENTE",
        paidAt: parseDate(data.paidAt ?? null),
        paymentMethod: data.paymentMethod ?? null,
      },
      // Não incluímos itens aqui (acabamos de criar e vamos preencher na
      // próxima query); a 2ª query traz o include completo.
      select: { id: true },
    });

    if (Array.isArray(data.items) && data.items.length > 0) {
      await (tx as any).receivableItem.createMany({
        data: data.items.map((it) => ({
          receivableId: created.id,
          productId: it.productId ?? null,
          description: it.description ?? null,
          scrapId: it.scrapId ?? null,
          listingId: it.listingId ?? null,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          // Bloco F: só vai no payload quando LIGADO. Ausente => a coluna usa
          // o DEFAULT false do banco e o INSERT fica byte-idêntico ao de hoje
          // (REGRA 2: campo novo ausente => comportamento antigo intacto).
          ...(it.createCatalogProduct ? { createCatalogProduct: true } : {}),
        })),
      });
    }

    // Bloco A — linhas de pagamento, na MESMA tx dos itens.
    if (Array.isArray(data.payments) && data.payments.length > 0) {
      await (tx as any).receivablePayment.createMany({
        data: data.payments.map((p) => ({
          receivableId: created.id,
          method: p.method,
          amount: p.amount,
        })),
      });
    }

    const full = await (tx as any).receivable.findUnique({
      where: { id: created.id },
      include: buildInclude("receivable", true),
    });
    return toEntry(full);
  }

  /**
   * Bloco B — cria a venda parcelada: 1 conta-ENTRADA (com os itens, e é ela
   * que baixa o estoque quando for recebida) + N contas-PARCELA, filhas.
   *
   * `data.totalAmount` chega como o TOTAL DA VENDA e é dividido: a entrada
   * fica com `downPayment` e cada parcela com o seu valor. Assim a soma das
   * linhas continua sendo o total, sem dupla contagem em nenhum relatório.
   *
   * As parcelas NÃO recebem itens (a mercadoria saiu uma vez só) nem
   * `paymentMethod` — herdar o método da entrada faria uma parcela ainda não
   * paga aparecer como "PIX" nos gráficos de forma de pagamento. Herdam sim
   * os ENCARGOS, que são justamente o que vale para atraso.
   */
  private async createWithSplit(
    data: FinanceEntryCreate,
    tx: Prisma.TransactionClient,
  ): Promise<FinanceEntry> {
    const plan = data.installmentPlan!;

    // Mãe: mesmo caminho de sempre, só com o valor da entrada.
    const mae = await this.createWithItems(
      "receivable",
      { ...data, totalAmount: plan.downPayment, installments: 1 },
      tx,
    );

    const total = plan.installments.length;
    await (tx as any).receivable.createMany({
      data: plan.installments.map((p, idx) => ({
        userId: data.userId,
        customerId: data.customerId,
        unidadeId: data.unidadeId ?? null,
        document: data.document ?? null,
        reason: `Parcela ${idx + 1}/${total}${data.reason ? ` — ${data.reason}` : ""}`,
        debtDetails: null,
        totalAmount: p.amount,
        // Encargos herdados: multa/juros/tolerância existem para o atraso, e
        // quem atrasa é a parcela.
        fineAmount: data.fineAmount ?? null,
        finePercent: data.finePercent ?? null,
        interestPercent: data.interestPercent ?? null,
        toleranceDays: data.toleranceDays ?? null,
        installments: 1,
        periodDays: null,
        dueDate: parseDate(p.dueDate)!,
        status: "PENDENTE" as FinanceStatus,
        paidAt: null,
        paymentMethod: null,
        parentReceivableId: mae.id,
        installmentNumber: idx + 1,
        installmentTotal: total,
      })),
    });

    return mae;
  }

  /**
   * Bloco B — parcelas de uma venda, na ordem.
   *
   * SEM `include`: nenhum dos três chamadores lê `customer` ou `unidade` — o
   * delete só olha `length`, o /reverse só o `status` e o cupom só
   * número/vencimento/valor. O Prisma resolve cada relação incluída numa
   * consulta PRÓPRIA, então incluí-las custava 3 idas ao banco em vez de 1,
   * por chamada, mais o tráfego das linhas de cliente/unidade repetidas em
   * cada parcela — dado que ninguém consome. `toEntry` deixa os dois campos
   * `undefined`, exatamente como já faz para qualquer relação não incluída
   * (mesma disciplina de `items`/`payments` na listagem).
   *
   * Um `select` explícito cortaria também as colunas escalares, mas obrigaria
   * a enumerar os ~23 campos que `toEntry` lê — qualquer campo novo no schema
   * passaria a chegar `undefined` em silêncio. Não compensa: as colunas
   * restantes são escalares pequenos e `debtDetails` já nasce null na parcela.
   */
  async findChildren(
    parentId: string,
    userId: string,
  ): Promise<FinanceEntry[]> {
    const rows = await prisma.receivable.findMany({
      where: { parentReceivableId: parentId, userId },
      orderBy: { installmentNumber: "asc" },
    });
    return rows.map(toEntry);
  }

  async update(
    kind: FinanceKind,
    id: string,
    userId: string,
    data: FinanceEntryUpdate,
    tx?: Prisma.TransactionClient,
  ): Promise<FinanceEntry> {
    // `items` no payload significa "substituir lista de itens" (replace
    // strategy). Ausência (undefined) preserva itens existentes — fluxo atual
    // não-quebra.
    const hasItemsField = "items" in data && data.items !== undefined;
    // Bloco A: mesma semântica de replace para as linhas de pagamento.
    // Ausência preserva o que já está gravado — nada é apagado por omissão.
    const hasPaymentsField = "payments" in data && data.payments !== undefined;

    if (!hasItemsField && !hasPaymentsField) {
      return this.updateSingle(kind, id, userId, data, tx);
    }
    if (kind !== "receivable") {
      throw new Error(
        "Itens inválidos: somente contas a receber aceitam itens",
      );
    }
    if (tx) {
      return this.updateWithItems(kind, id, userId, data, tx);
    }
    return prisma.$transaction((txClient) =>
      this.updateWithItems(kind, id, userId, data, txClient),
    );
  }

  // Caminho histórico — preservado byte-idêntico ao da Fase 1 (sem tx).
  private async updateSingle(
    kind: FinanceKind,
    id: string,
    userId: string,
    data: FinanceEntryUpdate,
    tx?: Prisma.TransactionClient,
  ): Promise<FinanceEntry> {
    const db: any = tx ?? prisma;
    const delegate: any = kind === "receivable" ? db.receivable : db.payable;
    const payload: any = { ...data };
    delete payload.items; // defesa: nunca passar items pro update do delegate
    delete payload.payments; // idem para as linhas de pagamento (Bloco A)
    delete payload.installmentPlan; // idem para o plano de parcelas (Bloco B)
    if ("dueDate" in payload) payload.dueDate = parseDate(payload.dueDate);
    if ("paidAt" in payload) payload.paidAt = parseDate(payload.paidAt);
    delete payload.userId;

    const res = await delegate.updateMany({
      where: { id, userId },
      data: payload,
    });
    if (res.count === 0) throw new Error("Registro financeiro não encontrado");

    const updated = await delegate.findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, name: true, cpf: true, email: true } },
        unidade: { select: { id: true, name: true } },
      },
    });
    return toEntry(updated);
  }

  // Atualiza receivable + replace de itens — atomicidade obrigatória.
  private async updateWithItems(
    kind: FinanceKind,
    id: string,
    userId: string,
    data: FinanceEntryUpdate,
    tx: Prisma.TransactionClient,
  ): Promise<FinanceEntry> {
    const hasItemsField = "items" in data && data.items !== undefined;
    const hasPaymentsField = "payments" in data && data.payments !== undefined;
    const items = data.items ?? [];
    const payments = data.payments ?? [];
    const otherFields: any = { ...data };
    delete otherFields.items;
    delete otherFields.payments;
    delete otherFields.installmentPlan;
    delete otherFields.userId;
    if ("dueDate" in otherFields)
      otherFields.dueDate = parseDate(otherFields.dueDate);
    if ("paidAt" in otherFields)
      otherFields.paidAt = parseDate(otherFields.paidAt);

    const res = await (tx as any).receivable.updateMany({
      where: { id, userId },
      data: otherFields,
    });
    if (res.count === 0) throw new Error("Registro financeiro não encontrado");

    // Replace strategy: apaga todos e re-cria. Igual ao padrão usado em
    // NfeRepository.updateDraft para itens de NFe.
    //
    // Só toca a relação que veio no payload: um update que manda `payments`
    // sem `items` (ou vice-versa) NÃO pode apagar a outra lista.
    if (hasItemsField) {
      await (tx as any).receivableItem.deleteMany({
        where: { receivableId: id },
      });
      if (items.length > 0) {
        await (tx as any).receivableItem.createMany({
          data: items.map((it) => ({
            receivableId: id,
            productId: it.productId ?? null,
            description: it.description ?? null,
            scrapId: it.scrapId ?? null,
            listingId: it.listingId ?? null,
            quantity: it.quantity,
            unitPrice: it.unitPrice,
            ...(it.createCatalogProduct ? { createCatalogProduct: true } : {}),
          })),
        });
      }
    }

    if (hasPaymentsField) {
      await (tx as any).receivablePayment.deleteMany({
        where: { receivableId: id },
      });
      if (payments.length > 0) {
        await (tx as any).receivablePayment.createMany({
          data: payments.map((p) => ({
            receivableId: id,
            method: p.method,
            amount: p.amount,
          })),
        });
      }
    }

    const updated = await (tx as any).receivable.findUnique({
      where: { id },
      include: buildInclude("receivable", true),
    });
    return toEntry(updated);
  }

  async findById(
    kind: FinanceKind,
    id: string,
    userId: string,
  ): Promise<FinanceEntry | null> {
    // Receivable: traz items (uso pontual — pagamento, cupom, etc.).
    // Payable: items não se aplica (preserva payload atual).
    const res = await model(kind).findFirst({
      where: { id, userId },
      include: buildInclude(kind, true),
    });
    return res ? toEntry(res) : null;
  }

  // Busca apenas os itens de uma Receivable (ownership-aware via JOIN
  // implícito pelo `receivable.userId`). Útil para markPaid (Fase 6) sem
  // precisar carregar o entry inteiro.
  async findItems(
    receivableId: string,
    userId: string,
  ): Promise<NonNullable<FinanceEntry["items"]>> {
    const rows = await prisma.receivableItem.findMany({
      where: { receivableId, receivable: { userId } },
      orderBy: { createdAt: "asc" },
      include: {
        product: { select: { id: true, sku: true, name: true } },
      },
    });
    return rows.map((i: any) => ({
      id: i.id,
      productId: i.productId ?? null,
      description: i.description ?? null,
      scrapId: i.scrapId ?? null,
      listingId: i.listingId ?? null,
      quantity: i.quantity,
      unitPrice: Number(i.unitPrice),
      createdAt: i.createdAt,
      product: i.product
        ? { id: i.product.id, sku: i.product.sku, name: i.product.name }
        : null,
    }));
  }

  async findAll(
    kind: FinanceKind,
    filters: FinanceListFilters,
    userId: string,
  ): Promise<FinanceListResult> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: any = { userId };
    if (filters.status) where.status = filters.status;
    if (filters.customerId) where.customerId = filters.customerId;
    // Filtro de unidade: ausente/"" => não filtra (resultado idêntico ao atual);
    // "sem_unidade" => contas sem unidade; outro valor => aquela unidade.
    if (filters.unidadeId) {
      where.unidadeId =
        filters.unidadeId === "sem_unidade" ? null : filters.unidadeId;
    }
    // Filtro por forma de pagamento: ausente/"" => não filtra (idêntico ao atual).
    if (filters.paymentMethod) where.paymentMethod = filters.paymentMethod;
    // Filtro "só vendas balcão" (PDV): ausente/false => não filtra (where
    // byte-idêntico ao atual). O guard de kind é obrigatório — Payable não
    // tem a relação `items` e o filtro quebraria a query.
    if (kind === "receivable" && filters.hasItems) where.items = { some: {} };
    if (filters.from || filters.to) {
      where.dueDate = {};
      if (filters.from) where.dueDate.gte = new Date(filters.from);
      if (filters.to) where.dueDate.lte = new Date(filters.to);
    }
    if (filters.search) {
      const term = filters.search.trim();
      where.OR = [
        { document: { contains: term, mode: "insensitive" } },
        { reason: { contains: term, mode: "insensitive" } },
        { customer: { name: { contains: term, mode: "insensitive" } } },
      ];
    }

    const [rows, total] = await Promise.all([
      model(kind).findMany({
        where,
        skip,
        take: limit,
        // Ordem de criação (mais novo primeiro), padrão do sistema. O filtro
        // por vencimento (from/to) continua no `where.dueDate` — só a exibição
        // muda. Antes era dueDate asc.
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          userId: true,
          customerId: true,
          unidadeId: true,
          document: true,
          reason: true,
          // Fase 1.0 — a edição hidrata o formulário a partir da LINHA da
          // listagem. Todo campo editável ausente aqui volta para o default do
          // form e é regravado por cima no PUT (o submit envia o form inteiro).
          // `debtDetails` era o único editável fora do select: a alternativa
          // seria um GET extra na edição de conta a pagar, o que mudaria a
          // contagem de requests desse fluxo.
          debtDetails: true,
          totalAmount: true,
          fineAmount: true,
          finePercent: true,
          interestPercent: true,
          toleranceDays: true,
          installments: true,
          periodDays: true,
          dueDate: true,
          status: true,
          paidAt: true,
          paymentMethod: true,
          createdAt: true,
          updatedAt: true,
          customer: {
            select: { id: true, name: true, cpf: true, email: true },
          },
          unidade: {
            select: { id: true, name: true },
          },
        },
      }),
      model(kind).count({ where }),
    ]);

    const items = rows.map(toEntry);

    // Bloco B — o livro do dia precisa mostrar o TAMANHO DA VENDA, não só a
    // entrada. A conta-mãe guarda apenas o valor recebido no ato; o resto vive
    // nas filhas. UMA consulta agregada (groupBy indexado por
    // parentReceivableId) resolve a página inteira — nada de N+1.
    //
    // Só no caminho do PDV (`hasItems`): a listagem do Financeiro segue
    // byte-idêntica, sem query extra.
    if (kind === "receivable" && filters.hasItems && items.length > 0) {
      const ids = items.map((i: FinanceEntry) => i.id);
      const filhas = await prisma.receivable.groupBy({
        by: ["parentReceivableId"],
        where: { parentReceivableId: { in: ids }, userId },
        _sum: { totalAmount: true },
        _count: { _all: true },
      });
      const porMae = new Map(
        filhas.map((f) => [
          f.parentReceivableId as string,
          {
            amount: Number(f._sum?.totalAmount ?? 0),
            count: f._count?._all ?? 0,
          },
        ]),
      );
      for (const it of items) {
        const f = porMae.get(it.id);
        if (!f) continue;
        it.installmentsCount = f.count;
        it.installmentsAmount = f.amount;
      }
    }

    // Fase 1.1 — pagamento combinado na LISTAGEM.
    //
    // O escalar `paymentMethod` guarda só o PREDOMINANTE, então uma venda em
    // PIX + Crédito aparecia na lista como se fosse só "Crédito" — e o
    // operador concluía, com razão, que a segunda forma não tinha sido salva.
    //
    // UMA consulta por página (índice em `receivableId`), no mesmo espírito do
    // agregado de parcelas acima. Diferente daquele, roda também para a lista
    // do Financeiro: é lá que o cliente confere a venda. Linhas sem pagamento
    // detalhado não ganham campo nenhum — a resposta de uma conta comum segue
    // byte-idêntica.
    //
    // ESCOPO DE TENANT: `ReceivablePayment` NÃO tem `userId`. Os ids já vêm de
    // uma query escopada, mas o filtro por `receivable.userId` é a mesma
    // defense-in-depth que `getScrapParts` aplica — sem ele, um id vazado
    // atravessaria tenants.
    if (kind === "receivable" && items.length > 0) {
      const ids = items.map((i: FinanceEntry) => i.id);
      const linhas = await prisma.receivablePayment.findMany({
        where: { receivableId: { in: ids }, receivable: { userId } },
        select: { receivableId: true, method: true, amount: true },
        // Ordem em que o operador digitou — a mesma do cupom e da edição.
        orderBy: { createdAt: "asc" },
      });
      if (linhas.length > 0) {
        const porConta = new Map<string, { method: string; amount: number }[]>();
        for (const l of linhas) {
          const lista = porConta.get(l.receivableId) ?? [];
          lista.push({ method: l.method, amount: Number(l.amount) });
          porConta.set(l.receivableId, lista);
        }
        for (const it of items) {
          const p = porConta.get(it.id);
          if (p) it.payments = p;
        }
      }
    }

    return {
      items,
      total,
      totalPages: Math.ceil(total / limit),
    };
  }

  async delete(kind: FinanceKind, id: string, userId: string): Promise<void> {
    const res = await model(kind).deleteMany({ where: { id, userId } });
    if (res.count === 0) throw new Error("Registro financeiro não encontrado");
  }

  async summary(
    userId: string,
    unidadeId?: string,
    hasItems?: boolean,
    // Bloco C (aditivo): resumo de UM cliente, para o histórico de compras da
    // ficha. Ausente/"" => fragmento vazio => where byte-idêntico ao atual.
    customerId?: string,
  ): Promise<FinanceSummary> {
    const now = new Date();

    // Sem filtro de unidade => objeto vazio => where idêntico ao comportamento
    // atual ({ userId } e { userId, status, dueDate }).
    const unidadeWhere: Record<string, unknown> =
      unidadeId === undefined || unidadeId === ""
        ? {}
        : { unidadeId: unidadeId === "sem_unidade" ? null : unidadeId };

    // Filtro "só vendas balcão" (PDV): aplicado APENAS ao modelo receivable
    // (Payable não tem relação items). Ausente/false => fragmento vazio =>
    // where byte-idêntico ao atual.
    const receivableItemsWhere: Record<string, unknown> = hasItems
      ? { items: { some: {} } }
      : {};

    // Mesmo contrato dos dois filtros acima: ausente => {} => where idêntico.
    const customerWhere: Record<string, unknown> =
      customerId === undefined || customerId === "" ? {} : { customerId };

    async function stats(m: any, extraWhere: Record<string, unknown> = {}) {
      const [grouped, overdue] = await Promise.all([
        m.groupBy({
          by: ["status"],
          where: { userId, ...unidadeWhere, ...customerWhere, ...extraWhere },
          _sum: { totalAmount: true },
          _count: { _all: true },
        }),
        m.aggregate({
          where: {
            userId,
            ...unidadeWhere,
            ...customerWhere,
            ...extraWhere,
            status: { in: ["PENDENTE", "VENCIDA"] },
            dueDate: { lt: now },
          },
          _sum: { totalAmount: true },
          _count: true,
        }),
      ]);

      let totalCount = 0;
      let totalAmount = 0;
      let pendingAmount = 0;
      let paidAmount = 0;
      for (const g of grouped) {
        const count = g._count?._all ?? 0;
        const amount = Number(g._sum?.totalAmount ?? 0);
        totalCount += count;
        totalAmount += amount;
        if (g.status === "PENDENTE") pendingAmount += amount;
        if (g.status === "PAGA") paidAmount += amount;
      }

      return {
        totalCount,
        totalAmount,
        overdueCount: overdue._count ?? 0,
        overdueAmount: Number(overdue._sum?.totalAmount ?? 0),
        pendingAmount,
        paidAmount,
      };
    }

    const [receivables, payables, parcelas] = await Promise.all([
      stats(prisma.receivable, receivableItemsWhere),
      stats(prisma.payable),
      // Bloco B — a PARCELA de uma venda de balcão não tem itens (a mercadoria
      // saiu uma vez só, na conta-entrada), então o filtro acima a exclui e o
      // saldo parcelado sumia de "A receber (balcão)" no PDV.
      //
      // Agregado SEPARADO em vez de mexer no `where` acima: aquele formato
      // está pinado em teste (finance-hasitems-filter), e alterá-lo seria
      // mudar um contrato existente. Assim o comportamento atual fica
      // byte-idêntico e o saldo é somado por cima.
      //
      // Sem dupla contagem: uma conta-parcela NUNCA tem itens (createWithSplit
      // não lhe dá nenhum), então os dois conjuntos são disjuntos.
      hasItems
        ? stats(prisma.receivable, { parentReceivableId: { not: null } })
        : null,
    ]);

    return {
      receivables: parcelas
        ? {
            totalCount: receivables.totalCount + parcelas.totalCount,
            totalAmount: receivables.totalAmount + parcelas.totalAmount,
            overdueCount: receivables.overdueCount + parcelas.overdueCount,
            overdueAmount: receivables.overdueAmount + parcelas.overdueAmount,
            pendingAmount: receivables.pendingAmount + parcelas.pendingAmount,
            paidAmount: receivables.paidAmount + parcelas.paidAmount,
          }
        : receivables,
      payables,
    };
  }
}
