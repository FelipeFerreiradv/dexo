// BLOCO C — filtro por status da venda.
//
// O cliente pediu rótulos que NÃO são os 4 valores de `FinanceStatus`:
// "Aberta", "Recebida", "Parcelada", "Faturada", "Cancelada". Três deles são
// DERIVADOS, e um (Vencida) já é derivado hoje só para exibição.
//
// Este módulo é a fonte única do vocabulário e da tradução para o `where`,
// pela mesma razão de `payment-methods.ts`: a regra tem de ser idêntica no
// rótulo da tela e na consulta, senão o filtro contradiz o badge da linha.
//
// POR QUE "VENCIDA" É ESPECIAL: nada grava `VENCIDA` no fluxo normal — o
// status é derivado em read-time por `applyOverdueFlag` (`PENDENTE` com
// vencimento no passado). Filtrar literalmente por `status = "VENCIDA"`
// devolveria quase nada, e filtrar por `PENDENTE` traria linhas que a própria
// tela pinta de vermelho como vencidas. A tradução abaixo casa com o badge.
// A importação de legado (`contas.mapper.ts`) É capaz de gravar `VENCIDA`
// literal, então o filtro cobre os dois casos.

import type { FinanceStatus } from "../interfaces/finance.interface";

export const SALE_STATUS_FILTERS = [
  { code: "ABERTA", label: "Aberta" },
  { code: "VENCIDA", label: "Vencida" },
  { code: "RECEBIDA", label: "Recebida" },
  { code: "PARCELADA", label: "Parcelada" },
  { code: "FATURADA", label: "Faturada" },
  { code: "CANCELADA", label: "Cancelada" },
] as const;

export type SaleStatusFilterCode = (typeof SALE_STATUS_FILTERS)[number]["code"];

export const SALE_STATUS_FILTER_CODES: SaleStatusFilterCode[] =
  SALE_STATUS_FILTERS.map((f) => f.code);

export function saleStatusFilterLabel(code: string): string {
  return SALE_STATUS_FILTERS.find((f) => f.code === code)?.label ?? code;
}

/**
 * Lê o parâmetro de query (lista separada por vírgula) e descarta o que não
 * reconhece. Entrada vazia/ausente/só-lixo devolve `[]` — e `[]` significa
 * "não filtrar", o que mantém a consulta byte-idêntica à de hoje.
 */
export function parseSaleStatusFilters(
  raw: string | string[] | undefined | null,
): SaleStatusFilterCode[] {
  if (raw == null) return [];
  const texto = Array.isArray(raw) ? raw.join(",") : raw;
  const vistos = new Set<SaleStatusFilterCode>();
  for (const parte of texto.split(",")) {
    const c = parte.trim().toUpperCase();
    if ((SALE_STATUS_FILTER_CODES as string[]).includes(c)) {
      vistos.add(c as SaleStatusFilterCode);
    }
  }
  return SALE_STATUS_FILTER_CODES.filter((c) => vistos.has(c));
}

/** "Faturada" precisa de uma pré-consulta; os demais são where puro. */
export function needsFiscalLookup(codes: SaleStatusFilterCode[]): boolean {
  return codes.includes("FATURADA");
}

export interface SaleStatusWhereOpts {
  /** Momento da avaliação de "vencida" — injetado para o teste ser determinístico. */
  now: Date;
  /**
   * Ids das contas com nota AUTORIZADA. Só é consultado quando "FATURADA" está
   * entre os códigos. Lista vazia ⇒ o ramo casa zero linhas, que é a resposta
   * correta para "nenhuma venda faturada".
   */
  faturadaIds?: string[];
}

/**
 * Traduz os códigos em fragmentos de `where` para serem OR-ados.
 *
 * Devolve `null` quando não há filtro — o chamador NÃO deve acrescentar chave
 * nenhuma ao `where` nesse caso, para a consulta seguir idêntica à de hoje.
 */
export function buildSaleStatusWhere(
  codes: SaleStatusFilterCode[],
  opts: SaleStatusWhereOpts,
): Record<string, unknown>[] | null {
  if (codes.length === 0) return null;
  const { now, faturadaIds = [] } = opts;
  const pendente: FinanceStatus = "PENDENTE";

  const fragmentos: Record<string, unknown>[] = [];
  for (const code of codes) {
    switch (code) {
      case "ABERTA":
        // Pendente e ainda no prazo. Sem o recorte de vencimento, "Aberta"
        // traria as vencidas — que a tela mostra em vermelho como VENCIDA.
        fragmentos.push({ status: pendente, dueDate: { gte: now } });
        break;
      case "VENCIDA":
        fragmentos.push({
          OR: [
            { status: pendente, dueDate: { lt: now } },
            // Legado: a importação grava o literal.
            { status: "VENCIDA" as FinanceStatus },
          ],
        });
        break;
      case "RECEBIDA":
        fragmentos.push({ status: "PAGA" as FinanceStatus });
        break;
      case "CANCELADA":
        fragmentos.push({ status: "CANCELADA" as FinanceStatus });
        break;
      case "PARCELADA":
        // Pega os DOIS lados do split: a conta-mãe (que tem filhas) e cada
        // parcela (que tem mãe). Ambos por `parentReceivableId`, que é
        // indexado — a mãe NÃO recebe `installmentTotal`, então esse campo não
        // serve de discriminador.
        fragmentos.push({
          OR: [
            { children: { some: {} } },
            { parentReceivableId: { not: null } },
          ],
        });
        break;
      case "FATURADA":
        fragmentos.push({ id: { in: faturadaIds } });
        break;
    }
  }
  return fragmentos;
}
