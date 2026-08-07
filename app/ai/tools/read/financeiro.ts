// Tools de leitura do FINANCEIRO: contas a receber, contas a pagar e orçamentos.
//
// Duas regras deste domínio que o payload não conta sozinho e que a tool
// carimba em toda resposta:
//
//  1. O RESUMO É VITALÍCIO. `FinanceUseCase.summary` não aceita janela de data
//     nenhuma (finance.repository.ts:688) — é o histórico inteiro do tenant.
//     Devolver esse número junto de uma lista filtrada por período, sem dizer,
//     faria o usuário ler "R$ 240 mil a receber" como se fosse do mês.
//
//  2. `totalAmount` DO RESUMO INCLUI CANCELADAS. O laço soma todos os status
//     (finance.repository.ts:742-749). `pendingAmount` e `paidAmount` são
//     recortes por status e não têm esse problema.
//
// A derivação de VENCIDA é a da casa e acontece dentro do usecase
// (applyOverdueFlag, finance.usecase.ts:1299): conta PENDENTE com vencimento
// no passado chega aqui já como VENCIDA.

import { z } from "zod";

import { BudgetUseCase } from "../../../usecases/budget.usecase";
import { FinanceUseCase } from "../../../usecases/finance.usecase";
import type { AiTool } from "../registry";
import { data, money, num, texto } from "../serialize";

const MAX_ITENS = 50;

const STATUS_FINANCE = ["PENDENTE", "PAGA", "VENCIDA", "CANCELADA"] as const;
const STATUS_BUDGET = [
  "ABERTO",
  "CONVERTIDO",
  "EXPIRADO",
  "CANCELADO",
] as const;

function projetarConta(e: any) {
  return {
    id: e.id,
    documento: e.document ?? null,
    motivo: texto(e.reason, 120),
    valor: money(e.totalAmount),
    vencimento: data(e.dueDate),
    situacao: e.status,
    pagaEm: data(e.paidAt),
    formaDePagamento: e.paymentMethod ?? null,
    cliente: e.customer?.name ?? null,
    unidade: e.unidade?.name ?? null,
    // Conta COM itens é venda de balcão; sem itens é lançamento avulso.
    vendaDeBalcao: Array.isArray(e.items) ? e.items.length > 0 : undefined,
    parcela:
      e.installmentNumber && e.installmentTotal
        ? `${e.installmentNumber}/${e.installmentTotal}`
        : null,
  };
}

/** As duas tools de conta são idênticas fora o `kind` — uma fábrica evita a divergência. */
function tratarContas(kind: "receivable" | "payable") {
  return async (args: any, scope: any) => {
    const limite = Math.min(args.limite ?? 20, MAX_ITENS);
    const usecase = new FinanceUseCase();

    const [lista, resumo] = await Promise.all([
      usecase.list(
        kind,
        {
          ...(args.situacao ? { status: args.situacao } : {}),
          ...(args.de ? { from: args.de } : {}),
          ...(args.ate ? { to: args.ate } : {}),
          ...(args.consulta ? { search: args.consulta } : {}),
          page: 1,
          limit: limite,
        },
        scope.dataOwnerId,
      ),
      usecase.summary(scope.dataOwnerId),
    ]);

    const bucket = kind === "receivable" ? resumo.receivables : resumo.payables;

    return {
      resumoDaLojaInteira: {
        // O rótulo é parte do dado: sem ele o número vira "do período".
        atencao:
          "Estes totais são de TODO o histórico da loja, não do período filtrado abaixo.",
        // ⭐ OS DOIS CONJUNTOS SE SOBREPÕEM.
        //
        // `pendingAmount` soma o grupo status='PENDENTE' — inclusive as que já
        // venceram. `overdueAmount` soma status IN ('PENDENTE','VENCIDA') com
        // vencimento no passado. Uma conta PENDENTE e vencida está NOS DOIS
        // (finance.repository.ts:717-736).
        //
        // Somar os dois é exatamente o que um modelo faz para responder "quanto
        // tenho a receber" — e conta essas contas duas vezes. O aviso vai no
        // payload porque ele precisa chegar ao modelo, não ao revisor.
        emAberto: money(bucket.pendingAmount),
        vencido: money(bucket.overdueAmount),
        contasVencidas: num(bucket.overdueCount),
        NAO_SOMAR:
          "`emAberto` e `vencido` SE SOBREPÕEM: uma conta pendente que já venceu está nos dois. NUNCA some os dois valores. `emAberto` já é o total a receber.",
        jaPago: money(bucket.paidAmount),
        // `totalAmount`/`totalCount` do resumo NÃO são expostos de propósito:
        // eles somam TODOS os status, inclusive CANCELADA e PAGA
        // (finance.repository.ts:742-749), e nenhuma tela mostra esse número.
        // Devolvê-lo daria ao modelo um "total" que não bate com nada.
      },
      periodo: {
        de: args.de ?? null,
        ate: args.ate ?? null,
        // O filtro de data do financeiro é por LANÇAMENTO, não por recebimento.
        filtradoPor: "data de lançamento da conta",
      },
      total: num(lista.total) ?? 0,
      exibidos: lista.items.length,
      observacao:
        (lista.total ?? 0) > lista.items.length
          ? `Existem ${lista.total} contas no filtro; estas são as ${lista.items.length} primeiras.`
          : undefined,
      itens: lista.items.map(projetarConta),
    };
  };
}

const argsConta = z
  .object({
    situacao: z
      .enum(STATUS_FINANCE)
      .optional()
      .describe("Situação da conta. VENCIDA é derivada do vencimento."),
    de: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("Data inicial de LANÇAMENTO, AAAA-MM-DD."),
    ate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("Data final de LANÇAMENTO, AAAA-MM-DD."),
    consulta: z
      .string()
      .max(80)
      .optional()
      .describe("Texto para buscar no documento, motivo ou cliente."),
    limite: z.number().int().min(1).max(MAX_ITENS).optional(),
  })
  .strict();

export const contasAReceber: AiTool = {
  name: "contas_a_receber",
  description:
    "Contas a receber da loja: vendas de balcão e lançamentos avulsos, com quanto está em aberto, vencido e já pago. " +
    "O resumo é de TODO o histórico (não aceita recorte de período); a lista respeita o filtro. " +
    "O período filtra pela data em que a conta foi LANÇADA, não pela data em que o dinheiro entrou.",
  args: argsConta,
  kind: "read",
  page: "financeiro",
  keywords: [
    "receber",
    "a receber",
    "caixa",
    "fiado",
    "vencid",
    "inadimpl",
    "cobran",
    "recebiment",
    "balcao",
    "balcão",
    "pdv",
    "pvd",
  ],
  sourceLabel: "Contas a receber",
  handler: tratarContas("receivable"),
};

export const contasAPagar: AiTool = {
  name: "contas_a_pagar",
  description:
    "Contas a pagar da loja, com quanto está em aberto, vencido e já pago. " +
    "O resumo é de TODO o histórico (não aceita recorte de período); a lista respeita o filtro.",
  args: argsConta,
  kind: "read",
  page: "financeiro",
  keywords: [
    "pagar",
    "a pagar",
    "despesa",
    "fornecedor",
    "boleto",
    "conta a pagar",
  ],
  sourceLabel: "Contas a pagar",
  handler: tratarContas("payable"),
};

export const buscarOrcamento: AiTool = {
  name: "buscar_orcamento",
  description:
    "Lista orçamentos (propostas ao cliente) com valor, validade e situação. " +
    "IMPORTANTE: orçamento NÃO é dinheiro — não entra em faturamento nem em contas a receber " +
    "enquanto não for convertido em venda. EXPIRADO é derivado da data de validade.",
  args: z
    .object({
      consulta: z.string().max(80).optional().describe("Texto para buscar."),
      situacao: z.enum(STATUS_BUDGET).optional(),
      limite: z.number().int().min(1).max(MAX_ITENS).optional(),
    })
    .strict(),
  kind: "read",
  page: "financeiro",
  keywords: [
    "orcamento",
    "orçamento",
    "proposta",
    "funil",
    "negocia",
    "kanban",
    "cotacao",
    "cotação",
  ],
  sourceLabel: "Orçamentos",
  handler: async (args, scope) => {
    const limite = Math.min(args.limite ?? 20, MAX_ITENS);
    const usecase = new BudgetUseCase();

    const lista: any = await usecase.list(
      {
        ...(args.consulta ? { search: args.consulta } : {}),
        ...(args.situacao ? { status: args.situacao as any } : {}),
        page: 1,
        limit: limite,
      },
      scope.dataOwnerId,
    );

    return {
      total: num(lista.total) ?? 0,
      exibidos: (lista.items ?? []).length,
      lembrete:
        "Orçamento não entra no financeiro até ser convertido em venda.",
      observacao:
        (lista.total ?? 0) > (lista.items ?? []).length
          ? `Existem ${lista.total} orçamentos no filtro; estes são os primeiros.`
          : undefined,
      itens: (lista.items ?? []).map((b: any) => ({
        id: b.id,
        documento: b.document ?? null,
        motivo: texto(b.reason, 120),
        valor: money(b.totalAmount),
        situacao: b.status,
        etapaDoFunil: b.pipelineStage ?? "NOVO",
        validoAte: data(b.validUntil),
        cliente: b.customer?.name ?? null,
        vendedor: b.vendedor?.name ?? null,
        motivoDaPerda: texto(b.lostReason, 120),
        criadoEm: data(b.createdAt),
      })),
    };
  },
};
