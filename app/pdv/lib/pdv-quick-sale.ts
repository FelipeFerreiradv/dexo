// BLOCO I — vender direto do card do produto.
//
// O card do catálogo ganha um carrinho que leva ao PDV com a peça JÁ NO
// CARRINHO (opção 1 da decisão de produto). O caminho é uma URL:
//
//     /produtos  --clique-->  /pdv?item=<productId>  --> modal aberto e cheio
//
// POR QUE SÓ O ID VIAJA NA URL, e não preço/nome/estoque:
//  - o card pode estar na tela há vários minutos, e vender pelo preço de uma
//    lista velha é o tipo de erro que ninguém percebe até o fechamento;
//  - preço e estoque em query string ficam no histórico do navegador e em log
//    de proxy — dado de negócio não tem por que passear por ali;
//  - com o id, o PDV busca o estado ATUAL e o carrinho reflete o catálogo.
//
// O custo é 1 request a mais, disparado só quando o operador clica no
// carrinho. Uso `GET /products/:id` (o mesmo da ficha do produto): a resposta
// é mais gorda que o necessário, mas é EXATA. A alternativa era mandar o SKU e
// reusar o lookup textual do picker — mais leve, porém com risco de casar o
// produto errado, que num PDV é inaceitável.

import { getApiBaseUrl } from "@/lib/api";

// Referências literais a process.env.NEXT_PUBLIC_* para o Next inlinar
// (convenção de pdv-actions.ts:15-19).
const QUICK_SALE_ENABLED =
  process.env.NEXT_PUBLIC_PDV_QUICK_SALE_ENABLED === "true";
const PDV_ENABLED = process.env.NEXT_PUBLIC_PDV_ENABLED === "true";

/**
 * Carrinho visível no card?
 *
 * Exige AS DUAS flags. Não é redundância: com `NEXT_PUBLIC_PDV_ENABLED`
 * desligada a página `/pdv` responde `notFound()` (pdv/page.tsx:28), então o
 * botão levaria o operador a um 404. Um botão que dá 404 é pior que botão
 * nenhum.
 */
export function isQuickSaleEnabled(): boolean {
  return QUICK_SALE_ENABLED && PDV_ENABLED;
}

/** Nome do parâmetro. Um só lugar para não divergir entre quem escreve e quem lê. */
export const QUICK_SALE_PARAM = "item";

export function quickSaleHref(productId: string): string {
  return `/pdv?${QUICK_SALE_PARAM}=${encodeURIComponent(productId)}`;
}

/**
 * Fronteira de tipo da URL: qualquer pessoa pode digitar `?item=` com qualquer
 * coisa. O valor vira parte de uma URL de API, então aqui ele é validado por
 * FORMATO — não por existência, que é o backend quem decide (e responde 404).
 *
 * Aceita só o alfabeto de um id (cuid e afins) e limita o tamanho. Barra em
 * particular `../`, `?`, `&` e `#`, que sairiam da rota pretendida.
 */
export function parseQuickSaleParam(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const limpo = value.trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(limpo)) return null;
  return limpo;
}

/** O mínimo que o carrinho precisa saber sobre a peça. */
export interface QuickSaleProduct {
  id: string;
  sku: string;
  name: string;
  price: number;
  stock: number;
  /** Sucata de origem — o que mantém a venda ligada ao lote. */
  scrapId?: string | null;
}

/**
 * Monta o `initialData` do FinanceDialog a partir da peça.
 *
 * PURA e testada porque é onde mora a armadilha: a forma do item tem de ser a
 * MESMA que o `ProductPickerBlock.handlePick` monta (product-picker-block.ts:
 * 202-227). Qualquer campo fora do lugar aqui vira uma venda que salva errado
 * — e `scrapId` fora do lugar vira uma venda que NÃO desconta do lote, que é
 * exatamente o defeito que este projeto passou a semana consertando.
 *
 * `totalAmount` vai junto porque o pré-preenchimento do total é feito pelo
 * `handlePick` (que aqui não roda). Sem isto a venda abriria com total zero.
 */
export function buildQuickSaleSeed(p: QuickSaleProduct) {
  const preco = Number(p.price) || 0;
  return {
    items: [
      {
        productId: p.id,
        description: null,
        // Mesma prioridade do picker: a sucata de ORIGEM do produto. Aqui não
        // existe "default da venda" (o cabeçalho ainda nem foi preenchido).
        scrapId: p.scrapId ?? null,
        listingId: null,
        quantity: 1,
        unitPrice: preco,
        // Alimenta o seed do productMeta no dialog (SKU/nome/estoque). Sem
        // `stock`, o bloco de itens mostraria "0 em estoque" para uma peça que
        // o operador acabou de ver disponível no catálogo.
        product: { id: p.id, sku: p.sku, name: p.name, stock: p.stock },
      },
    ],
    totalAmount: preco,
  };
}

/**
 * Busca a peça para o carrinho. Devolve `null` quando não existe mais (404) —
 * quem chama avisa o operador em vez de abrir um modal vazio e silencioso.
 */
export async function fetchQuickSaleProduct(
  productId: string,
  email: string,
  signal?: AbortSignal,
): Promise<QuickSaleProduct | null> {
  const res = await fetch(`${getApiBaseUrl()}/products/${productId}`, {
    headers: { email },
    signal,
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Erro ao carregar a peça");
  const data = await res.json();
  // `GET /products/:id` devolve um envelope { product, productLocation, ... }.
  const p = data?.product ?? data;
  if (!p?.id) return null;
  return {
    id: p.id,
    sku: p.sku ?? "",
    name: p.name ?? "",
    price: Number(p.price) || 0,
    stock: Number(p.stock) || 0,
    scrapId: p.scrapId ?? null,
  };
}
