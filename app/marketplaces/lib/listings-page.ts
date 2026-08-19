/**
 * Teto e paginação das abas "Anúncios" dos cinco canais.
 *
 * POR QUE ISTO EXISTE
 * Os cinco `GET /marketplace/{canal}/listings` faziam `findMany` sem `take`.
 * Medido em produção em 19/08/2026, na maior conta de Mercado Livre (36.185
 * anúncios): a resposta era de **13 MB**. Abrir a aba puxava o vínculo inteiro
 * da conta para dentro do browser, e a Shopee tinha conta com 11.699.
 *
 * O banco nunca foi o gargalo — o plano resolvia em 72 ms por Index Scan. O
 * custo era materializar 36 mil objetos no Node, serializar e transmitir. Com
 * teto de 50, a mesma resposta cai para **18 kB** (−99,9%), e o `count` sai por
 * Index Only Scan em 10 ms, então dá para mostrar "página X de Y" sem pagar caro.
 *
 * Regra R7 das sete de egress: paginação com TETO e sinalização de truncamento.
 * Aqui a sinalização é o `pagination.total` — a tela diz quantos existem, não só
 * quantos vieram.
 *
 * CONTRATO: o mesmo de Pedidos, Orçamentos, Clientes e Localizações
 * (`page`/`limit` na query, `pagination: { page, limit, total, totalPages }` na
 * resposta), para o operador ver o mesmo rodapé em toda a aplicação.
 */

/** Quantos anúncios a aba mostra por vez quando ninguém pede outra coisa. */
export const LISTINGS_PAGE_SIZE_PADRAO = 50;

/**
 * Teto duro. Existe para que `?limit=999999` não recrie exatamente o problema
 * que esta paginação veio resolver — o limite não pode depender de boa vontade
 * de quem chama.
 */
export const LISTINGS_PAGE_SIZE_MAX = 200;

export interface ListingsPage {
  /** 1-based, como no resto da aplicação. */
  page: number;
  limit: number;
  /** Deslocamento pronto para o `skip` do Prisma. */
  skip: number;
}

/**
 * Converte `page`/`limit` da query em valores seguros.
 *
 * Tudo que chega aqui é texto de URL, então a função é deliberadamente paranoica:
 * ausente, vazio, negativo, zero, fracionário, `NaN`, `Infinity` ou array (o
 * Fastify entrega array quando o parâmetro vem repetido) caem no padrão em vez
 * de virar `skip: NaN` — que o Prisma aceitaria e devolveria página vazia, um
 * erro que aparece como "sumiram meus anúncios".
 */
export function resolveListingsPage(query: unknown): ListingsPage {
  const q = (query ?? {}) as Record<string, unknown>;

  const page = inteiroPositivo(q.page) ?? 1;
  const limitPedido = inteiroPositivo(q.limit);
  const limit = limitPedido
    ? Math.min(limitPedido, LISTINGS_PAGE_SIZE_MAX)
    : LISTINGS_PAGE_SIZE_PADRAO;

  return { page, limit, skip: (page - 1) * limit };
}

/** Total de páginas para um total de itens — nunca menor que 1 (lista vazia tem 1 página). */
export function totalDePaginas(total: number, limit: number): number {
  if (!Number.isFinite(total) || total <= 0) return 1;
  return Math.max(1, Math.ceil(total / limit));
}

function inteiroPositivo(valor: unknown): number | null {
  // Parâmetro repetido na URL (`?page=1&page=2`) chega como array.
  const bruto = Array.isArray(valor) ? valor[0] : valor;
  if (bruto === undefined || bruto === null || bruto === "") return null;

  const n = typeof bruto === "number" ? bruto : Number(String(bruto).trim());
  if (!Number.isFinite(n)) return null;

  const inteiro = Math.floor(n);
  return inteiro >= 1 ? inteiro : null;
}
