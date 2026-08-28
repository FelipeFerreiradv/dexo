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
import {
  recordSaleEvent,
  diffSaleFields,
  isSaleTimelineEnabled,
} from "../financeiro/lib/sale-timeline";
import {
  describeCancelReason,
  isCancelReasonEnabled,
  type NormalizedCancelReason,
} from "../financeiro/lib/cancel-reasons";
import {
  blockedFieldsOnPaidSale,
  type SaleStateForGuard,
  isSaleEditGuardEnabled,
  saleEditGuardMessage,
  touchesProtectedFields,
} from "../financeiro/lib/sale-edit-guard";
import { deriveSaleStage, saleStageLabel } from "../financeiro/lib/sale-stage";
import {
  isSettlementEnabled,
  settlementBreakdown,
} from "../financeiro/lib/settlement";
import { isInstallmentPendingDeleteEnabled } from "../financeiro/lib/stock-reservation";
import {
  firePostReservationEffects,
  recomputeReservedStock,
  recomputeReservedStockWithinTx,
  type ReservationPropagation,
} from "../marketplaces/services/stock-reservation.service";
import { CustomerRepository } from "../repositories/customer.repository";
import {
  FinanceRepository,
  FinanceStatusConflictError,
} from "../repositories/finance.repository";
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
import {
  isReopenOnCancelEnabled,
  REOPEN_ON_CANCEL_DEFAULT,
} from "../services/reopen-listings-preference";
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
    // BLOCO H (aditivo): operador da ação, para a timeline. Ausente ⇒ nada
    // é registrado e o comportamento é byte-idêntico ao atual.
    actor?: FinanceActor,
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
      // BLOCO G — a propagação da reserva, coletada DENTRO da tx e disparada
      // depois dela. Ver o comentário do `ReservationSink` no repositório.
      let reserva: ReservationPropagation | null = null;
      const criadaQuick = await prisma.$transaction(async (tx) => {
        const customer = await this.customerUseCase.createWithTx(tx, {
          userId: data.userId,
          name: newCustomer.name,
          cpf: newCustomer.cpf ?? null,
        });
        return this.repo.create(
          kind,
          { ...rest, customerId: customer.id },
          tx,
          (r) => {
            reserva = r;
          },
        );
      });
      // Pós-commit: a venda já existe. Falha de auditoria não pode desfazê-la.
      this.registrarCriacao(kind, criadaQuick, actor);
      // Idem — e best-effort por dentro: `firePostReservationEffects` nunca
      // lança, porque a venda já está persistida e nada aqui pode desfazê-la.
      firePostReservationEffects(reserva, "[FinanceUseCase]");
      return criadaQuick;
    }

    // ── Fluxo atual — 100% inalterado ──
    this.validate(data);
    await this.assertCustomer(data.customerId, data.userId);
    if (data.unidadeId) await this.assertUnidade(data.unidadeId, data.userId);
    // BLOCO G — o `await` do create já é pós-commit: quando há itens, o
    // repositório abre a própria transação e só retorna depois de fechá-la.
    let reservaCriada: ReservationPropagation | null = null;
    const criada = await this.repo.create(kind, data, undefined, (r) => {
      reservaCriada = r;
    });
    this.registrarCriacao(kind, criada, actor);
    firePostReservationEffects(reservaCriada, "[FinanceUseCase]");
    return criada;
  }

  async update(
    kind: FinanceKind,
    id: string,
    userId: string,
    data: FinanceEntryUpdate,
    // BLOCO H (aditivo): ausente ⇒ evento sem autor.
    actor?: FinanceActor,
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

    // BLOCO H — o "o quê mudou" precisa do ANTES. Só lê quando a timeline
    // está ligada E é receivable: fora disso, nenhuma consulta extra.
    const querAuditar = kind === "receivable" && isSaleTimelineEnabled();
    // BLOCO E — a guarda de venda recebida também precisa do estado atual, mas
    // só quando o payload ENCOSTA num campo vigiado. Sem isso, nenhuma
    // consulta: editar o documento de uma conta segue custando o mesmo de hoje.
    const querGuardar =
      kind === "receivable" &&
      isSaleEditGuardEnabled() &&
      touchesProtectedFields(data as Record<string, unknown>);
    // Uma leitura serve às duas necessidades — nunca duas.
    const antes =
      querAuditar || querGuardar
        ? await this.repo.findById(kind, id, userId)
        : null;

    if (querGuardar) {
      // A conta sumiu entre a tela e o submit: deixa o erro de "não
      // encontrado" seguir o caminho de sempre (404), em vez de virar um
      // bloqueio confuso.
      if (!antes) throw new Error("Registro financeiro não encontrado");
      // O 4º argumento é o ANTES que já está em mãos (l. 597-600): a guarda
      // compara VALOR, não presença de chave, e sem ele voltaria a recusar
      // todo save — o formulário reenvia `totalAmount` e a lista de itens
      // inteira em toda edição de venda de balcão. Zero consulta nova.
      const bloqueados = blockedFieldsOnPaidSale(
        data as Record<string, unknown>,
        antes.status,
        process.env,
        antes as unknown as SaleStateForGuard,
      );
      if (bloqueados.length > 0) {
        // A mensagem contém "Estornar" — é por ela que o handler mapeia 409,
        // exatamente como já faz com o DELETE de conta paga com itens.
        throw new Error(saleEditGuardMessage(bloqueados));
      }
    }

    // BLOCO G — editar os itens muda o que está comprometido. Quando o payload
    // NÃO traz `items`, o repositório roteia para `updateSingle` e o sink nunca
    // é chamado: nada mudou de reserva, nada a propagar.
    let reservaEditada: ReservationPropagation | null = null;
    const atualizada = await this.repo.update(
      kind,
      id,
      userId,
      data,
      undefined,
      undefined,
      (r) => {
        reservaEditada = r;
      },
    );
    firePostReservationEffects(reservaEditada, "[FinanceUseCase]");

    if (antes) {
      const campos = diffSaleFields(
        antes as unknown as Record<string, unknown>,
        data as unknown as Record<string, unknown>,
      );
      recordSaleEvent({
        receivableId: id,
        userId,
        type: "UPDATED",
        message:
          campos.length > 0
            ? `Venda alterada: ${campos.join(", ")}`
            : "Venda alterada",
        details: { fields: campos },
        actor,
      });
    }
    return atualizada;
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
  /**
   * BLOCO H — evento de criação. Só receivable: a timeline é da VENDA.
   * Best-effort e pós-commit, como todo o resto da auditoria.
   */
  private registrarCriacao(
    kind: FinanceKind,
    entry: FinanceEntry,
    actor?: FinanceActor,
  ): void {
    if (kind !== "receivable") return;
    const itens = Array.isArray(entry.items) ? entry.items.length : 0;
    recordSaleEvent({
      receivableId: entry.id,
      userId: entry.userId,
      type: "CREATED",
      message:
        itens > 0
          ? `Venda criada com ${itens} ${itens === 1 ? "item" : "itens"}`
          : "Conta a receber criada",
      details: {
        totalAmount: Number(entry.totalAmount),
        itemCount: itens,
        paymentMethod: entry.paymentMethod ?? null,
      },
      actor,
    });
  }

  async markPaid(
    kind: FinanceKind,
    id: string,
    userId: string,
    // BLOCO H (aditivo): ausente ⇒ evento sem autor, comportamento idêntico.
    actor?: FinanceActor,
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
    // BLOCO G — alertas de venda além do estoque. Coletados dentro da tx e
    // registrados DEPOIS do commit: a venda já aconteceu, e falhar o log não
    // pode desfazê-la.
    let oversellAlerts: Array<{
      productId: string;
      productName?: string;
      requested: number;
      available: number;
    }> = [];
    // Bloco F — ids dos produtos que NASCERAM nesta operação (peças avulsas).
    const promotedProductIds = new Set<string>();
    // BLOCO G — propagação da reserva liberada pelo recebimento. Quase sempre
    // vem VAZIA, e isso é o desejado: ver o comentário no ponto do recálculo.
    let reservaRecebida: ReservationPropagation | null = null;

    try {
      await prisma.$transaction(
        async (tx) => {
          // Status + paidAt na MESMA tx.
          //
          // O guard `statusNot: "PAGA"` fecha uma corrida real: o `if (status ===
          // "PAGA")` acima roda FORA da transação, então dois POST /pay
          // simultâneos passavam os dois e baixavam estoque duas vezes — e, em
          // venda com peça avulsa, criavam DOIS produtos de catálogo para a mesma
          // peça (o `promoteManualItems` abaixo filtra sobre este mesmo snapshot).
          //
          // A ORDEM É CARREGADORA: esta é a PRIMEIRA escrita da tx, antes de
          // promover peça avulsa e antes de deduzir estoque. O perdedor bloqueia
          // aqui no row lock e sai por rollback sem ter criado nem deduzido nada.
          // Não reordenar.
          updated = await this.repo.update(
            kind,
            id,
            userId,
            { status: "PAGA", paidAt: new Date() },
            tx,
            { statusNot: "PAGA" },
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
          // BLOCO G — a MEDIÇÃO que faltava. `deductWithinTx` clampa a baixa
          // em zero e devolve `oversellAlerts`; o `OrderUseCase` os registra,
          // mas este caminho só lia `deductions` e os descartava. Resultado: a
          // venda dupla no balcão acontecia sem deixar rastro nenhum, e não
          // havia como medir a frequência do problema que a reserva existe
          // para resolver.
          //
          // Sem flag: registrar o que já acontece é correção pura, e é o dado
          // que vai decidir se a virada do sync (fase seguinte, 25 pontos de
          // escrita) vale o risco.
          oversellAlerts = result.oversellAlerts ?? [];

          // A venda saiu de PENDENTE: o estoque foi baixado de verdade, então
          // a reserva daquelas peças deixa de existir. Recalculado a partir da
          // verdade, dentro da mesma tx.
          //
          // ⭐ E É AQUI QUE O ANÚNCIO NÃO PISCA. O `deductWithinTx` logo acima
          // já baixou o `stock` nesta MESMA transação, então o disponível ANTES
          // que o recálculo lê já é o de depois da baixa: a peça de estoque 1
          // reservada estava em 0 e continua em 0 (`stock` 1→0, reserva 1→0).
          // Disponível igual ⇒ `changed` vazio ⇒ nenhum job novo, nenhuma
          // chamada de marketplace, e nada que traga o anúncio de volta ao ar
          // entre reservar e receber.
          reservaRecebida = await recomputeReservedStockWithinTx(
            tx,
            items.map((it) => it.productId),
          );
        },
        { timeout: 60_000, maxWait: 20_000 },
      );
    } catch (e) {
      if (e instanceof FinanceStatusConflictError) {
        // Perdeu a corrida — outra requisição já recebeu esta conta. A tx
        // sofreu rollback, então nada foi criado nem deduzido aqui. Resposta
        // idêntica à do caminho "já PAGA" no topo do método: mesmo contrato,
        // sem efeito colateral. NÃO dispara firePostEffects nem reconciliação
        // de sucata — quem venceu a corrida já cuidou dos dois.
        const atual = await this.repo.findById(kind, id, userId);
        if (!atual) throw new Error("Registro financeiro não encontrado");
        return atual;
      }
      throw e;
    }

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

    // BLOCO G — irmão do de cima, e no caso normal um no-op: receber uma venda
    // não muda o disponível (ver o recálculo dentro da tx). Fica aqui porque
    // existe um caso em que MUDA — venda de peça com estoque de sobra, em que a
    // baixa real derruba o disponível abaixo do que a reserva já segurava — e
    // omitir a chamada deixaria esse anúncio dessincronizado.
    firePostReservationEffects(reservaRecebida, "[FinanceUseCase]");

    // Reflexo no fluxo da sucata (best-effort, pós-commit, idempotente):
    // AVAILABLE→IN_USE→DEPLETED conforme a venda atribuída ao lote. Irmão do
    // firePostEffects — NUNCA trava nem reverte o pagamento (já commitado).
    ScrapStatusReconcileService.reconcileForReceivable({
      receivableId: id,
      userId,
      logPrefix: "[FinanceUseCase]",
    });

    // BLOCO G — a venda dupla, finalmente visível. Cada alerta é uma peça que
    // foi vendida além do que existia: o `deductWithinTx` clampou a baixa em
    // zero e seguiu, e até agora ninguém ficava sabendo. É este log que vai
    // dizer, com número, se a virada do sync vale o risco dos 25 pontos.
    for (const a of oversellAlerts) {
      logFinanceAction(actor, "SALE_OVERSELL", "Venda acima do estoque", {
        receivableId: id,
        productId: a.productId,
        productName: a.productName,
        solicitado: a.requested,
        disponivel: a.available,
      });
    }

    // BLOCO H — recebimento na timeline. Pós-commit e best-effort.
    recordSaleEvent({
      receivableId: id,
      userId,
      type: "PAID",
      message: "Venda recebida — estoque baixado",
      details: {
        totalAmount: Number(current.totalAmount),
        productsDeducted: deductions.length,
      },
      actor,
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
          // BLOCO G — o BECO SEM SAÍDA que a reserva transformou em armadilha.
          //
          // Uma venda parcelada que NUNCA foi recebida não tinha caminho
          // nenhum: o `delete` recusava aqui e o `reverse` recusava por não
          // estar PAGA (:1111-1115). Sem reserva isso era só um incômodo. Com
          // a reserva ligada, a peça fica comprometida PARA SEMPRE — sai do
          // disponível e ninguém consegue devolvê-la.
          //
          // Destravar é seguro só quando NADA foi pago: aí o estoque nunca
          // baixou (a baixa é do `markPaid`) e nenhum dinheiro entrou, então
          // não há o que devolver — só o que apagar. Parcela já recebida é
          // dinheiro no caixa e continua bloqueando.
          const algumaPaga = filhas.some((f) => f.status === "PAGA");
          const podeApagarTudo =
            isInstallmentPendingDeleteEnabled() &&
            current.status !== "PAGA" &&
            !algumaPaga;

          if (!podeApagarTudo) {
            throw new Error(
              "Venda parcelada não pode ser excluída — ela tem parcelas vinculadas. Use Estornar.",
            );
          }

          const { children } = await this.repo.deleteWithChildren(id, userId);

          // Mesmo recálculo do caminho normal, mesmo motivo. Repetido aqui (e
          // não movido para depois do `if`) porque este ramo já apagou tudo e
          // precisa sair do método sem passar pelo `repo.delete` de baixo.
          if (Array.isArray(snapshot?.items)) {
            recomputeReservedStock(
              snapshot!.items!.map((it) => it.productId),
              "[FinanceUseCase]",
            );
          }

          logFinanceAction(
            actor,
            "FINANCE_ENTRY_DELETED",
            `Venda parcelada excluída (${children} parcela(s) junto)`,
            {
              kind,
              receivableId: id,
              totalAmount: snapshot ? Number(snapshot.totalAmount) : null,
              status: snapshot?.status ?? null,
              itemCount: Array.isArray(snapshot?.items)
                ? snapshot!.items!.length
                : null,
              installmentsDeleted: children,
            },
          );
          return;
        }
      }
    }
    await this.repo.delete(kind, id, userId);

    // BLOCO G — excluir a venda LIBERA as peças. É o caminho de "soltar" uma
    // reserva esquecida (não há expiração automática, por decisão de 14/08).
    // Fora de transação e best-effort: a venda já foi apagada, e falhar o
    // recálculo só deixa o número desatualizado até o próximo toque — que é
    // exatamente o modo de falha que o desenho por RECÁLCULO torna aceitável.
    if (kind === "receivable" && Array.isArray(snapshot?.items)) {
      recomputeReservedStock(
        snapshot!.items!.map((it) => it.productId),
        "[FinanceUseCase]",
      );
    }

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
    // BLOCO D (aditivo): motivo JÁ NORMALIZADO pela rota (o body é `any`; a
    // fronteira de tipo fica em `cancel-reasons.ts`). Ausente ou com a flag
    // desligada ⇒ o `data` do UPDATE fica byte-idêntico ao de hoje.
    cancelReason?: NormalizedCancelReason,
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

    try {
      await prisma.$transaction(
        async (tx) => {
          // 1. Status → CANCELADA na MESMA tx do estorno.
          //
          // `statusIs: "PAGA"` fecha a mesma corrida do markPaid, e aqui o dano
          // é pior: estorno duplo INFLA o estoque de uma peça que não voltou ao
          // pátio, e o marketplace passa a anunciar o que não existe. O guard de
          // idempotência no topo do método roda fora da transação.
          // Esta é a PRIMEIRA escrita da tx — o perdedor bloqueia aqui, antes de
          // restaurar estoque e antes de cancelar as parcelas filhas.
          //
          // BLOCO D — o motivo entra NA MESMA ESCRITA que grava CANCELADA, e
          // não num log pós-commit: se o operador se deu ao trabalho de dizer
          // por que cancelou, esse dado tem de ter a mesma durabilidade do
          // cancelamento. `cancelledAt` é gravado mesmo sem motivo informado —
          // "cancelada sem justificativa" continua sendo um fato com data.
          //
          // Flag ausente ⇒ `motivo` é {} e o `data` fica byte-idêntico ao de
          // hoje. Isso não é só compatibilidade: com as colunas ainda não
          // criadas, escrever aqui derrubaria a transação inteira e a venda
          // NÃO seria cancelada (ver o cabeçalho do DDL).
          const motivo = isCancelReasonEnabled()
            ? {
                cancelledAt: new Date(),
                ...(cancelReason?.code
                  ? { cancelReasonCode: cancelReason.code }
                  : {}),
                ...(cancelReason?.note
                  ? { cancelReason: cancelReason.note }
                  : {}),
              }
            : {};
          updated = await this.repo.update(
            "receivable",
            id,
            userId,
            { status: "CANCELADA", ...motivo },
            tx,
            { statusIs: "PAGA" },
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
    } catch (e) {
      if (e instanceof FinanceStatusConflictError) {
        // Perdeu a corrida — outro estorno já cancelou esta venda. Rollback
        // completo: nada foi restaurado aqui. Mesma resposta do caminho
        // "já CANCELADA" no topo, e sem disparar efeitos pós-commit (quem
        // venceu já reabriu anúncios e reconciliou a sucata).
        const atual = await this.repo.findById("receivable", id, userId);
        if (!atual) throw new Error("Conta a receber não encontrada");
        return atual;
      }
      throw e;
    }

    // Preferência do TENANT (default LIGADO). `userId` aqui JÁ é o dataOwnerId
    // — a rota resolve `parentUserId ?? id` (finance.routes.ts) —, então mesmo
    // quando quem estorna é um colaborador a leitura cai na linha certa.
    //
    // Só consulta quando há o que restaurar: sem restauração não existe anúncio
    // a reabrir, e a query seria desperdício. Nesse caminho o input do
    // firePostEffects fica byte-idêntico ao de antes desta mudança.
    const reabrirAnuncio =
      restorations.length > 0
        ? await isReopenOnCancelEnabled(userId)
        : REOPEN_ON_CANCEL_DEFAULT;

    // Pós-commit: sincroniza com marketplaces + reabre anúncios cujos
    // produtos saíram de zero. Best-effort, fora da tx.
    //
    // ⚠️ A chamada acontece SEMPRE; só a chave `reopenOnRefill` é condicional.
    // Envolvê-la num `if` mataria junto o StockSyncRetryService — o estoque
    // restaurado nunca chegaria aos marketplaces. Ver o gêmeo em
    // OrderUseCase.processOrderCancellation.
    StockDeductionService.firePostEffects({
      deductions: restorations,
      logPrefix: "[FinanceUseCase]",
      // Preferência OFF ⇒ o ESPELHO, não o vazio: o `runOnce` disparado por
      // `firePostEffects` empurra a quantidade restaurada e o marketplace
      // reabre o anúncio sozinho (ML remove o `out_of_stock`; OLX republica;
      // Facebook volta a "in stock"). Só omitir `reopenOnRefill` suprimiria o
      // `updateItem({status:"active"})`, que nunca foi quem reabria.
      ...(reabrirAnuncio
        ? { reopenOnRefill: { userId } }
        : { keepPausedOnRefill: { userId } }),
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
    // BLOCO H — cancelamento na timeline, com o motivo quando houver.
    // O motivo já está gravado em coluna (dentro da tx); aqui ele só é
    // REPETIDO para a leitura, porque quem abre o histórico não deve precisar
    // abrir a venda para saber o porquê.
    const motivoTexto = describeCancelReason(
      cancelReason?.code,
      cancelReason?.note,
    );
    recordSaleEvent({
      receivableId: id,
      userId,
      type: "REVERSED",
      message: motivoTexto
        ? `Venda cancelada (estorno) — ${motivoTexto}`
        : "Venda cancelada (estorno)",
      details: {
        totalAmount: Number(current.totalAmount),
        itemCount: items.length,
        restoredProducts: restorations.length,
        ...(cancelReason?.code ? { cancelReasonCode: cancelReason.code } : {}),
        ...(cancelReason?.note ? { cancelReason: cancelReason.note } : {}),
      },
      actor,
    });

    logFinanceAction(actor, "SALE_REVERSED", "Venda cancelada (estorno)", {
      receivableId: id,
      totalAmount: Number(current.totalAmount),
      itemCount: items.length,
      customerId: current.customerId,
      restoredProducts: restorations.length,
      ...(cancelReason?.code ? { cancelReasonCode: cancelReason.code } : {}),
      ...(cancelReason?.note ? { cancelReason: cancelReason.note } : {}),
    });

    return updated!;
  }

  /**
   * BLOCO F — move a venda de estágio operacional.
   *
   * Caminho PRÓPRIO, e não um campo no PUT, por dois motivos:
   *  1. o estágio muda MUITO (é operação de pátio, não de cadastro), e passar
   *     por um wizard de 4 passos para avançar uma etapa seria absurdo;
   *  2. o PUT carrega o replace de itens e a guarda do BLOCO E. O estágio não
   *     tem nada a ver com nenhum dos dois, e nem deve ser barrado por eles —
   *     uma venda PAGA continua andando no pátio (é justamente aí que ela anda).
   *
   * NÃO GOVERNA NADA: não valida transição, não exige ordem, não impede pular
   * etapa. É informação. Um pipeline que trava é um pipeline que alguém vai
   * contornar gravando no banco — decisão de 14/08.
   */
  async setSaleStage(
    id: string,
    userId: string,
    saleStage: string,
    actor?: FinanceActor,
  ): Promise<FinanceEntry> {
    const atual = await this.repo.findById("receivable", id, userId);
    if (!atual) throw new Error("Conta a receber não encontrada");

    // Idempotência: mesmo estágio ⇒ devolve sem escrever nem registrar evento.
    // Sem isto, um duplo clique no "avançar" viraria duas linhas iguais no
    // histórico da venda.
    const anterior = deriveSaleStage(atual.saleStage);
    if (anterior === saleStage) return atual;

    const atualizada = await this.repo.update("receivable", id, userId, {
      saleStage,
    } as never);

    // BLOCO H — o histórico operacional é justamente o que um pipeline precisa
    // ter: quem moveu, quando e de onde para onde. Best-effort e pós-escrita.
    recordSaleEvent({
      receivableId: id,
      userId,
      type: "UPDATED",
      message: `Estágio: ${saleStageLabel(anterior)} → ${saleStageLabel(saleStage)}`,
      details: { saleStageFrom: anterior, saleStageTo: saleStage },
      actor,
    });

    return atualizada;
  }

  /**
   * BLOCO A (2ª metade) — marca (ou desmarca) que o dinheiro caiu.
   *
   * Sem `paymentId`, marca a VENDA — é o caminho das vendas sem linhas de
   * pagamento, que são a esmagadora maioria (77 das 82 medidas). Com
   * `paymentId`, marca UMA forma, que é o "o PIX caiu, o cartão não".
   *
   * Desmarcar é permitido de propósito: conferência de extrato erra, e erro
   * precisa ter volta. O estágio (BLOCO F) segue a mesma filosofia.
   *
   * NÃO mexe em `status` nem em `paidAt`: a venda continua PAGA e o estoque
   * continua baixado. Liquidação é uma dimensão AO LADO — é o que garante que
   * os 8 lugares que somam dinheiro hoje continuem somando o mesmo.
   */
  async setSettlement(
    id: string,
    userId: string,
    settled: boolean,
    paymentId?: string,
    actor?: FinanceActor,
  ): Promise<FinanceEntry> {
    const atual = await this.repo.findById("receivable", id, userId);
    if (!atual) throw new Error("Conta a receber não encontrada");

    const quando = settled ? new Date() : null;

    if (paymentId) {
      // Escopo pelo receivableId ALÉM do id da linha: sem isso, um id de linha
      // de outro tenant marcaria liquidação numa venda alheia.
      const res = await (prisma as any).receivablePayment.updateMany({
        where: { id: paymentId, receivableId: id },
        data: { settledAt: quando },
      });
      if (res.count === 0) {
        throw new Error("Forma de pagamento não encontrada nesta venda");
      }
    } else {
      await this.repo.update("receivable", id, userId, {
        settledAt: quando,
      } as never);
    }

    recordSaleEvent({
      receivableId: id,
      userId,
      type: "UPDATED",
      message: settled
        ? "Dinheiro confirmado na conta"
        : "Confirmação de recebimento desfeita",
      details: { settled, paymentId: paymentId ?? null },
      actor,
    });

    // Relê para devolver o estado consolidado (a marca pode ter ido para uma
    // LINHA, e o chamador precisa do conjunto para recalcular o selo).
    const atualizada = await this.repo.findById("receivable", id, userId);
    return atualizada ?? atual;
  }

  /**
   * BLOCO A (2ª metade) — quanto já caiu e quanto ainda está a caminho.
   *
   * MÉTRICA NOVA, ao lado: não toca `summary()` nem nenhum dos lugares que
   * somam "recebido" hoje. Decisão de 14/08 — cada número existente continua
   * significando o que sempre significou.
   *
   * A conta é feita em TS, e não em SQL, porque a regra ("PIX cai no ato,
   * crédito não") vive no vocabulário de formas de pagamento. Reescrevê-la em
   * SQL seria mantê-la em dois lugares, e é assim que as duas divergem.
   *
   * Egress: projeção mínima sobre as contas PAGAS. Cresce com o histórico —
   * quando incomodar, o corte natural é por período (a tela já filtra por
   * data), não uma reescrita em SQL.
   */
  async settlementSummary(userId: string): Promise<{
    settledAmount: number;
    pendingAmount: number;
    pendingCount: number;
  }> {
    if (!isSettlementEnabled()) {
      return { settledAmount: 0, pendingAmount: 0, pendingCount: 0 };
    }
    const rows = await (prisma as any).receivable.findMany({
      where: { userId, status: "PAGA" },
      select: {
        totalAmount: true,
        status: true,
        paidAt: true,
        paymentMethod: true,
        settledAt: true,
        payments: { select: { method: true, amount: true, settledAt: true } },
      },
    });

    let settledAmount = 0;
    let pendingAmount = 0;
    let pendingCount = 0;
    for (const r of rows as any[]) {
      const b = settlementBreakdown(
        {
          status: r.status,
          paidAt: r.paidAt,
          paymentMethod: r.paymentMethod,
          settledAt: r.settledAt,
        },
        (r.payments ?? []).map((p: any) => ({
          method: p.method,
          amount: Number(p.amount),
          settledAt: p.settledAt,
        })),
        Number(r.totalAmount),
      );
      settledAmount += b.settledAmount;
      pendingAmount += b.pendingAmount;
      if (b.pendingAmount > 0) pendingCount += 1;
    }

    return {
      settledAmount: Math.round(settledAmount * 100) / 100,
      pendingAmount: Math.round(pendingAmount * 100) / 100,
      pendingCount,
    };
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

    // ── Venda parcelada: fechar a aritmética do grupo de pagamento ──
    //
    // Os ITENS acima são a venda INTEIRA (ficam todos na conta-mãe), mas
    // `entry.payments`/`entry.totalAmount` valem só a ENTRADA. Sem isto o
    // documento sai com SUM(vPag) = vNF − saldo a prazo: a nota diz que o
    // cliente pagou menos do que a mercadoria vale.
    //
    // É a MESMA reconciliação que a rota do cupom já faz (`findChildren`);
    // aqui ela só estava faltando no caminho fiscal. O saldo entra como
    // CREDITO_LOJA (SEFAZ 05), que é o crediário próprio da loja — o mesmo
    // meio que o sistema já usa para FIADO, e a descrição correta de um saldo
    // parcelado pela própria loja.
    //
    // Venda à vista não tem filhas ⇒ nada é acrescentado ⇒ byte-idêntico.
    const parcelas = await this.repo.findChildren(entry.id, userId);
    const saldoAPrazo = parcelas.reduce(
      (acc, f) => acc + Number(f.totalAmount),
      0,
    );
    if (saldoAPrazo > 0) {
      pagamentos.push({
        meio: "CREDITO_LOJA",
        valor: Number(saldoAPrazo.toFixed(2)),
      });
    }

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
    // O limite legal vale para a VENDA, não para a conta-mãe. Numa venda
    // parcelada, `totalAmount` da mãe guarda só a ENTRADA
    // (finance.repository.ts, createWithSplit) enquanto TODOS os itens ficam
    // nela: uma venda de R$ 12.000 com entrada de R$ 3.000 passava por este
    // guard e só era barrada lá na emissão, pelo total dos itens
    // (nfe-emission.usecase.ts) — erro tardio, em vez de rotear para a NF-e 55.
    //
    // Somar as filhas só pode AUMENTAR o valor avaliado, então nenhuma emissão
    // que hoje funciona deixa de funcionar. Venda à vista não tem filhas ⇒
    // soma 0 ⇒ comportamento byte-idêntico ao atual.
    const filhas = await this.repo.findChildren(receivableId, userId);
    const valorDaVenda =
      Number(entry.totalAmount) +
      filhas.reduce((acc, f) => acc + Number(f.totalAmount), 0);
    if (valorDaVenda > NFCE_LIMITE_VALOR) {
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

    // BLOCO H — só a emissão AUTORIZADA vira evento. Tentativa que falhou,
    // rejeição e reemissão idempotente não são fato da venda: poluiriam a
    // timeline do operador com ruído do pipeline fiscal.
    if (emission.status === "AUTHORIZED") {
      recordSaleEvent({
        receivableId,
        userId,
        type: "FISCAL_EMITTED",
        message: `NFC-e autorizada${emission.numero ? ` nº ${emission.numero}` : ""}`,
        details: {
          modelo: "65",
          numero: emission.numero ?? null,
          serie: emission.serie ?? null,
        },
      });
    }

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
