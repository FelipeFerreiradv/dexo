// BLOCO J — trocar (ou remover) a sucata de uma peça já cadastrada.
//
// O QUE ESTAVA FALTANDO: `ProductUseCase.linkScrap` já existia e já fazia a
// coisa certa (vai direto ao repositório, não dispara sync de anúncio nem
// StockLog, valida a posse da sucata). Só que NUNCA teve rota HTTP — só a
// importação de legado o alcançava, pelo irmão em lote. Errou o lote no
// cadastro? Não havia conserto pela interface.
//
// ⚠️ O QUE O OPERADOR PRECISA SABER ANTES DE CONFIRMAR
// Os contadores da sucata (peças, vendidas, dinheiro) são DERIVADOS de
// `Product.scrapId` — não são valores guardados. Mover a peça REATRIBUI o que
// ela já vendeu:
//
//   venda de MARKETPLACE  → segue a peça. `OrderItem` não tem coluna de
//                           sucata, então não há snapshot para segurá-la.
//   venda de BALCÃO       → fica onde estava, quando a linha gravou a sucata
//                           no momento da venda (`ReceivableItem.scrapId`, que
//                           o PDV preenche a partir da peça). Sem isso, segue.
//
// Nada é apagado: a venda continua a mesma, com o mesmo valor e a mesma data.
// Muda a qual lote ela é atribuída. Medido em produção (14/08): 115 de 16.697
// peças com sucata têm alguma venda — 0,7%.
//
// Módulo PURO (sem I/O): serve ao backend e ao bundle, como `payment-methods`.

/**
 * Flag de BACKEND. Ausente ⇒ a rota recusa. É kill-switch de verdade: a troca
 * de vínculo mexe em contadores de DOIS lotes, e poder desligá-la sem
 * redeploy vale mais do que a economia de uma linha.
 */
export function isScrapRelinkEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.PRODUCT_SCRAP_RELINK_ENABLED === "1";
}

// Referência literal a process.env.NEXT_PUBLIC_* para o Next inlinar.
const SCRAP_RELINK_UI_ENABLED =
  process.env.NEXT_PUBLIC_PRODUCT_SCRAP_RELINK_ENABLED === "true";

/** Seletor de sucata visível no modal de edição? Exige `npm run build`. */
export function isScrapRelinkUiEnabled(): boolean {
  return SCRAP_RELINK_UI_ENABLED;
}

export interface ScrapLinkImpact {
  /** Vendas de marketplace da peça (PAID/SHIPPED/DELIVERED). Vão JUNTO. */
  marketplaceSales: number;
  /** Vendas de balcão PAGAS da peça, no total. */
  counterSales: number;
  /** Quantas dessas de balcão gravaram a sucata e portanto FICAM. */
  pinnedCounterSales: number;
}

/**
 * As frases do aviso de confirmação, em ordem de gravidade.
 *
 * PURA porque é o texto que sustenta um consentimento informado: se ele mentir
 * ou omitir, o operador confirma uma coisa e acontece outra. Devolve `[]`
 * quando não há venda nenhuma — e aí a troca é trivial e o diálogo não precisa
 * assustar ninguém (é o caso de 99,3% das peças).
 */
export function describeRelinkImpact(i: ScrapLinkImpact): string[] {
  const linhas: string[] = [];
  const mkt = Math.max(0, i.marketplaceSales | 0);
  const balcao = Math.max(0, i.counterSales | 0);
  const presas = Math.min(Math.max(0, i.pinnedCounterSales | 0), balcao);
  const soltas = balcao - presas;

  if (mkt > 0) {
    linhas.push(
      `${mkt} ${plural(mkt, "venda", "vendas")} de marketplace ${plural(mkt, "passa", "passam")} a contar na nova sucata.`,
    );
  }
  if (soltas > 0) {
    linhas.push(
      `${soltas} ${plural(soltas, "venda", "vendas")} de balcão ${plural(soltas, "passa", "passam")} a contar na nova sucata.`,
    );
  }
  if (presas > 0) {
    linhas.push(
      `${presas} ${plural(presas, "venda", "vendas")} de balcão ${plural(presas, "continua", "continuam")} na sucata atual — ${plural(presas, "ela gravou", "elas gravaram")} o lote no momento da venda.`,
    );
  }
  return linhas;
}

function plural(n: number, um: string, muitos: string): string {
  return n === 1 ? um : muitos;
}

/**
 * Sentinela do seletor para "sem sucata".
 *
 * Radix Select não aceita `value=""`, e `null` não é string. Um só lugar para
 * a sentinela evita que a tela mande a palavra literal ao backend.
 */
export const NO_SCRAP = "__none__";

/** Valor do seletor → o que vai no corpo do PATCH. */
export function scrapSelectValueToId(value: string): string | null {
  return value === NO_SCRAP || !value ? null : value;
}
