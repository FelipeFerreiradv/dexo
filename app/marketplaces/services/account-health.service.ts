// Saúde das contas de marketplace do tenant, para o AVISO na tela.
//
// POR QUE EXISTE
// Conta em ERROR ou desconectada some das listas da aplicação (as rotas
// /<plataforma>/accounts só devolvem ACTIVE), e a tela de integração cai em
// "não conectado" ou simplesmente omite a conta. Em 16/09/2026 oito contas
// Shopee ficaram ~11 h sem importar pedido e ninguém viu. Em 17/09, nos
// tenants ativos, havia 3 contas paradas e 5 desconectadas com anúncio à venda
// (até 2.096 anúncios numa só).
//
// O QUE CONTA COMO PROBLEMA
// - "parada": status ERROR com credencial gravada. A Dexo não importa pedido
//   dela (laço, webhook e vigília exigem ACTIVE). Sempre aparece.
// - "desconectada": INACTIVE, ou ERROR sem credencial. Pode ter sido decisão do
//   lojista, então só aparece se ainda houver anúncio À VENDA (ativo e com
//   estoque disponível) — é o que continua vendendo sem controle.
//
// "SEM BAIXA AUTOMÁTICA" SÓ QUANDO É VERDADE
// A baixa de estoque não filtra o status da conta: conta ERROR com token ainda
// VÁLIDO continua recebendo a quantidade (medido: 71 atualizações com sucesso
// nas contas Shopee em ERROR na noite de 16/09). `semBaixa` só é verdadeiro
// quando não há token ou ele já venceu.
//
// O "desde" é o ÚLTIMO PEDIDO IMPORTADO, nunca `updatedAt`: renovação de token
// e qualquer escrita na conta mexem nele.
//
// Nunca lê token (só o compara com vazio e a validade com agora, dentro do
// SQL), nunca renova, nunca chama a API do marketplace.
// Kill-switch: ACCOUNT_HEALTH_ALERTS_DISABLED=1.

import prisma from "../../lib/prisma";

export type AccountHealthKind = "parada" | "desconectada";

export interface AccountHealthStatusRow {
  id: string;
  status: string;
  temToken: boolean;
  tokenVencido: boolean;
}

export interface AccountHealthRow extends AccountHealthStatusRow {
  platform: string;
  accountName: string | null;
  ultimoPedidoEm: Date | string | null;
  anunciosAVenda: number | bigint | null;
}

export interface AccountHealthProblem {
  id: string;
  platform: string;
  accountName: string | null;
  tipo: AccountHealthKind;
  ultimoPedidoEm: string | null;
  anunciosAVenda: number;
  /** Os anúncios contados estão de fato sem baixa automática de estoque. */
  semBaixa: boolean;
}

/**
 * Decide o que vira aviso. Pura de propósito: a regra que decide o que o
 * lojista lê não pode depender de teste que reimplementa a consulta.
 */
export function classifyAccountHealth(
  rows: AccountHealthRow[],
): AccountHealthProblem[] {
  const out: AccountHealthProblem[] = [];
  for (const r of rows) {
    const anuncios = Number(r.anunciosAVenda ?? 0) || 0;
    let tipo: AccountHealthKind | null = null;
    if (r.status === "ERROR" && r.temToken) {
      tipo = "parada";
    } else if (r.status === "ERROR" || r.status === "INACTIVE") {
      tipo = anuncios > 0 ? "desconectada" : null;
    }
    if (!tipo) continue;
    out.push({
      id: r.id,
      platform: r.platform,
      accountName: r.accountName,
      tipo,
      ultimoPedidoEm: r.ultimoPedidoEm
        ? new Date(r.ultimoPedidoEm).toISOString()
        : null,
      anunciosAVenda: anuncios,
      semBaixa: !r.temToken || Boolean(r.tokenVencido),
    });
  }
  // Parada primeiro (é a que o lojista não decidiu); depois quem expõe mais.
  return out.sort((a, b) => {
    if (a.tipo !== b.tipo) return a.tipo === "parada" ? -1 : 1;
    return b.anunciosAVenda - a.anunciosAVenda;
  });
}

/** Mesma conta, mesmo estado ⇒ mesma assinatura. */
export function statusSignature(rows: AccountHealthStatusRow[]): string {
  return rows
    .map((r) => `${r.id}:${r.status}:${r.temToken ? 1 : 0}:${r.tokenVencido ? 1 : 0}`)
    .sort()
    .join("|");
}

/**
 * Cache curto por tenant, SÓ da parte cara (contar anúncios à venda cruza
 * anúncio e produto: até 0,3 s num tenant ativo, 0,7 s a frio num inativo).
 *
 * O estado das contas é relido SEMPRE, numa leitura de ~1 ms na tabela de
 * contas: se alguma conta mudou de status (o lojista acabou de reconectar), a
 * assinatura muda e o cache é ignorado. Sem isto o aviso dizia "parou de
 * receber pedidos" ao lado do card "conectado" por até 2 min — justamente no
 * fluxo que ele incentiva.
 */
const CACHE_TTL_MS = 2 * 60 * 1000;
const cache = new Map<
  string,
  {
    expiresAt: number;
    signature: string;
    value: Promise<AccountHealthProblem[]>;
  }
>();

export const AccountHealthService = {
  async getForOwner(ownerId: string): Promise<AccountHealthProblem[]> {
    if (process.env.ACCOUNT_HEALTH_ALERTS_DISABLED === "1") return [];
    if (!ownerId) return [];

    const estado = await AccountHealthService.queryStatus(ownerId);
    if (estado.length === 0) {
      cache.delete(ownerId);
      return [];
    }
    const signature = statusSignature(estado);

    const agora = Date.now();
    const hit = cache.get(ownerId);
    if (hit && hit.expiresAt > agora && hit.signature === signature) {
      return hit.value;
    }

    const value = AccountHealthService.query(ownerId).then(
      classifyAccountHealth,
    );
    cache.set(ownerId, { expiresAt: agora + CACHE_TTL_MS, signature, value });
    // Falha não fica em cache: a próxima pergunta tenta de novo.
    value.catch(() => cache.delete(ownerId));
    return value;
  },

  /**
   * Leitura LEVE, sempre feita: só a tabela de contas (~100 linhas), sem
   * subconsulta. No caso comum (nenhuma conta com problema) é tudo o que roda.
   */
  async queryStatus(ownerId: string): Promise<AccountHealthStatusRow[]> {
    return (prisma as any).$queryRaw`
      SELECT ma.id,
             ma.status::text AS status,
             (COALESCE(ma."accessToken", '') <> '') AS "temToken",
             (ma."expiresAt" < now()) AS "tokenVencido"
        FROM "MarketplaceAccount" ma
        JOIN "User" u ON u.id = ma."userId"
       WHERE (u.id = ${ownerId} OR u."parentUserId" = ${ownerId})
         AND ma.status::text IN ('ERROR', 'INACTIVE')
    `;
  },

  /**
   * UMA statement. Contas do dono E dos colaboradores (há conta de marketplace
   * conectada por colaborador em produção). As duas subconsultas só rodam para
   * as poucas contas que já passaram no filtro de status.
   */
  async query(ownerId: string): Promise<AccountHealthRow[]> {
    return (prisma as any).$queryRaw`
      SELECT ma.id,
             ma.platform::text AS platform,
             ma."accountName",
             ma.status::text AS status,
             (COALESCE(ma."accessToken", '') <> '') AS "temToken",
             (ma."expiresAt" < now()) AS "tokenVencido",
             (SELECT max(o."createdAt") FROM "Order" o
               WHERE o."marketplaceAccountId" = ma.id) AS "ultimoPedidoEm",
             (SELECT count(*)::int
                FROM "ProductListing" pl
                JOIN "Product" p ON p.id = pl."productId"
               WHERE pl."marketplaceAccountId" = ma.id
                 AND pl.status = 'active'
                 AND pl."externalListingId" NOT LIKE 'PENDING\\_%'
                 AND (p.stock - p."reservedStock") > 0) AS "anunciosAVenda"
        FROM "MarketplaceAccount" ma
        JOIN "User" u ON u.id = ma."userId"
       WHERE (u.id = ${ownerId} OR u."parentUserId" = ${ownerId})
         AND ma.status::text IN ('ERROR', 'INACTIVE')
    `;
  },

  /** Só para testes. */
  __clearCache() {
    cache.clear();
  },
};
