/**
 * Grupo `card` (YA04a) das Formas de Pagamento — decisão ÚNICA e centralizada.
 *
 * ── O problema que este módulo resolve ─────────────────────────────────────
 * A SEFAZ rejeita com **391 — "Não informados os dados do cartão de crédito /
 * débito nas Formas de Pagamento da Nota Fiscal"** quando a nota declara um
 * meio de pagamento eletrônico SEM o grupo `<card>`. Desde a **NT 2025.001
 * (vigente 01/09/2025)** isso vale também para **PIX**, não só cartão.
 *
 * ── Por que a decisão é por CÓDIGO tPag, e não pelo rótulo do meio ─────────
 * A regra da SEFAZ é definida sobre os códigos da tabela tPag. Decidir pelo
 * código (e não por comparação de string do rótulo interno, id fixo ou
 * heurística de nome) elimina toda uma classe de bug: um meio novo cadastrado
 * amanhã cai automaticamente no lado certo da regra, porque o que manda é o
 * código que ele mapeia em MEIO_PAGAMENTO_COD.
 *
 * ── Escopo por modelo: evidência de produção, não suposição ────────────────
 * A exigência é aplicada à **NFC-e (65)**. Para NF-e (55) a mesma SEFAZ
 * autoriza sem o grupo — verificado em produção no MESMO emitente e MESMO
 * builder (GO/MESQUITA: 55 nº 2/100, 4/7 e 4/4 com PIX AUTORIZADAS; 65 nº 1/2
 * e 1/3 com PIX REJEITADAS 391), e também em SC (55 nº 1/521, cartão de
 * crédito, autorizada) e MG (55 nº 4/57 e 4/56, cartão, autorizadas).
 * Por isso o 55 segue EXATAMENTE como está: mexer num fluxo que a SEFAZ
 * aceita hoje seria risco sem evidência. Se algum dia a exigência se estender
 * ao 55, a mudança é UMA linha aqui — nenhum builder precisa ser tocado.
 */

/** Modelo do documento fiscal: 55 = NF-e, 65 = NFC-e. */
export type ModeloDocumento = "55" | "65";

/**
 * Códigos tPag que exigem o grupo `card`:
 *  03 = Cartão de Crédito · 04 = Cartão de Débito · 17 = Pagamento Instantâneo (PIX)
 */
export const TPAG_QUE_EXIGEM_CARD: ReadonlySet<string> = new Set([
  "03",
  "04",
  "17",
]);

/**
 * tpIntegra — integração do pagamento com o sistema de automação:
 *  1 = integrado (TEF / e-commerce) → exige CNPJ da credenciadora
 *  2 = NÃO integrado (POS próprio, maquininha avulsa, PIX por QR no celular)
 *
 * O Dexo é 2 por definição: o PDV apenas REGISTRA o meio escolhido pelo
 * operador; não há TEF nem captura de transação. Declarar 1 seria falso e
 * ainda exigiria CNPJ/bandeira/autorização que o sistema não possui.
 */
export const TP_INTEGRA_NAO_INTEGRADO = "2" as const;

/**
 * O grupo `card` deve ser emitido para este pagamento?
 *
 * @param tPagCod código tPag JÁ resolvido (ex.: "17"), como vai no XML
 * @param modelo  modelo do documento ("55" | "65")
 */
export function exigeGrupoCard(
  tPagCod: string | null | undefined,
  modelo: ModeloDocumento,
): boolean {
  // NF-e 55: autorizada em produção sem o grupo — não alteramos (ver cabeçalho).
  if (modelo !== "65") return false;
  return !!tPagCod && TPAG_QUE_EXIGEM_CARD.has(tPagCod);
}
