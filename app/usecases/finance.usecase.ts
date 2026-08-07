import {
  FinanceEntry,
  FinanceEntryCreate,
  FinanceEntryUpdate,
  FinanceKind,
  FinanceListFilters,
  FinanceListResult,
  FinanceSummary,
  InstallmentPlanInput,
  ReceivableItemSnapshot,
} from "../interfaces/finance.interface";
import type { Prisma } from "@prisma/client";
import type { ProductLookup } from "../interfaces/nfe.interface";
import type { MeioPagamento } from "../fiscal/domain/nfe.types";
import {
  PAYMENT_METHOD_CODES,
  predominantPaymentMethod,
  sumPaymentsCents,
  toCents,
  type PaymentLine,
} from "../lib/payment-methods";
import prisma from "../lib/prisma";
import { CustomerRepository } from "../repositories/customer.repository";
import { FinanceRepository } from "../repositories/finance.repository";
import { UnidadeRepository } from "../repositories/unidade.repository";
import { CustomerUseCase } from "./customer.usecase";
import { NfeDraftUseCase } from "./nfe-draft.usecase";
import { NfeEmissionUseCase } from "./nfe-emission.usecase";
import { NfeRepository } from "../repositories/nfe.repository";
import { CompanyFiscalRepository } from "../repositories/company-fiscal.repository";
import { NFCE_LIMITE_VALOR } from "../fiscal/domain/nfce";
import { mapCustomerToDestinatario } from "./nfe-customer-mapping";
import { StockDeductionService } from "../marketplaces/services/stock-deduction.service";
import { ScrapStatusReconcileService } from "../marketplaces/services/scrap-status-reconcile.service";
import { SystemLogService } from "../services/system-log.service";
import { ProductUseCase } from "./product.usercase";

// Bloco F — kill-switch da promoção de peça avulsa a produto. Lido no backend
// (mesmo precedente de NEXT_PUBLIC_DANFE_OFICIAL_ENABLED em fiscal.routes.ts).
// OFF => `promoteManualItems` é no-op e o pagamento segue byte-idêntico.
const MANUAL_ITEM_CATALOG_ENABLED =
  process.env.NEXT_PUBLIC_MANUAL_ITEM_CATALOG_ENABLED === "true";

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

// ── Bloco E: auditoria das ações destrutivas do financeiro ──
// Quem operou. `dataOwnerId` não serve: num tenant com colaboradores ele é
// sempre o admin, então logar por ele apagaria justamente a informação que
// importa ("quem cancelou esta venda?").
export interface FinanceActor {
  id?: string | null;
  name?: string | null;
}

/**
 * Grava auditoria de uma ação do financeiro. Best-effort e não-bloqueante:
 * a operação já aconteceu e uma falha de log jamais pode desfazê-la.
 *
 * Sem `actor.id` não grava nada — é o que mantém o comportamento byte-idêntico
 * ao atual em todo caminho que não passa pelas rotas HTTP (scripts, importação,
 * testes que chamam o usecase direto).
 *
 * Usa `logUserActivity` (action "USER_ACTIVITY") em vez de um `LogAction` novo:
 * é o mesmo precedente da auditoria de colaboradores (team.routes.ts:651) e
 * evita mexer na união de tipos que várias telas de Logs consomem.
 */
function logFinanceAction(
  actor: FinanceActor | undefined,
  event: string,
  message: string,
  details: Record<string, unknown>,
): void {
  if (!actor?.id) return;
  void SystemLogService.logUserActivity(actor.id, message, {
    event,
    actorName: actor.name ?? null,
    ...details,
  }).catch((err) => {
    console.warn("[FinanceUseCase] auditoria falhou (ignorado):", err);
  });
}

// ── Bloco D: resumo das notas vinculadas a uma venda ──
// Vocabulário enxuto e estável para o cliente. Espelhado (por estrutura, não
// por import — o módulo do PDV é client-side e não pode puxar Prisma) em
// app/pdv/lib/pdv-actions.ts.
export type FiscalDocStatus =
  | "AUTHORIZED"
  | "PROCESSING"
  | "REJECTED"
  | "DRAFT";

export interface FiscalDocSummary {
  modelo: "55" | "65";
  nfeId: string;
  status: FiscalDocStatus;
  numero: number | null;
  serie: number | null;
  danfeDisponivel: boolean;
}

// Colapsa os 8 status de NfeEmitida (schema.prisma:1439) nos 4 do cliente.
// VALIDATING/SIGNING/SENDING => PROCESSING. INUTILIZED => DRAFT (não há
// documento a imprimir). CANCELLED não chega aqui: o lookup já o exclui.
function toFiscalDocStatus(raw: string): FiscalDocStatus {
  if (raw === "AUTHORIZED") return "AUTHORIZED";
  if (raw === "REJECTED") return "REJECTED";
  if (["VALIDATING", "SIGNING", "SENDING"].includes(raw)) return "PROCESSING";
  return "DRAFT";
}

function toFiscalDocSummary(
  modelo: "55" | "65",
  row: {
    id: string;
    status: string;
    numero: number;
    serie: number;
    danfePdfPath: string | null;
  },
): FiscalDocSummary {
  return {
    modelo,
    nfeId: row.id,
    status: toFiscalDocStatus(row.status),
    numero: row.numero ?? null,
    serie: row.serie ?? null,
    danfeDisponivel: Boolean(row.danfePdfPath),
  };
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
  // Multi-CNPJ — lazy pelo mesmo motivo dos acima.
  private companyFiscalRepoLazy: CompanyFiscalRepository | null = null;

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

  private get companyFiscalRepo(): CompanyFiscalRepository {
    if (!this.companyFiscalRepoLazy)
      this.companyFiscalRepoLazy = new CompanyFiscalRepository();
    return this.companyFiscalRepoLazy;
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

  /**
   * Bloco A — valida as linhas de pagamento (N formas na mesma venda).
   *
   * Ausente (`undefined`) => no-op: o fluxo de uma forma só continua
   * byte-idêntico. Presente => é fechamento de caixa, e fechamento de caixa
   * tem de FECHAR: a soma das linhas precisa bater com o total da venda.
   *
   * A comparação é em CENTAVOS INTEIROS. Em float, `0.1 + 0.2 !== 0.3` — uma
   * venda legítima paga em três formas seria rejeitada "por um centavo".
   *
   * Troco NÃO entra aqui: `amount` é o valor aplicado à venda, não o que o
   * cliente entregou. Troco é diferença de caixa e não é persistido.
   */
  private validatePayments(
    kind: FinanceKind,
    payments: unknown,
    totalAmount: number,
    // Com entrada + parcelas o alvo é a ENTRADA, não o total. A mensagem tem
    // de dizer isso: "excedem o total da venda" quando o operador digitou
    // exatamente o total manda ele procurar um erro que não existe.
    alvo: "total da venda" | "entrada" = "total da venda",
  ) {
    if (payments === undefined) return; // fluxo atual, intocado
    if (!Array.isArray(payments)) {
      throw new Error("Pagamentos inválidos: deve ser uma lista");
    }
    if (kind !== "receivable") {
      throw new Error(
        "Pagamentos inválidos: somente contas a receber aceitam múltiplas formas",
      );
    }
    if (payments.length === 0) return; // lista vazia = "sem detalhamento"

    for (const [idx, p] of payments.entries()) {
      if (!p || typeof p !== "object") {
        throw new Error(`Pagamento ${idx + 1} inválido`);
      }
      if (typeof p.method !== "string" || !PAYMENT_METHOD_CODES.includes(p.method)) {
        // "inválido" (masculino) é obrigatório: o buildCreateHandler mapeia o
        // status HTTP por SUBSTRING da mensagem (finance.routes.ts:178), e
        // "inválida" no feminino cairia em 500. Mesma armadilha que fez o
        // validateItems escrever "Item N inválido: ...".
        throw new Error(
          `Pagamento ${idx + 1} inválido: forma de pagamento não reconhecida`,
        );
      }
      if (
        typeof p.amount !== "number" ||
        !Number.isFinite(p.amount) ||
        toCents(p.amount) <= 0
      ) {
        throw new Error(
          `Pagamento ${idx + 1} inválido: valor deve ser maior que zero`,
        );
      }
    }

    const somaCents = sumPaymentsCents(payments as PaymentLine[]);
    const totalCents = toCents(totalAmount);
    if (somaCents !== totalCents) {
      const diff = (Math.abs(somaCents - totalCents) / 100).toFixed(2);
      throw new Error(
        somaCents < totalCents
          ? `Pagamentos inválidos: faltam R$ ${diff} para fechar ${alvo === "entrada" ? "a entrada" : "o total da venda"}`
          : `Pagamentos inválidos: excedem R$ ${diff} ${alvo === "entrada" ? "a entrada (com parcelamento, o pagamento combinado descreve só o que entra agora)" : "o total da venda"}`,
      );
    }
  }

  /**
   * Bloco B — valida o plano de entrada + parcelas.
   *
   * Ausente => no-op: a venda à vista continua byte-idêntica.
   *
   * Invariante central: `entrada + Σ parcelas === totalAmount` (em CENTAVOS).
   * É isso que garante que cada real da venda apareça em exatamente UMA linha
   * — sem dupla contagem em `summary`, relatório ou dashboard.
   *
   * Exige entrada > 0: sem entrada nenhuma, a venda é crediário puro, que já
   * tem caminho próprio (FIADO, conta PENDENTE) e não deve baixar estoque.
   */
  private validateInstallmentPlan(
    kind: FinanceKind,
    plan: unknown,
    totalAmount: number,
  ): void {
    if (plan === undefined || plan === null) return;
    if (kind !== "receivable") {
      throw new Error(
        "Parcelamento inválido: somente contas a receber podem ser parceladas",
      );
    }
    const p = plan as InstallmentPlanInput;
    if (!Array.isArray(p.installments) || p.installments.length === 0) {
      throw new Error("Parcelamento inválido: informe ao menos uma parcela");
    }
    if (p.installments.length > 360) {
      throw new Error("Parcelamento inválido: máximo de 360 parcelas");
    }
    if (
      typeof p.downPayment !== "number" ||
      !Number.isFinite(p.downPayment) ||
      toCents(p.downPayment) <= 0
    ) {
      throw new Error(
        "Parcelamento inválido: a entrada deve ser maior que zero (venda sem entrada é fiado)",
      );
    }

    for (const [idx, parcela] of p.installments.entries()) {
      if (
        typeof parcela?.amount !== "number" ||
        !Number.isFinite(parcela.amount) ||
        toCents(parcela.amount) <= 0
      ) {
        throw new Error(
          `Parcela ${idx + 1} inválida: valor deve ser maior que zero`,
        );
      }
      const d = parcela?.dueDate ? new Date(parcela.dueDate as any) : null;
      if (!d || Number.isNaN(d.getTime())) {
        throw new Error(`Parcela ${idx + 1} inválida: vencimento obrigatório`);
      }
    }

    const soma =
      toCents(p.downPayment) +
      p.installments.reduce((acc, i) => acc + toCents(i.amount), 0);
    const total = toCents(totalAmount);
    if (soma !== total) {
      const diff = (Math.abs(soma - total) / 100).toFixed(2);
      throw new Error(
        soma < total
          ? `Parcelamento inválido: entrada + parcelas ficam R$ ${diff} abaixo do total da venda`
          : `Parcelamento inválido: entrada + parcelas excedem R$ ${diff} o total da venda`,
      );
    }
  }

  /**
   * Deriva o método PREDOMINANTE quando há linhas de pagamento.
   *
   * O escalar `Receivable.paymentMethod` é sempre a verdade resumida — é o que
   * 41 pontos do sistema leem. Quando há detalhamento, ele passa a ser DERIVADO
   * (o método de maior valor) e o que veio no payload é ignorado: dois campos
   * dizendo coisas diferentes sobre a mesma venda é drift esperando acontecer.
   *
   * Sem linhas, nada muda — o payload manda, exatamente como hoje.
   */
  private applyPredominantMethod<T extends { paymentMethod?: string | null }>(
    data: T & { payments?: PaymentLine[] },
  ): T {
    if (!Array.isArray(data.payments) || data.payments.length === 0) return data;
    return { ...data, paymentMethod: predominantPaymentMethod(data.payments) };
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
    // Bloco B — no-op quando ausente. Precisa vir ANTES da validação de
    // pagamentos: com parcelamento, as linhas de pagamento descrevem a
    // ENTRADA, não o total da venda.
    this.validateInstallmentPlan(kind, data.installmentPlan, data.totalAmount);
    // Bloco A — no-op quando `payments` ausente. Antes do branch newCustomer
    // para valer nos dois fluxos, igual às validações acima.
    this.validatePayments(
      kind,
      (data as any).payments,
      // Com split, o que tem de fechar é a ENTRADA: é ela que foi recebida no
      // ato e que vira o `totalAmount` da conta-mãe.
      data.installmentPlan ? data.installmentPlan.downPayment : data.totalAmount,
      data.installmentPlan ? "entrada" : "total da venda",
    );
    // Havendo detalhamento, o escalar `paymentMethod` passa a ser DERIVADO
    // (predominante). Sem detalhamento, `data` volta inalterado.
    data = this.applyPredominantMethod(data);

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

    // Bloco A — só quando o payload traz detalhamento de pagamento. O total a
    // conferir é o do payload; se o update não mexe no total, é preciso ler o
    // valor gravado — senão a soma seria comparada contra `undefined`. A query
    // extra acontece SOMENTE neste caminho: o fluxo atual não paga por ela.
    const payments = (data as any).payments;
    if (payments !== undefined) {
      let total = data.totalAmount;
      if (total === undefined) {
        const current = await this.repo.findById(kind, id, userId);
        if (!current) throw new Error("Registro financeiro não encontrado");
        total = current.totalAmount;
      }
      this.validatePayments(kind, payments, total);
      data = this.applyPredominantMethod(data);
    }

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
    // Bloco F — ids dos produtos que NASCERAM nesta operação (peças avulsas).
    const promotedProductIds = new Set<string>();

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

        // ── Bloco F: peça avulsa vira produto de catálogo ──
        // Roda ANTES da baixa, na MESMA tx: o produto nasce, recebe a ENTRADA
        // (+qty) e em seguida a venda faz a SAÍDA (−qty), terminando em 0.
        // Rollback desfaz produto, vínculo e os dois StockLog juntos.
        const promoted = await this.promoteManualItems(tx, id, userId, items);
        for (const p of promoted) promotedProductIds.add(p.productId);

        // Baixa de estoque dentro da MESMA tx.
        const result = await StockDeductionService.deductWithinTx(tx, {
          // Apenas itens CADASTRADOS baixam estoque. Itens manuais
          // (productId null) não têm produto no catálogo — não geram
          // StockLog/baixa. Filtrar honra o tipo StockDeductionItem.productId
          // (string) e evita SELECT/StockLog com id nulo.
          items: [
            ...items
              .filter((it) => it.productId != null)
              .map((it) => ({
                productId: it.productId as string,
                quantity: it.quantity,
              })),
            // As peças recém-promovidas entram aqui: acabaram de ganhar
            // productId e estoque, e a venda tem de baixá-las igual às demais.
            ...promoted.map((p) => ({
              productId: p.productId,
              quantity: p.quantity,
            })),
          ],
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
    //
    // Bloco F: os produtos que NASCERAM nesta venda ficam de fora. Eles não
    // têm anúncio (pauseOnZero seria no-op) e, principalmente, disparariam o
    // alerta STOCK_ZEROED_IN_ONE_MOVE (stock-deduction.service.ts:352) — que
    // aqui é falso positivo: a peça avulsa nasce e morre com estoque 0 por
    // definição. Filtrar no chamador evita tocar o serviço de estoque.
    StockDeductionService.firePostEffects({
      deductions: deductions.filter((d) => !promotedProductIds.has(d.productId)),
      logPrefix: "[FinanceUseCase]",
      reason: `Venda balcão — Conta a Receber ${id}`,
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

  /**
   * Bloco F — promove peças avulsas (itens manuais) a produtos reais do
   * catálogo, DENTRO da transação do pagamento.
   *
   * Por que existe: hoje o item manual entra na sucata em DINHEIRO
   * (getScrapMoney usa `COALESCE(ri.scrapId, p.scrapId)`, e o LEFT JOIN deixa
   * a linha sobreviver) mas NÃO entra em QUANTIDADE (getScrapParts agrupa por
   * `productId`, e NULL nunca casa). Virar produto real fecha essa assimetria.
   *
   * Sequência por peça, tudo na mesma tx:
   *   1. cria o Product (SKU automático, estoque 0, herda a sucata do item);
   *   2. vincula o item ao produto e marca `autoCreatedProduct`;
   *   3. ENTRADA de +qty (o caller faz a SAÍDA de −qty logo depois).
   *
   * IDEMPOTÊNCIA (tripla):
   *   - `markPaid` já é no-op em conta PAGA;
   *   - o laço só olha itens com `productId == null`, e depois do passo 2 o
   *     item TEM productId — pagar de novo não cria um segundo produto;
   *   - a tx é atômica: rollback desfaz produto, vínculo e StockLog juntos.
   *
   * A entrada reusa `restoreWithinTx`, que já é um incremento de estoque com
   * StockLog, `FOR UPDATE` e advisory lock — nenhum caminho paralelo de
   * escrita de estoque foi criado.
   */
  private async promoteManualItems(
    tx: Prisma.TransactionClient,
    receivableId: string,
    userId: string,
    items: ReceivableItemSnapshot[],
  ): Promise<Array<{ productId: string; quantity: number }>> {
    if (!MANUAL_ITEM_CATALOG_ENABLED) return [];

    const alvos = items.filter(
      (it) => it.productId == null && it.createCatalogProduct === true,
    );
    if (alvos.length === 0) return [];

    const productUseCase = new ProductUseCase();
    const promoted: Array<{ productId: string; quantity: number }> = [];

    for (const it of alvos) {
      const nome = (it.description ?? "").trim() || "Peça avulsa";
      const created = await productUseCase.create(
        {
          userId,
          // autoSku reserva o próximo número da sequência humana do lojista;
          // `sku` só existe aqui para satisfazer o tipo (a rota faz igual).
          autoSku: true,
          sku: "",
          name: nome,
          // Estoque nasce ZERO: a entrada logo abaixo é que o move, deixando
          // os dois StockLog (+qty e −qty) explícitos no histórico.
          stock: 0,
          price: it.unitPrice,
          imageUrl: "",
          // Sucata do item (ou nenhuma). É o que faz a peça passar a contar em
          // getScrapParts. O tenant guard do repositório valida a posse.
          ...(it.scrapId ? { scrapId: it.scrapId } : {}),
          autoCreatedFromSale: true,
        },
        tx,
      );

      await (tx as any).receivableItem.update({
        where: { id: it.id },
        data: { productId: created.id, autoCreatedProduct: true },
      });

      promoted.push({ productId: created.id, quantity: it.quantity });
    }

    // ENTRADA (+qty) — reason distinta e legível, ao lado da saída da venda.
    await StockDeductionService.restoreWithinTx(tx, {
      items: promoted,
      reason: `Entrada — peça avulsa PDV · Conta a Receber ${receivableId}`,
      orderId: `receivable:${receivableId}`,
      logPrefix: "[FinanceUseCase]",
    });

    return promoted;
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
  async delete(
    kind: FinanceKind,
    id: string,
    userId: string,
    // Bloco E (aditivo): operador da ação, para auditoria. Ausente ⇒ nada é
    // logado ⇒ comportamento byte-idêntico ao atual.
    actor?: FinanceActor,
  ): Promise<void> {
    let snapshot: FinanceEntry | null = null;
    if (kind === "receivable") {
      const current = await this.repo.findById(kind, id, userId);
      snapshot = current ?? null;
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

      // Bloco B: venda parcelada não pode ser apagada pela ponta. A FK é
      // SetNull, então o delete deixaria as parcelas ÓRFÃS — cobranças soltas,
      // sem venda de origem, ainda no total a receber do cliente.
      if (current) {
        const filhas = await this.repo.findChildren(id, userId);
        if (filhas.length > 0) {
          throw new Error(
            "Venda parcelada não pode ser excluída — ela tem parcelas vinculadas. Use Estornar.",
          );
        }
      }
    }
    await this.repo.delete(kind, id, userId);

    // Auditoria pós-efeito, best-effort: até aqui o financeiro não deixava
    // nenhum rastro de quem excluiu o quê.
    logFinanceAction(actor, "FINANCE_ENTRY_DELETED", `Título excluído (${kind})`, {
      kind,
      receivableId: id,
      totalAmount: snapshot ? Number(snapshot.totalAmount) : null,
      status: snapshot?.status ?? null,
      itemCount: Array.isArray(snapshot?.items) ? snapshot!.items!.length : null,
    });
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
  async reverse(
    id: string,
    userId: string,
    // Bloco E (aditivo): operador da ação, para auditoria. Ausente ⇒ nada é
    // logado ⇒ comportamento byte-idêntico ao atual.
    actor?: FinanceActor,
  ): Promise<FinanceEntry> {
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

        // ── Bloco F: estorno SIMÉTRICO da peça avulsa ──
        // O restore acima devolveu +qty também para os produtos que nasceram
        // desta venda — e eles não existiam antes dela. Sem esta compensação,
        // o catálogo ficaria com um "produto fantasma" com estoque de uma peça
        // que já saiu. A saída de −qty devolve o produto a estoque 0.
        //
        // O produto NÃO é apagado: `ReceivableItem.product` é onDelete Restrict
        // e apagar produto apaga o StockLog junto (product.repository.ts:1630),
        // destruindo o histórico da venda. Fica no catálogo, zerado.
        const avulsas = items.filter(
          (it) => it.autoCreatedProduct === true && it.productId != null,
        );
        if (avulsas.length > 0) {
          await StockDeductionService.deductWithinTx(tx, {
            items: avulsas.map((it) => ({
              productId: it.productId as string,
              quantity: it.quantity,
            })),
            reason: `Estorno entrada — peça avulsa PDV · Conta a Receber ${id}`,
            orderId: `receivable:${id}`,
            logPrefix: "[FinanceUseCase]",
          });
          // Estes produtos NÃO entram no reopenOnRefill: eles não têm anúncio
          // e voltaram a zero — reabrir não faria sentido.
          const avulsasIds = new Set(avulsas.map((it) => it.productId));
          restorations = restorations.filter(
            (d) => !avulsasIds.has(d.productId),
          );
        }

        // ── Bloco B: nada de parcela viva em venda cancelada ──
        // Só as EM ABERTO. Parcela já recebida é dinheiro que entrou: cancelar
        // a linha faria o valor sumir do caixa sem devolução real. Essas ficam
        // como estão e o operador é avisado para tratar a devolução.
        await (tx as any).receivable.updateMany({
          where: {
            parentReceivableId: id,
            userId,
            status: { in: ["PENDENTE", "VENCIDA"] },
          },
          data: { status: "CANCELADA" },
        });
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

    // Auditoria (Bloco E): cancelar venda é a ação mais destrutiva do balcão —
    // devolve estoque, reabre anúncios e move dinheiro. Até agora não deixava
    // rastro nenhum de QUEM fez. Best-effort e pós-commit: a venda já foi
    // estornada e uma falha de log jamais pode desfazê-la.
    logFinanceAction(actor, "SALE_REVERSED", "Venda cancelada (estorno)", {
      receivableId: id,
      totalAmount: Number(current.totalAmount),
      itemCount: items.length,
      customerId: current.customerId,
      restoredProducts: restorations.length,
    });

    return updated!;
  }

  async summary(
    userId: string,
    unidadeId?: string,
    // PDV (aditivo): true => bucket de receivables só com vendas balcão
    // (contas com itens). Ausente => comportamento atual inalterado.
    hasItems?: boolean,
    // Bloco C (aditivo): resumo de UM cliente — histórico de compras da ficha.
    // Ausente => comportamento atual inalterado.
    customerId?: string,
  ): Promise<FinanceSummary> {
    return this.repo.summary(userId, unidadeId, hasItems, customerId);
  }

  // Lookup de produto para a UI do financeiro (autocompletar por SKU/nome).
  // Reusa exatamente o mesmo lookup do módulo fiscal (NfeDraftUseCase →
  // NfeRepository: name/sku/partNumber contains, take 20) — query única,
  // sem divergência. Desacopla a UI do financeiro do prefixo /fiscal.
  async lookupProducts(userId: string, query: string): Promise<ProductLookup[]> {
    return this.nfeDraftUseCase.lookupProducts(userId, query);
  }

  /**
   * Bloco D — notas fiscais já vinculadas a uma venda, pelo MESMO link textual
   * que sustenta a idempotência da NFC-e (numeroPedido="receivable:<id>", ver
   * nfe-draft.usecase.ts:608 — vale para os dois modelos).
   *
   * Leitura pura: nenhuma escrita, nenhuma emissão. Serve ao menu "Ações" do
   * livro do dia decidir entre "Emitir" e "Reimprimir/Consultar" — sem isso o
   * botão de emitir seria um tiro no escuro sobre uma nota que já existe.
   *
   * Reusa `findByNumeroPedidoAndModelo` (que já ignora CANCELLED, e por isso
   * uma nota cancelada volta a liberar nova emissão — correto). Os 8 status de
   * NfeEmitida são colapsados em 4 para o cliente; INUTILIZED é tratado como
   * DRAFT (nota inutilizada não tem documento a imprimir).
   */
  async listFiscalDocsForReceivable(
    receivableId: string,
    userId: string,
  ): Promise<FiscalDocSummary[]> {
    const numeroPedido = `receivable:${receivableId}`;
    // Duas consultas independentes (modelos distintos) — em paralelo.
    const [nfce, nfe] = await Promise.all([
      this.nfeRepo.findByNumeroPedidoAndModelo(userId, numeroPedido, "65"),
      this.nfeRepo.findByNumeroPedidoAndModelo(userId, numeroPedido, "55"),
    ]);

    const docs: FiscalDocSummary[] = [];
    if (nfce) docs.push(toFiscalDocSummary("65", nfce));
    if (nfe) docs.push(toFiscalDocSummary("55", nfe));
    return docs;
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
    // /fiscal-draft atual byte-idêntico). Multi-CNPJ: companyFiscalConfigId
    // opcional seleciona o emitente (ausente = CNPJ padrão).
    opts?: { modelo?: "55" | "65"; companyFiscalConfigId?: string | null },
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
    opts?: { modelo?: "55" | "65"; companyFiscalConfigId?: string | null },
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
    // Bloco A — a nota sai com N meios de pagamento quando a venda foi paga de
    // forma combinada. O pipeline fiscal JÁ suportava N ponta a ponta (o tipo é
    // array, o builder de XML itera em `pagamentos.forEach`, a validação exige
    // `>= 1` e a UI do wizard usa useFieldArray) — o único ponto preso em 1 era
    // este array literal aqui.
    //
    // Sem detalhamento, o comportamento é EXATAMENTE o anterior: um pagamento
    // com o total da conta e fallback "DINHEIRO" para método nulo/desconhecido.
    const pagamentos =
      Array.isArray(entry.payments) && entry.payments.length > 0
        ? entry.payments.map((p) => ({
            meio: mapPaymentMethodToMeio(p.method) ?? "DINHEIRO",
            valor: Number(p.amount),
          }))
        : [
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
      // Multi-CNPJ: emitente do seletor do PDV (ausente = padrão).
      ...(opts?.companyFiscalConfigId
        ? { companyFiscalConfigId: opts.companyFiscalConfigId }
        : {}),
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
  async emitNfceFromReceivable(
    receivableId: string,
    userId: string,
    // Multi-CNPJ: emitente do seletor do PDV. Ausente = CNPJ padrão. Quando a
    // venda JÁ tem draft/nota (idempotência), o emitente do draft existente
    // prevalece — a seleção só vale para draft novo.
    companyFiscalConfigId?: string | null,
  ) {
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
      // Multi-CNPJ: seleção EXPLÍCITA vence — se o operador trocou o emitente
      // no retry (draft anterior falhou, ex.: CSC ausente no CNPJ A), o draft
      // reusado é atualizado para o config novo (com a série NFC-e DELE).
      // Explícito inválido lança; sem seleção, o draft segue como está.
      if (
        companyFiscalConfigId &&
        companyFiscalConfigId !== (existing.companyFiscalConfigId ?? null)
      ) {
        const cfg = await this.companyFiscalRepo.findByIdForUser(
          companyFiscalConfigId,
          userId,
        );
        if (!cfg) throw new Error("Emitente selecionado não encontrado");
        await this.nfeDraftUseCase.update(userId, existing.id, {
          companyFiscalConfigId: cfg.id,
          serie: cfg.serieNfce ?? 1,
        });
      }
      nfeId = existing.id;
    } else {
      const draft = await this.createFiscalDraftFromEntry(entry, userId, {
        modelo: "65",
        ...(companyFiscalConfigId ? { companyFiscalConfigId } : {}),
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
