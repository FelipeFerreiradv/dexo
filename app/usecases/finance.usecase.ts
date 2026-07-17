import {
  FinanceEntry,
  FinanceEntryCreate,
  FinanceEntryUpdate,
  FinanceKind,
  FinanceListFilters,
  FinanceListResult,
  FinanceSummary,
} from "../interfaces/finance.interface";
import type { ProductLookup } from "../interfaces/nfe.interface";
import type { MeioPagamento } from "../fiscal/domain/nfe.types";
import { PAYMENT_METHOD_CODES } from "../lib/payment-methods";
import prisma from "../lib/prisma";
import { CustomerRepository } from "../repositories/customer.repository";
import { FinanceRepository } from "../repositories/finance.repository";
import { UnidadeRepository } from "../repositories/unidade.repository";
import { CustomerUseCase } from "./customer.usecase";
import { NfeDraftUseCase } from "./nfe-draft.usecase";
import { NfeEmissionUseCase } from "./nfe-emission.usecase";
import { NfeRepository } from "../repositories/nfe.repository";
import { NFCE_LIMITE_VALOR } from "../fiscal/domain/nfce";
import { mapCustomerToDestinatario } from "./nfe-customer-mapping";
import { StockDeductionService } from "../marketplaces/services/stock-deduction.service";
import { ScrapStatusReconcileService } from "../marketplaces/services/scrap-status-reconcile.service";

// Mapeamento código Dexo (paymentMethod) → MeioPagamento (domínio fiscal SEFAZ).
// 1:1 e sem ambiguidade (decisão da Fase 1). Código nulo/desconhecido → null;
// o caller aplica o fallback "DINHEIRO" para preservar 100% o comportamento
// atual do rascunho de NF-e (que hoje usa "DINHEIRO" fixo).
const PAYMENT_METHOD_TO_MEIO: Record<string, MeioPagamento> = {
  PIX: "PIX",
  CREDITO: "CARTAO_CREDITO",
  DEBITO: "CARTAO_DEBITO",
  BOLETO: "BOLETO",
  DINHEIRO: "DINHEIRO",
  TRANSFERENCIA: "TRANSFERENCIA",
  FIADO: "CREDITO_LOJA", // crediário próprio (SEFAZ 05) — venda a prazo da loja
};

function mapPaymentMethodToMeio(
  code: string | null | undefined,
): MeioPagamento | null {
  return code ? (PAYMENT_METHOD_TO_MEIO[code] ?? null) : null;
}

export class FinanceUseCase {
  private repo: FinanceRepository;
  private customerRepo: CustomerRepository;
  private unidadeRepo: UnidadeRepository;
  private customerUseCase: CustomerUseCase;
  private nfeDraftUseCase: NfeDraftUseCase;
  // NFC-e (Fase 2) — lazy: instanciados só no 1º uso do fluxo NFC-e, para
  // não pagar o custo de construção nos fluxos financeiros que não emitem.
  private nfeRepoLazy: NfeRepository | null = null;
  private nfeEmissionLazy: NfeEmissionUseCase | null = null;

  constructor() {
    this.repo = new FinanceRepository();
    this.customerRepo = new CustomerRepository();
    this.unidadeRepo = new UnidadeRepository();
    this.customerUseCase = new CustomerUseCase();
    this.nfeDraftUseCase = new NfeDraftUseCase();
  }

  private get nfeRepo(): NfeRepository {
    if (!this.nfeRepoLazy) this.nfeRepoLazy = new NfeRepository();
    return this.nfeRepoLazy;
  }

  private get nfeEmission(): NfeEmissionUseCase {
    if (!this.nfeEmissionLazy) this.nfeEmissionLazy = new NfeEmissionUseCase();
    return this.nfeEmissionLazy;
  }

  private async assertCustomer(customerId: string, userId: string) {
    const c = await this.customerRepo.findById(customerId, userId);
    if (!c) {
      throw new Error("Cliente selecionado não encontrado");
    }
  }

  // Só roda quando uma unidade é informada — fluxo sem unidade é inalterado.
  // Mensagem contém "inválido" para mapear a 400 no error handler de finance
  // já existente (buildCreateHandler), sem alterar a lógica de status.
  private async assertUnidade(unidadeId: string, userId: string) {
    const u = await this.unidadeRepo.findById(unidadeId, userId);
    if (!u) {
      throw new Error("Identificador de unidade inválido");
    }
  }

  // Validações monetárias/parcelas — compartilhadas pelos dois fluxos.
  private validateMonetary(data: FinanceEntryCreate) {
    if (!(typeof data.totalAmount === "number") || data.totalAmount <= 0) {
      throw new Error("Valor total deve ser maior que zero");
    }
    if (!data.dueDate) throw new Error("Data de vencimento é obrigatória");
    if (data.installments !== undefined && data.installments < 1) {
      throw new Error("Número de parcelas deve ser pelo menos 1");
    }
  }

  private validate(data: FinanceEntryCreate) {
    if (!data.customerId) throw new Error("Cliente é obrigatório");
    this.validateMonetary(data);
  }

  // Validação de itens (Fase 4 — venda balcão). Só roda quando `items` está
  // presente; ausência preserva 100% o fluxo atual. Mensagens contêm
  // "obrigatório"/"inválido" para mapear a 400 no error handler de finance.
  private validateItems(kind: FinanceKind, data: FinanceEntryCreate | FinanceEntryUpdate) {
    const items = (data as any).items;
    if (items === undefined) return; // sem field => fluxo atual
    if (!Array.isArray(items)) {
      throw new Error("Itens inválidos: deve ser uma lista");
    }
    if (kind !== "receivable") {
      // "inválido" mapeia para 400 no buildCreateHandler de finance.routes
      // (mesma convenção do assertUnidade).
      throw new Error(
        "Itens inválidos: somente contas a receber aceitam itens",
      );
    }
    for (const [idx, it] of items.entries()) {
      if (!it || typeof it !== "object") {
        throw new Error(`Item ${idx + 1} inválido`);
      }
      // Item CADASTRADO (productId) OU MANUAL (description). Pelo menos um é
      // obrigatório — espelha o superRefine do zod do cliente. Mensagem com
      // "obrigatório" mapeia para 400 no buildCreateHandler.
      const hasProduct =
        typeof it.productId === "string" && it.productId.length > 0;
      const hasDescription =
        typeof it.description === "string" && it.description.trim().length > 0;
      if (!hasProduct && !hasDescription) {
        throw new Error(
          `Item ${idx + 1}: produto cadastrado ou descrição é obrigatório`,
        );
      }
      if (
        !Number.isInteger(it.quantity) ||
        it.quantity <= 0
      ) {
        // Estrutura "Item N inválido: ..." garante o substring "inválido"
        // (masculino) que o buildCreateHandler casa para mapear a 400.
        throw new Error(
          `Item ${idx + 1} inválido: quantidade deve ser inteiro positivo`,
        );
      }
      if (
        typeof it.unitPrice !== "number" ||
        !Number.isFinite(it.unitPrice) ||
        it.unitPrice < 0
      ) {
        throw new Error(
          `Item ${idx + 1}: preço unitário inválido`,
        );
      }
    }
  }

  // Valida a forma de pagamento APENAS quando presente. Ausente/null/""
  // => no-op (preserva 100% o fluxo atual sem método). Mensagem contém
  // "inválido" (masculino) para mapear a 400 no buildCreateHandler de
  // finance.routes (mesma convenção de assertUnidade/validateItems).
  private validatePaymentMethod(
    kind: FinanceKind,
    data: FinanceEntryCreate | FinanceEntryUpdate,
  ) {
    const pm = (data as any).paymentMethod;
    if (!pm) return; // ausente/null/"" => fluxo atual
    if (!PAYMENT_METHOD_CODES.includes(pm)) {
      throw new Error("Método de pagamento inválido");
    }
    // "Fiado" é uma conta A RECEBER (venda a prazo / crédito na loja), não uma
    // forma de pagamento efetivada de Contas a Pagar. "inválido" => 400 no
    // buildCreateHandler (mesma convenção dos demais métodos inválidos).
    if (pm === "FIADO" && kind !== "receivable") {
      throw new Error("Método de pagamento inválido para conta a pagar");
    }
  }

  async create(
    kind: FinanceKind,
    data: FinanceEntryCreate,
  ): Promise<FinanceEntry> {
    if (!data.userId) throw new Error("Usuário não encontrado");

    // Validação de itens vale para os DOIS fluxos (quick-create e padrão).
    // Quando `items` ausente, é no-op — preserva 100% o fluxo atual.
    this.validateItems(kind, data);
    // Idem: no-op quando `paymentMethod` ausente/null. Cobre os dois fluxos
    // de create por estar antes do branch newCustomer.
    this.validatePaymentMethod(kind, data);

    // ── Cadastro rápido: cria cliente + conta numa ÚNICA transação ──
    // Se a criação da conta falhar, o cliente também sofre rollback
    // (atômico). Reusa CustomerUseCase (mesma validação CPF/duplicidade).
    if (data.newCustomer) {
      if (
        !data.newCustomer.name ||
        data.newCustomer.name.trim().length < 2
      ) {
        throw new Error("Nome do cliente é obrigatório");
      }
      this.validateMonetary(data);
      if (data.unidadeId)
        await this.assertUnidade(data.unidadeId, data.userId);

      const { newCustomer, ...rest } = data;
      return prisma.$transaction(async (tx) => {
        const customer = await this.customerUseCase.createWithTx(tx, {
          userId: data.userId,
          name: newCustomer.name,
          cpf: newCustomer.cpf ?? null,
        });
        return this.repo.create(
          kind,
          { ...rest, customerId: customer.id },
          tx,
        );
      });
    }

    // ── Fluxo atual — 100% inalterado ──
    this.validate(data);
    await this.assertCustomer(data.customerId, data.userId);
    if (data.unidadeId) await this.assertUnidade(data.unidadeId, data.userId);
    return this.repo.create(kind, data);
  }

  async update(
    kind: FinanceKind,
    id: string,
    userId: string,
    data: FinanceEntryUpdate,
  ): Promise<FinanceEntry> {
    if (data.customerId) {
      await this.assertCustomer(data.customerId, userId);
    }
    if (data.unidadeId) await this.assertUnidade(data.unidadeId, userId);
    // Validação de itens — no-op quando `items` ausente; preserva fluxo atual.
    this.validateItems(kind, data);
    // Idem para forma de pagamento — no-op quando ausente/null.
    this.validatePaymentMethod(kind, data);
    return this.repo.update(kind, id, userId, data);
  }

  /**
   * Marca uma conta como PAGA.
   *
   * Para receivable COM itens (venda balcão) — Fase 6:
   *  - **Idempotente**: se já está PAGA, retorna a entry sem efeito colateral.
   *  - **Atômico**: status + paidAt + baixa de estoque (FOR UPDATE, stockLog,
   *    advisory lock, upsert do StockSyncJob) na MESMA `$transaction({
   *    timeout: 60_000, maxWait: 20_000 })`. Falha em qualquer ponto faz
   *    rollback completo — a conta volta para PENDENTE.
   *  - Pós-commit: `firePostEffects` dispara `StockSyncRetryService.runOnce()`
   *    em `setImmediate`. `pauseOnZero` NÃO é passado aqui (Fase 6) — entra
   *    como opt-in na Fase 7.
   *
   * Para payable OU receivable SEM itens: caminho atual idêntico (sem tx,
   * sem estoque) — preserva 100% o fluxo da Fase 1.
   */
  async markPaid(
    kind: FinanceKind,
    id: string,
    userId: string,
  ): Promise<FinanceEntry> {
    const current = await this.repo.findById(kind, id, userId);
    if (!current) throw new Error("Registro financeiro não encontrado");

    // Idempotência: já paga → no-op (não decrementa de novo).
    if (current.status === "PAGA") {
      return current;
    }

    // Caminho com itens (balcão): atômico + estoque + sync.
    const hasItems =
      kind === "receivable" &&
      Array.isArray(current.items) &&
      current.items.length > 0;

    if (!hasItems) {
      // Caminho atual — 100% inalterado.
      return this.repo.update(kind, id, userId, {
        status: "PAGA",
        paidAt: new Date(),
      });
    }

    const items = current.items!;
    let updated: FinanceEntry | undefined;
    let deductions: Awaited<
      ReturnType<typeof StockDeductionService.deductWithinTx>
    >["deductions"] = [];

    await prisma.$transaction(
      async (tx) => {
        // Status + paidAt na MESMA tx.
        updated = await this.repo.update(
          kind,
          id,
          userId,
          { status: "PAGA", paidAt: new Date() },
          tx,
        );
        // Baixa de estoque dentro da MESMA tx.
        const result = await StockDeductionService.deductWithinTx(tx, {
          // Apenas itens CADASTRADOS baixam estoque. Itens manuais
          // (productId null) não têm produto no catálogo — não geram
          // StockLog/baixa. Filtrar honra o tipo StockDeductionItem.productId
          // (string) e evita SELECT/StockLog com id nulo.
          items: items
            .filter((it) => it.productId != null)
            .map((it) => ({
              productId: it.productId as string,
              quantity: it.quantity,
            })),
          reason: `Venda balcão — Conta a Receber ${id}`,
          // StockSyncJob.orderId é String? livre — anotação para auditoria.
          orderId: `receivable:${id}`,
          logPrefix: "[FinanceUseCase]",
        });
        deductions = result.deductions;
      },
      { timeout: 60_000, maxWait: 20_000 },
    );

    // Pós-commit (Fase 7): dispara sync dos jobs enfileirados E pausa
    // anúncios cujos produtos zeraram o estoque. Ambos rodam em `setImmediate`
    // dentro do firePostEffects — best-effort, fora da tx financeira, não
    // travam a resposta ao usuário. Idempotência herdada do
    // `ProductUseCase.pauseListings` (anúncio já pausado é contado como
    // alreadyInState; falha em um marketplace não trava o resto).
    //
    // NOTE: pauseOnZero é OPT-IN. Order (cross-marketplace) NÃO passa, então
    // preserva o comportamento atual (estoque 0 só é sincronizado, anúncio
    // permanece active no marketplace). Venda balcão passa para evitar
    // oversell quando a peça fisicamente saiu.
    StockDeductionService.firePostEffects({
      deductions,
      logPrefix: "[FinanceUseCase]",
      pauseOnZero: { userId },
    });

    // Reflexo no fluxo da sucata (best-effort, pós-commit, idempotente):
    // AVAILABLE→IN_USE→DEPLETED conforme a venda atribuída ao lote. Irmão do
    // firePostEffects — NUNCA trava nem reverte o pagamento (já commitado).
    ScrapStatusReconcileService.reconcileForReceivable({
      receivableId: id,
      userId,
      logPrefix: "[FinanceUseCase]",
    });

    return updated!;
  }

  async findById(
    kind: FinanceKind,
    id: string,
    userId: string,
  ): Promise<FinanceEntry> {
    const e = await this.repo.findById(kind, id, userId);
    if (!e) throw new Error("Registro financeiro não encontrado");
    return this.applyOverdueFlag(e);
  }

  async list(
    kind: FinanceKind,
    filters: FinanceListFilters,
    userId: string,
  ): Promise<FinanceListResult> {
    const result = await this.repo.findAll(kind, filters, userId);
    return {
      ...result,
      items: result.items.map((i) => this.applyOverdueFlag(i)),
    };
  }

  /**
   * Exclui conta a receber/pagar.
   *
   * Fase 9 — Guard: conta a receber PAGA com itens NÃO pode ser hard-deleted
   * (causaria drift de estoque). O usuário deve usar `reverse` (estorno
   * explícito), que devolve o estoque atomicamente. Outras combinações
   * (payable, receivable sem itens, receivable não-PAGA) seguem o fluxo
   * atual byte-idêntico.
   */
  async delete(kind: FinanceKind, id: string, userId: string): Promise<void> {
    if (kind === "receivable") {
      const current = await this.repo.findById(kind, id, userId);
      if (
        current &&
        current.status === "PAGA" &&
        Array.isArray(current.items) &&
        current.items.length > 0
      ) {
        // Mensagem contém "Estornar" — o error handler do route mapeia
        // para 409 (conflito de estado: a operação correta é POST /reverse).
        throw new Error(
          "Conta paga com itens não pode ser excluída. Use Estornar para devolver o estoque.",
        );
      }
    }
    await this.repo.delete(kind, id, userId);
  }

  /**
   * Fase 9 — Estorna uma Conta a Receber PAGA, devolvendo o estoque dos
   * itens (contra-lançamento atômico) e reabrindo anúncios cujos produtos
   * voltaram a ter estoque (best-effort, pós-commit).
   *
   * Idempotência: já CANCELADA → no-op (retorna a entry sem efeito).
   * Validações:
   *  - Receivable inexistente → "não encontrada" (404).
   *  - Não-PAGA → erro (só faz sentido estornar pagamento).
   *  - Sem itens → erro (delete normal cobre esse caso).
   * Transação:
   *  - status → CANCELADA + restoreWithinTx(items, reason) na MESMA tx
   *    (mesmos opts do markPaid: { timeout: 60_000, maxWait: 20_000 }).
   *  - Falha em qualquer ponto → rollback (status permanece PAGA, estoque
   *    permanece deduzido).
   * Pós-commit: firePostEffects com reopenOnRefill — reabre anúncios cujos
   * produtos saíram de zero.
   */
  async reverse(id: string, userId: string): Promise<FinanceEntry> {
    const current = await this.repo.findById("receivable", id, userId);
    if (!current) {
      throw new Error("Conta a receber não encontrada");
    }

    // Idempotência: já estornada → no-op.
    if (current.status === "CANCELADA") {
      return current;
    }

    if (current.status !== "PAGA") {
      throw new Error(
        "Apenas contas PAGA podem ser estornadas (status atual inválido para estorno).",
      );
    }

    if (!Array.isArray(current.items) || current.items.length === 0) {
      throw new Error(
        "Conta sem itens é inválida para estorno — use exclusão simples.",
      );
    }

    const items = current.items;
    let updated: FinanceEntry | undefined;
    let restorations: Awaited<
      ReturnType<typeof StockDeductionService.restoreWithinTx>
    >["deductions"] = [];

    await prisma.$transaction(
      async (tx) => {
        // 1. Status → CANCELADA na MESMA tx do estorno.
        updated = await this.repo.update(
          "receivable",
          id,
          userId,
          { status: "CANCELADA" },
          tx,
        );
        // 2. Contra-lançamento de estoque (+quantity por item).
        const result = await StockDeductionService.restoreWithinTx(tx, {
          // Espelha o markPaid: só itens cadastrados devolvem estoque.
          items: items
            .filter((it) => it.productId != null)
            .map((it) => ({
              productId: it.productId as string,
              quantity: it.quantity,
            })),
          reason: `Estorno venda balcão — Conta a Receber ${id}`,
          orderId: `receivable:${id}`,
          logPrefix: "[FinanceUseCase]",
        });
        restorations = result.deductions;
      },
      { timeout: 60_000, maxWait: 20_000 },
    );

    // Pós-commit: sincroniza com marketplaces + reabre anúncios cujos
    // produtos saíram de zero. Best-effort, fora da tx.
    StockDeductionService.firePostEffects({
      deductions: restorations,
      logPrefix: "[FinanceUseCase]",
      reopenOnRefill: { userId },
    });

    // Estorno simétrico: reavalia o status da sucata (DEPLETED→IN_USE→AVAILABLE
    // conforme estoque restaurado e vendas PAGA remanescentes nos dois canais).
    // Best-effort, pós-commit, idempotente — espelha o caminho do pagamento.
    ScrapStatusReconcileService.reconcileForReceivable({
      receivableId: id,
      userId,
      logPrefix: "[FinanceUseCase]",
    });

    return updated!;
  }

  async summary(
    userId: string,
    unidadeId?: string,
    // PDV (aditivo): true => bucket de receivables só com vendas balcão
    // (contas com itens). Ausente => comportamento atual inalterado.
    hasItems?: boolean,
  ): Promise<FinanceSummary> {
    return this.repo.summary(userId, unidadeId, hasItems);
  }

  // Lookup de produto para a UI do financeiro (autocompletar por SKU/nome).
  // Reusa exatamente o mesmo lookup do módulo fiscal (NfeDraftUseCase →
  // NfeRepository: name/sku/partNumber contains, take 20) — query única,
  // sem divergência. Desacopla a UI do financeiro do prefixo /fiscal.
  async lookupProducts(userId: string, query: string): Promise<ProductLookup[]> {
    return this.nfeDraftUseCase.lookupProducts(userId, query);
  }

  /**
   * Fase 8 — Cria um rascunho de NF-e modelo 55 pré-preenchido a partir de
   * uma Conta a Receber (venda balcão, Opção A do plano).
   *
   * O cupom-PDF-sem-validade-fiscal continua intacto e é gerado por outra
   * rota (`GET /finance/receivables/:id/receipt`); este método produz um
   * draft FISCAL real, que o usuário revisa no editor de rascunho fiscal
   * existente (incluindo NCM, que entra em branco) antes de emitir via
   * `NfeEmissionUseCase`. O pipeline de emissão NÃO muda.
   *
   * Mapeamentos (apenas dados):
   *  - Destinatário: derivado do Customer (PF vs PJ pela presença de
   *    deliveryCnpj), endereço principal.
   *  - Itens: cada ReceivableItem vira NfeDraftItem com CFOP 5102, origem
   *    0 (nacional), unidade UN, NCM em branco (decisão da Fase 1).
   *  - Pagamento: "DINHEIRO" com valor total (usuário ajusta no editor
   *    se for PIX/cartão/etc.).
   *
   * Erros mapeáveis a HTTP por mensagem:
   *  - Receivable inexistente → "não encontrado" (404).
   *  - Sem itens → "inválida" (400).
   *  - Cliente inexistente → "não encontrado" (404).
   *  - Config fiscal ausente → propaga do NfeDraftUseCase.
   */
  async createFiscalDraftFromReceivable(
    receivableId: string,
    userId: string,
    // NFC-e (Fase 2): opcional e ADITIVO — ausente ⇒ rascunho 55 (endpoint
    // /fiscal-draft atual byte-idêntico).
    opts?: { modelo?: "55" | "65" },
  ) {
    const entry = await this.repo.findById("receivable", receivableId, userId);
    if (!entry) {
      throw new Error("Conta a receber não encontrada");
    }
    return this.createFiscalDraftFromEntry(entry, userId, opts);
  }

  // Corpo do rascunho a partir de um entry JÁ carregado — o fluxo NFC-e do
  // PDV precisa do entry para os guards e reusa a mesma carga aqui (egress).
  private async createFiscalDraftFromEntry(
    entry: FinanceEntry,
    userId: string,
    opts?: { modelo?: "55" | "65" },
  ) {
    if (!entry.items || entry.items.length === 0) {
      throw new Error(
        "Conta sem itens é inválida para cupom fiscal — adicione produtos antes de emitir.",
      );
    }
    const customer = await this.customerRepo.findById(entry.customerId, userId);
    if (!customer) {
      throw new Error("Cliente da conta não encontrado");
    }
    // Destinatário completo a partir do cadastro do cliente: tipoPessoa
    // (personType/cnpj), documento, IE real, indicadorIE, e-mail, telefone e
    // endereço. Mesma regra usada no pedido e na busca manual do wizard.
    // Cliente sem CPF/CNPJ é permitido — o editor fiscal sinaliza antes de emitir.
    const destinatario = mapCustomerToDestinatario(customer);

    // Itens — defaults seguros conforme decisão da Fase 1.
    const itens = entry.items.map((it, idx) => ({
      numero: idx + 1,
      productId: it.productId ?? null,
      // Item cadastrado: SKU/nome do Product. Item manual: descrição livre.
      // Opção A — entra no rascunho com defaults editáveis (NCM em branco).
      codigo: it.product?.sku ?? it.productId ?? "",
      descricao: it.product?.name ?? it.description ?? "",
      ncm: "", // usuário completa no editor fiscal antes de emitir
      cfop: "5102", // venda dentro-do-estado
      cest: null,
      origem: 0 as const, // nacional
      unidade: "UN",
      quantidade: it.quantity,
      valorUnitario: it.unitPrice,
      valorTotal: Number((it.quantity * it.unitPrice).toFixed(2)),
      desconto: null,
      observacoes: null,
    }));

    // Pagamento: usa a forma de pagamento da conta quando houver
    // correspondência fiscal; senão mantém o fallback "DINHEIRO" (balcão
    // típico) — comportamento 100% idêntico ao anterior para contas sem
    // método. Usuário ajusta no editor fiscal de qualquer forma.
    const pagamentos = [
      {
        meio: mapPaymentMethodToMeio(entry.paymentMethod) ?? "DINHEIRO",
        valor: Number(entry.totalAmount),
      },
    ];

    return this.nfeDraftUseCase.createPopulatedFromReceivable(userId, {
      customerId: entry.customerId,
      receivableId: entry.id,
      destinatario,
      itens,
      pagamentos,
      ...(opts?.modelo ? { modelo: opts.modelo } : {}),
    });
  }

  /**
   * NFC-e em 1 clique (Fase 2 do PDV): cria o rascunho modelo 65 a partir da
   * Conta a Receber e EMITE em seguida, com idempotência pelo link textual
   * numeroPedido="receivable:<id>".
   *
   * IMPORTANTE: chamada HTTP separada, DEPOIS do pagamento — nunca dentro da
   * $transaction do markPaid. Falha aqui jamais desfaz a venda.
   *
   * Erros mapeados na rota: "não encontrad*" → 404; "inválida" → 400;
   * "R$ 10.000" → 422.
   */
  async emitNfceFromReceivable(receivableId: string, userId: string) {
    const entry = await this.repo.findById("receivable", receivableId, userId);
    if (!entry) {
      throw new Error("Conta a receber não encontrada");
    }
    if (!entry.items || entry.items.length === 0) {
      throw new Error(
        "Conta sem itens é inválida para NFC-e — adicione produtos antes de emitir.",
      );
    }
    if (Number(entry.totalAmount) > NFCE_LIMITE_VALOR) {
      throw new Error(
        "NFC-e limitada a R$ 10.000,00 — use Emitir NF-e (modelo 55) para esta venda.",
      );
    }

    // ── Idempotência: nota 65 mais recente vinculada a esta venda ──
    const existing = await this.nfeRepo.findByNumeroPedidoAndModelo(
      userId,
      `receivable:${receivableId}`,
      "65",
    );

    if (existing?.status === "AUTHORIZED") {
      return {
        state: "authorized" as const,
        alreadyEmitted: true,
        nfeId: existing.id,
        numero: existing.numero,
        serie: existing.serie,
        chaveAcesso: existing.chaveAcesso,
        danfeDisponivel: Boolean(existing.danfePdfPath),
        mensagem: "NFC-e já emitida para esta venda",
      };
    }
    if (
      existing &&
      ["VALIDATING", "SIGNING", "SENDING"].includes(existing.status)
    ) {
      return {
        state: "processing" as const,
        nfeId: existing.id,
        numero: existing.numero,
        serie: existing.serie,
        chaveAcesso: existing.chaveAcesso,
        danfeDisponivel: false,
        mensagem:
          "NFC-e desta venda ainda está em processamento — consulte em instantes",
      };
    }

    // DRAFT/REJECTED existente → reemite a MESMA linha (sem draft duplicado);
    // nada → cria o rascunho 65 (série própria + NCM padrão) e emite. Reusa o
    // `entry` já carregado pelos guards acima (evita o 2º fetch do receivable).
    let nfeId: string;
    if (existing) {
      nfeId = existing.id;
    } else {
      const draft = await this.createFiscalDraftFromEntry(entry, userId, {
        modelo: "65",
      });
      nfeId = draft.id;
    }

    const emission = await this.nfeEmission.emit(userId, nfeId);
    const state =
      emission.status === "AUTHORIZED"
        ? ("authorized" as const)
        : emission.status === "REJECTED"
          ? ("rejected" as const)
          : emission.success
            ? ("processing" as const)
            : ("error" as const);

    return {
      state,
      nfeId: emission.nfeId,
      numero: emission.numero ?? null,
      serie: emission.serie ?? null,
      chaveAcesso: emission.chaveAcesso ?? null,
      danfeDisponivel: emission.status === "AUTHORIZED",
      mensagem: emission.mensagem,
    };
  }

  private applyOverdueFlag(entry: FinanceEntry): FinanceEntry {
    if (entry.status === "PENDENTE" && entry.dueDate < new Date()) {
      return { ...entry, status: "VENCIDA" };
    }
    return entry;
  }
}
