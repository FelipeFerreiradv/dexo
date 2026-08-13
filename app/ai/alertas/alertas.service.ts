// ⭐ O QUE MERECE INTERROMPER O LOJISTA — e, muito mais importante, o que NÃO
// merece.
//
// Este serviço alimenta o badge do mascote. Ele conta DUAS coisas, e a lista do
// que ficou de fora é a parte cara deste arquivo, porque foi decidida MEDINDO a
// produção, não supondo:
//
//  ✅ PENDÊNCIAS DE IMPORTAÇÃO abertas — venda que o marketplace devolveu e que
//     o Dexo não conseguiu virar pedido. Enquanto está aberta, O ESTOQUE NÃO FOI
//     BAIXADO e a peça segue vendável nos outros canais. É a única coisa que
//     pode custar uma venda duplicada enquanto ninguém olha.
//
//  ✅ CONTAS DE MARKETPLACE EM `ERROR` — autorização caída. Nada sincroniza,
//     e só o administrador reconecta.
//
// ⛔ FICOU DE FORA — ANÚNCIOS COM `lastError`. Medido em 12/08/2026: a maior
//    loja tem 1.368, e o erro mais antigo é de 26/05 — quase três meses parado.
//    Um badge sobre isso nasceria ligado, com número de quatro dígitos, e ficaria
//    ligado para sempre. Papel de parede não é alerta; é ruído que ensina o
//    lojista a ignorar o mascote. O número continua a UMA PERGUNTA de distância,
//    no `diagnostico_operacional`.
//
// ⛔ FICOU DE FORA — PEÇAS SEM ANÚNCIO / SEM LOCALIZAÇÃO / ANÚNCIOS PAUSADOS.
//    97,5% do catálogo da maior loja não tem anúncio, e isso é ESCOLHA
//    COMERCIAL, não defeito. Alertar sobre isso seria transformar a operação
//    normal do cliente em acusação.
//
// ⛔ FICOU DE FORA — CICLOS DE SINCRONIZAÇÃO COM FALHA. São transientes e o
//    sistema já tenta de novo sozinho.
//
// ⛔ FICOU DE FORA — CONTAS `INACTIVE`. É o modo férias
//    (marketplace-account.service.ts:111-123), ligado de propósito. Alertar
//    sobre uma decisão do próprio lojista é o oposto de ajudar.
//
// ⚠️ ISTO NÃO É UMA TOOL e não passa pelo modelo. É uma rota de leitura direta,
// e por isso a permissão é conferida AQUI, campo a campo: um badge que diz "você
// tem 61 problemas" para quem não pode abrir a tela de Pedidos já vazou o
// número. Esconder no cliente nunca foi permissão.

import { Platform } from "@prisma/client";

import prisma from "../../lib/prisma";
import type { PageId } from "../../lib/page-access";
import type { AiScope } from "../core/scope";

/**
 * A página que manda em cada canal.
 *
 * `Record<Platform, PageId>` de propósito: acrescentar um canal ao enum sem
 * decidir a página dele PARA DE COMPILAR, em vez de silenciosamente contar a
 * conta nova para todo mundo.
 */
const PAGINA_DO_CANAL: Record<Platform, PageId> = {
  [Platform.MERCADO_LIVRE]: "mercado-livre",
  [Platform.SHOPEE]: "shopee",
  [Platform.MAGALU]: "magalu",
  [Platform.OLX]: "olx",
  [Platform.FACEBOOK]: "facebook",
};

export interface AiAlertas {
  /**
   * Vendas que não viraram pedido — e cujo estoque, portanto, não baixou.
   * `null` quando o ator não tem acesso à página de Pedidos.
   */
  pedidosTravados: number | null;
  /**
   * Contas de marketplace com a autorização caída, contadas só nos canais que
   * este ator pode ver. `null` quando ele não vê canal nenhum.
   */
  contasCaidas: number | null;
}

/**
 * Espelha o filtro de `order.routes.ts:394-400`, o mesmo que
 * `diagnostico_operacional` usa (`tools/read/diagnostico.ts:96-99`).
 *
 * ⚠️ Se aquele filtro mudar, este precisa mudar junto — o badge e a resposta do
 * chat não podem discordar sobre quantos problemas existem. É o mesmo acordo
 * que o diagnóstico já tem com a rota de Pedidos.
 */
function filtroDePendencias(userId: string) {
  return {
    status: { in: ["OPEN", "NEEDS_ACTION"] },
    marketplaceAccount: { userId },
  };
}

/**
 * Os números do badge. NUNCA lança: alerta é enfeite operacional, e uma consulta
 * que estoura não pode derrubar o mascote de ninguém — devolve zero e o lojista
 * segue trabalhando.
 */
export async function contarAlertas(scope: AiScope): Promise<AiAlertas> {
  const userId = scope.dataOwnerId;

  const canaisVisiveis = (
    Object.keys(PAGINA_DO_CANAL) as Platform[]
  ).filter((p) => scope.can(PAGINA_DO_CANAL[p]));

  const [pedidosTravados, contasCaidas] = await Promise.all([
    scope.can("pedidos")
      ? (prisma as any).orderIngestionIssue
          .count({ where: filtroDePendencias(userId) })
          .catch(() => 0)
      : Promise.resolve(null),
    canaisVisiveis.length
      ? prisma.marketplaceAccount
          .count({
            where: {
              userId,
              status: "ERROR",
              platform: { in: canaisVisiveis },
            },
          })
          .catch(() => 0)
      : Promise.resolve(null),
  ]);

  return { pedidosTravados, contasCaidas };
}
