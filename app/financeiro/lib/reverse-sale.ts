import { getApiBaseUrl } from "@/lib/api";

/**
 * Bloco E — cancela (estorna) uma venda de balcão.
 *
 * Chama `POST /finance/receivables/:id/reverse`, que JÁ EXISTIA, já é atômico
 * e já é testado — e que até agora não tinha nenhum botão na interface. O
 * backend devolve o estoque, reabre os anúncios que voltaram a ter peça e
 * reconcilia o status da sucata.
 *
 * O que este helper NÃO faz: cancelar nota fiscal. Cancelar a venda no Dexo e
 * cancelar a NFC-e/NF-e são fluxos desacoplados — o cancelamento fiscal tem
 * prazo de 24h e exige justificativa (nfe-cancelamento.usecase.ts:70-78). Quem
 * chama aqui avisa o operador; disparar cancelamento fiscal automático seria
 * decisão nossa sobre um documento legal, e não é.
 */
export class ReverseForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReverseForbiddenError";
  }
}

export async function reverseSale(id: string, email: string): Promise<void> {
  // Sem Content-Type: o POST não tem body, e declarar JSON vazio derruba a
  // requisição no parse do Fastify (FST_ERR_CTP_EMPTY_JSON_BODY) — mesmo
  // contrato do POST /pay e do POST /nfce.
  const res = await fetch(
    `${getApiBaseUrl()}/finance/receivables/${id}/reverse`,
    { method: "POST", headers: { email } },
  );
  if (res.ok) return;

  const data = await res.json().catch(() => ({}) as any);
  const message =
    data?.error ?? data?.message ?? "Não foi possível cancelar a venda";

  // 403 do guard de ação: mensagem própria, para o operador saber que é
  // permissão e não erro de sistema.
  if (res.status === 403) {
    throw new ReverseForbiddenError(message);
  }
  throw new Error(message);
}
