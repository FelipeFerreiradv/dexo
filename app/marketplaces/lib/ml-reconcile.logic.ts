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

export interface RemoteItemLite {
  id: string;
  status: string | null;
  dateCreated: string | null;
  title?: string | null;
  permalink?: string | null;
}

/**
 * Folga para relógios e para o POST que sai antes de o placeholder ser
 * gravado (o placeholder nasce antes da chamada, mas não por muito).
 */
export const RECONCILE_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * O item remoto que muito provavelmente é o criado pela tentativa perdida:
 * criado a partir do placeholder (com folga), o mais recente. Itens mais
 * antigos são outros anúncios da mesma peça (republicação legítima, anúncio
 * encerrado) e NÃO são adotados.
 */
export function pickReconciledItem(
  items: RemoteItemLite[],
  placeholderCreatedAt: Date,
  toleranceMs: number = RECONCILE_TOLERANCE_MS,
): RemoteItemLite | null {
  const limite = placeholderCreatedAt.getTime() - toleranceMs;
  const candidatos = items
    .map((it) => ({ it, t: it.dateCreated ? Date.parse(it.dateCreated) : NaN }))
    .filter(({ t }) => Number.isFinite(t) && t >= limite)
    .sort((a, b) => b.t - a.t);
  return candidatos[0]?.it ?? null;
}
