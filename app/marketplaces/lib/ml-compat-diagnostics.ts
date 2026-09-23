/**
 * Formato ÚNICO do `ProductListing.compatDiagnostics` — o que o read-back do
 * ML confirmou depois de enviar a compatibilidade veicular.
 *
 * Antes havia dois literais (criação do anúncio e reenvio na edição) que
 * divergiam em silêncio. As chaves antigas continuam idênticas; entram só:
 *  - `positions`: o eco da posição (lado/eixo). `echo:"dropped"` é o ML
 *    respondendo 200 e jogando a posição fora — antes isso só ia para o log.
 *  - `truncated`: pares marca/modelo cujo catálogo não foi lido inteiro (a
 *    busca parou antes do total que o ML informou). Sem isso, "ano não
 *    encontrado" e "não chegamos a ler" pareciam a mesma coisa.
 */

export interface CompatVerifiedLike {
  requested: number;
  persisted: number;
  strategy: string;
  verified: boolean;
  unresolved: Array<{
    brand: string;
    model: string;
    year?: number | null;
    reason: string;
  }>;
  unsupportedDomain?: string;
  truncated?: Array<{
    brand: string;
    model: string;
    fetched: number;
    total: number | null;
  }>;
  positions?: {
    requested: string[];
    sent: Array<{ value_name?: string | null }>;
    unresolved: string[];
    echo: "echoed" | "dropped" | "unknown";
  };
}

/**
 * Versão do formato. Diagnóstico SEM ela foi gravado antes da correção da
 * paginação (22/09/2026): a busca relia os mesmos 50 veículos, então tanto o
 * "não encontrado" quanto o total confirmado dele não são confiáveis.
 */
export const COMPAT_DIAGNOSTICS_VERSION = 2;

/**
 * O anúncio vale um reenvio de compatibilidade? Critério do backfill
 * `--only-unresolved` (que só percorre produtos COM compatibilidade
 * cadastrada):
 *  - `unsupportedDomain` ⇒ NÃO: o ML recusa compat na categoria, reenviar não
 *    muda nada;
 *  - sem diagnóstico ⇒ SIM: nunca foi confirmado (anúncio adotado pela
 *    reconciliação, ou criado antes do diagnóstico existir);
 *  - diagnóstico ANTERIOR à correção (sem `v`) ⇒ SIM, uma vez: a cobertura
 *    parcial do defeito ("50 de 757" com `unresolved=0`) não aparece em
 *    nenhum outro campo. Reenviado, ele ganha o formato novo e sai da lista;
 *  - veículo não resolvido, catálogo truncado, ou nada gravado ⇒ SIM.
 */
export function compatDiagnosticsNeedsResend(diag: unknown): boolean {
  if (!diag || typeof diag !== "object" || Array.isArray(diag)) return true;
  const d = diag as Record<string, unknown>;
  if (typeof d.unsupportedDomain === "string" && d.unsupportedDomain) {
    return false;
  }
  if (d.v !== COMPAT_DIAGNOSTICS_VERSION) return true;
  if (Array.isArray(d.truncated) && d.truncated.length > 0) return true;
  if (typeof d.unresolved === "number" && d.unresolved > 0) return true;
  return typeof d.persisted === "number" && d.persisted === 0;
}

export function buildCompatDiagnostics(
  compat: CompatVerifiedLike,
  extra: { origin?: string; now?: Date } = {},
): Record<string, unknown> {
  return {
    v: COMPAT_DIAGNOSTICS_VERSION,
    requested: compat.requested,
    persisted: compat.persisted,
    strategy: compat.strategy,
    verified: compat.verified,
    unresolved: compat.unresolved.length,
    unresolvedSample: compat.unresolved.slice(0, 5),
    unsupportedDomain: compat.unsupportedDomain,
    ...(extra.origin ? { origin: extra.origin } : {}),
    ...(compat.truncated && compat.truncated.length > 0
      ? { truncated: compat.truncated.slice(0, 5) }
      : {}),
    ...(compat.positions
      ? {
          positions: {
            requested: compat.positions.requested,
            sent: compat.positions.sent
              .map((v) => v?.value_name)
              .filter((v): v is string => typeof v === "string"),
            unresolved: compat.positions.unresolved,
            echo: compat.positions.echo,
          },
        }
      : {}),
    at: (extra.now ?? new Date()).toISOString(),
  };
}
