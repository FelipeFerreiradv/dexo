// Tool de DIAGNÓSTICO OPERACIONAL: "o que está quebrado agora?".
//
// Junta as quatro fontes que respondem isso, na ordem em que doem:
//
//  1. PENDÊNCIAS DE IMPORTAÇÃO — vendas que o marketplace devolveu e que o Dexo
//     não conseguiu virar pedido. É a mais grave: enquanto está aberta, o
//     ESTOQUE NÃO FOI BAIXADO e a peça segue vendável nos outros canais.
//  2. ANÚNCIOS COM ERRO — `ProductListing.lastError`, o que o marketplace
//     recusou.
//  3. CICLOS DE SINCRONIZAÇÃO COM FALHA — `SyncLog`.
//  4. CONTAS DE MARKETPLACE EM ERRO — token caído, autorização expirada.
//
// Nenhuma delas tem função de leitura reutilizável no sistema: a listagem de
// pendências vive INLINE no handler de `/orders/ingestion-issues`
// (order.routes.ts:405-428) e não existe repositório para ela. As queries aqui
// espelham aquele filtro linha a linha.
//
// ⚠️ NÃO EMBRULHAR, e por isso não estão aqui: `OrderIngestionReconcilerService`
// (bate no marketplace, cria pedido, BAIXA ESTOQUE),
// `SyncUseCase.getShopeeImportJobStatus` (tem nome de getter e faz UPDATE) e
// `SystemLogService.cleanupOldLogs` (apaga log).

import { z } from "zod";

import prisma from "../../../lib/prisma";
import type { OrderIngestionIssueReason } from "../../../marketplaces/services/order-ingestion-issue.service";
import type { AiTool } from "../registry";
import { dataHora, texto } from "../serialize";

const MAX_LINHAS = 15;
const MAX_HORAS = 168; // 7 dias

const ESCOPOS = ["tudo", "pedidos", "anuncios", "sincronizacao"] as const;

/**
 * Motivo da pendência em português. Espelha o `descreveMotivo` da tela de
 * Pedidos (`order.routes.ts:65-86`).
 *
 * ⚠️⚠️ ESTE MAPA JÁ ESTEVE ERRADO, E O ERRO ERA INVISÍVEL. Ele nasceu com
 * quatro chaves — `PRODUCT_NOT_FOUND`, `NO_ITEMS`, `ACCOUNT_ERROR` e `UNKNOWN`
 * —, das quais só a primeira existe de verdade: o vocabulário real é o
 * `OrderIngestionIssueReason` de `order-ingestion-issue.service.ts:8-24`, com
 * OITO motivos. As outras três eram invenção minha.
 *
 * O efeito prático apareceu no primeiro teste com dados reais: as 12 pendências
 * da loja são todas `NO_LINKED_ITEMS`, que não estava no mapa — então o
 * `?? i.reason` do fim caía no código cru e o lojista lia
 * "Motivo: NO_LINKED_ITEMS" no chat. O agente existe justamente para NÃO falar
 * assim.
 *
 * ⭐ Por isso o mapa agora é `Record<OrderIngestionIssueReason, string>` e não
 * `Record<string, string>`: acrescentar um motivo novo àquele union sem escrever
 * o texto aqui PARA DE COMPILAR. É a única forma de este arquivo não voltar a
 * divergir em silêncio.
 *
 * ⚠️ Os textos são os MESMOS da tela, de propósito. O lojista pergunta ao Bitz e
 * depois abre Pedidos para resolver; ler duas descrições diferentes do mesmo
 * problema faria ele achar que são dois problemas.
 */
const MOTIVO: Record<OrderIngestionIssueReason, string> = {
  NO_LINKED_ITEMS:
    "o anúncio vendido não está vinculado a nenhum produto do seu estoque",
  PARTIAL_LINK:
    "parte dos itens deste pedido não está vinculada a produtos do seu estoque — esses itens não baixaram estoque",
  PRODUCT_NOT_FOUND:
    "o SKU do anúncio vendido não corresponde a nenhum produto do seu estoque",
  ITEM_WITHOUT_SKU:
    "o anúncio vendido está sem SKU no marketplace e não está vinculado a um produto",
  STOCK_DEDUCTION_FAILED:
    "o pedido entrou, mas a baixa de estoque falhou. Estamos tentando novamente",
  FETCH_FAILED: "não conseguimos buscar este pedido no marketplace",
  UNKNOWN_STATUS: "este pedido está num status que ainda não sabemos tratar",
  INGEST_FAILED:
    "houve uma falha inesperada ao importar este pedido. Estamos tentando novamente",
};

// ⭐ SUGESTÃO REGISTRADA, NÃO IMPLEMENTADA: o conserto definitivo é exportar
// `descreveMotivo` de `order-ingestion-issue.service.ts` — que já é o dono do
// vocabulário — e fazer a rota E esta tool consumirem a MESMA função. Aí não
// existiria divergência possível, em vez de existirem duas cópias que um teste
// compara. Não foi feito agora porque exigiria mexer em `order.routes.ts`, que
// está fora do escopo desta branch, e o ganho é de manutenção, não de
// comportamento: o teste abaixo já barra a divergência.

export const diagnosticoOperacional: AiTool = {
  name: "diagnostico_operacional",
  description:
    "Mostra o que está com problema na operação agora: vendas que não viraram pedido (e por isso NÃO baixaram estoque), " +
    "anúncios recusados pelo marketplace, ciclos de sincronização que falharam e contas de marketplace com erro. " +
    "Use quando o usuário disser que algo 'não apareceu', 'não sincronizou', 'deu erro' ou que o estoque não bate.",
  args: z
    .object({
      escopo: z
        .enum(ESCOPOS)
        .optional()
        .describe("Que área investigar. Padrão 'tudo'."),
      horas: z
        .number()
        .int()
        .min(1)
        .max(MAX_HORAS)
        .optional()
        .describe(
          `Janela de tempo para sincronização e anúncios. Máximo ${MAX_HORAS} (7 dias). Padrão 48.`,
        ),
    })
    .strict(),
  kind: "read",
  page: "logs",
  keywords: [
    "erro",
    "problema",
    "falhou",
    "nao sincronizou",
    "nao apareceu",
    "pendencia",
    "estoque nao bate",
    "diagnostico",
    "travou",
    "recusad",
    "sincroniz",
  ],
  sourceLabel: "Diagnóstico da sua operação",
  handler: async (args, scope) => {
    const userId = scope.dataOwnerId;
    const escopo = args.escopo ?? "tudo";
    const horas = Math.min(args.horas ?? 48, MAX_HORAS);
    const desde = new Date(Date.now() - horas * 60 * 60 * 1000);

    const quer = (alvo: string) => escopo === "tudo" || escopo === alvo;
    const resultado: Record<string, unknown> = {
      janela: `últimas ${horas} horas (pendências de importação são listadas independentemente da janela)`,
    };

    // 1. Pendências de importação. Mesmo filtro de order.routes.ts:394-400.
    if (quer("pedidos")) {
      const filtro = {
        status: { in: ["OPEN", "NEEDS_ACTION"] },
        marketplaceAccount: { userId },
      };
      const [total, linhas] = await Promise.all([
        (prisma as any).orderIngestionIssue.count({ where: filtro }),
        (prisma as any).orderIngestionIssue.findMany({
          where: filtro,
          orderBy: { createdAt: "asc" },
          take: MAX_LINHAS,
          select: {
            id: true,
            platform: true,
            externalOrderId: true,
            reason: true,
            status: true,
            attempts: true,
            createdAt: true,
            marketplaceAccount: { select: { accountName: true } },
          },
        }),
      ]);

      resultado.pendenciasDeImportacao = {
        gravidade:
          "ALTA — enquanto estas pendências estiverem abertas, o estoque das vendas correspondentes NÃO foi baixado, e a peça continua vendável nos outros canais.",
        total,
        exibidas: linhas.length,
        itens: linhas.map((i: any) => ({
          id: i.id,
          canal: i.platform,
          conta: i.marketplaceAccount?.accountName ?? null,
          pedidoNoMarketplace: i.externalOrderId,
          // ⚠️ O `??` continua: `reason` é String livre no banco (não enum do
          // Prisma), então um motivo gravado por uma versão futura ainda chega
          // aqui. Cair no código cru é feio, mas é melhor que devolver vazio —
          // e agora é caminho de exceção, não o caso mais comum da base.
          motivo: MOTIVO[i.reason as OrderIngestionIssueReason] ?? i.reason,
          tentativas: i.attempts,
          desde: dataHora(i.createdAt),
          // O reconciliador automático só processa OPEN
          // (order-ingestion-reconciler.service.ts:65). Dizer "estamos
          // tentando de novo" para uma NEEDS_ACTION seria mentira.
          precisaDeAcaoManual: i.status === "NEEDS_ACTION",
        })),
        comoResolver:
          "As de motivo 'nenhuma peça casou' se resolvem cadastrando ou corrigindo o SKU da peça e mandando tentar de novo na tela de Pedidos. As marcadas como 'precisa de ação manual' NÃO se resolvem sozinhas.",
      };
    }

    // 2. Anúncios com erro.
    if (quer("anuncios")) {
      const filtro = {
        lastError: { not: null },
        updatedAt: { gte: desde },
        marketplaceAccount: { userId },
      };
      const [total, linhas] = await Promise.all([
        prisma.productListing.count({ where: filtro as any }),
        prisma.productListing.findMany({
          where: filtro as any,
          orderBy: { updatedAt: "desc" },
          take: MAX_LINHAS,
          select: {
            id: true,
            externalListingId: true,
            status: true,
            lastError: true,
            updatedAt: true,
            retryEnabled: true,
            marketplaceAccount: {
              select: { platform: true, accountName: true },
            },
            product: { select: { sku: true, name: true } },
          },
        }),
      ]);

      resultado.anunciosComErro = {
        total,
        exibidos: linhas.length,
        itens: linhas.map((l: any) => ({
          sku: l.product?.sku ?? null,
          peca: texto(l.product?.name, 80),
          canal: l.marketplaceAccount?.platform ?? null,
          conta: l.marketplaceAccount?.accountName ?? null,
          situacao: l.status,
          erro: texto(l.lastError, 300),
          quando: dataHora(l.updatedAt),
          vaiTentarDeNovo: Boolean(l.retryEnabled),
        })),
      };
    }

    // 3 e 4. Sincronização: ciclos com falha + contas em erro.
    if (quer("sincronizacao")) {
      const [falhas, contas] = await Promise.all([
        prisma.syncLog.findMany({
          where: {
            status: "FAILURE",
            createdAt: { gte: desde },
            marketplaceAccount: { userId },
          },
          orderBy: { createdAt: "desc" },
          take: MAX_LINHAS,
          select: {
            id: true,
            type: true,
            message: true,
            createdAt: true,
            marketplaceAccount: {
              select: { platform: true, accountName: true },
            },
          },
        }),
        prisma.marketplaceAccount.findMany({
          where: { userId, status: { not: "ACTIVE" } },
          select: {
            platform: true,
            accountName: true,
            status: true,
            updatedAt: true,
          },
        }),
      ]);

      resultado.sincronizacao = {
        ciclosComFalha: falhas.map((s: any) => ({
          tipo: s.type,
          canal: s.marketplaceAccount?.platform ?? null,
          conta: s.marketplaceAccount?.accountName ?? null,
          mensagem: texto(s.message, 240),
          quando: dataHora(s.createdAt),
        })),
        contasComProblema: contas.map((c: any) => ({
          canal: c.platform,
          conta: c.accountName,
          situacao: c.status,
          desde: dataHora(c.updatedAt),
        })),
        observacao:
          contas.length > 0
            ? "Conta com situação diferente de ACTIVE normalmente é autorização caída — só o administrador consegue reconectar."
            : undefined,
      };
    }

    return resultado;
  },
};
