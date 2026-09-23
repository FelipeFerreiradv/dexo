/**
 * Reconciliação antes de recriar um anúncio (anti-duplicata).
 *
 * Uma tentativa que terminou em timeout ou 5xx pode ter criado o item no ML
 * sem a Dexo receber a resposta (`withTimeout` não aborta o POST). Recriar às
 * cegas publicaria DUAS vezes a mesma peça. Antes de recriar, o retry busca na
 * conta os anúncios com o SKU do produto e adota o que foi criado depois do
 * placeholder.
 *
 * Puro: quem chama faz a busca (MLApiService.findItemsBySellerSku) e decide o
 * que fazer com o resultado.
 */

import { compareMLTitles } from "./ml-title";

export interface RemoteItemLite {
  id: string;
  status: string | null;
  dateCreated: string | null;
  title?: string | null;
  permalink?: string | null;
  sellerCustomField?: string | null;
}

/**
 * Folga para relógios e para o POST que sai antes de o placeholder ser
 * gravado (o placeholder nasce antes da chamada, mas não por muito).
 */
export const RECONCILE_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Status que uma criação perdida NUNCA tem. Um item encerrado com o mesmo SKU
 * é o anúncio ANTIGO da peça — quando a linha do pendente é reaproveitada de
 * um anúncio encerrado, adotá-lo desfazia a republicação em silêncio.
 */
const NAO_ADOTAVEL = new Set(["closed", "deleted"]);

function candidatos(
  items: RemoteItemLite[],
  placeholderCreatedAt: Date,
  toleranceMs: number,
  sku?: string | null,
): RemoteItemLite[] {
  const limite = placeholderCreatedAt.getTime() - toleranceMs;
  const skuLimpo = (sku ?? "").trim();
  return items
    .filter((it) => !NAO_ADOTAVEL.has(String(it.status ?? "").toLowerCase()))
    .filter((it) => {
      // A busca por seller_sku também casa o atributo SELLER_SKU; se o campo
      // do vendedor existe e é OUTRO código, não é o item deste produto.
      const campo = (it.sellerCustomField ?? "").trim();
      return !skuLimpo || !campo || campo === skuLimpo;
    })
    .map((it) => ({ it, t: it.dateCreated ? Date.parse(it.dateCreated) : NaN }))
    .filter(({ t }) => Number.isFinite(t) && t >= limite)
    .sort((a, b) => b.t - a.t)
    .map(({ it }) => it);
}

/**
 * O item remoto que muito provavelmente é o criado pela tentativa perdida:
 * criado a partir do placeholder (com folga), não encerrado, o mais recente.
 * Itens mais antigos são outros anúncios da mesma peça (republicação
 * legítima, anúncio encerrado) e NÃO são adotados.
 */
export function pickReconciledItem(
  items: RemoteItemLite[],
  placeholderCreatedAt: Date,
  toleranceMs: number = RECONCILE_TOLERANCE_MS,
  sku?: string | null,
): RemoteItemLite | null {
  return candidatos(items, placeholderCreatedAt, toleranceMs, sku)[0] ?? null;
}

export type ReconcileDecision =
  | { kind: "adopt"; item: RemoteItemLite }
  | { kind: "ambiguous"; item: RemoteItemLite }
  | { kind: "none" };

/**
 * Decide o que fazer com o resultado da busca, conferindo também o TÍTULO:
 * SKU repetido entre produtos é comum (medido: um SKU em 7.328 anúncios), e
 * adotar o item de OUTRO produto vinculava o anúncio errado.
 *
 *  - adopt: item na janela, não encerrado, com título equivalente;
 *  - ambiguous: há item na janela com o SKU, mas título diferente — nem
 *    adotar (pode ser outro produto) nem recriar (pode ser este, com título
 *    alterado pelo ML): a pessoa confere;
 *  - none: nada na janela ⇒ pode criar.
 *
 * Sem título desejado (produto sem nome), decide só pelo SKU, como antes.
 */
export function decideReconcile(
  items: RemoteItemLite[],
  o: {
    placeholderCreatedAt: Date;
    sku?: string | null;
    desiredTitle?: string | null;
    toleranceMs?: number;
  },
): ReconcileDecision {
  const lista = candidatos(
    items,
    o.placeholderCreatedAt,
    o.toleranceMs ?? RECONCILE_TOLERANCE_MS,
    o.sku,
  );
  if (lista.length === 0) return { kind: "none" };
  const desejado = (o.desiredTitle ?? "").trim();
  if (!desejado) return { kind: "adopt", item: lista[0] };
  const mesmo = lista.find(
    (it) => compareMLTitles(desejado, it.title ?? "", 0).equivalent,
  );
  return mesmo
    ? { kind: "adopt", item: mesmo }
    : { kind: "ambiguous", item: lista[0] };
}
