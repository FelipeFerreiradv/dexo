/**
 * Classificação pura de cada anúncio ML preso (placeholder PENDING_) para o
 * script de recuperação (scripts/recover-ml-failed-listings.ts).
 *
 * Separado do script porque o script chama `main()` no topo e não pode ser
 * importado por teste (mesmo padrão de ml-token-cache).
 *
 * Ordem das regras = ordem de risco: nada que possa DUPLICAR anúncio é
 * re-armado; o que a pessoa precisa corrigir nunca é re-armado às cegas.
 */

export type RecoverClass =
  | "conta_inativa"
  | "ja_publicado"
  | "adotar"
  | "duplicidade_possivel"
  | "nao_verificado"
  | "precisa_cliente"
  | "publicavel";

export interface RemoteItemLite {
  id: string;
  status?: string | null;
  title?: string | null;
  dateCreated?: string | null;
}

export interface RecoverInput {
  accountActive: boolean;
  /** Anúncio vivo local (id real) no mesmo par produto/conta. */
  liveLocal: { externalListingId: string; status: string } | null;
  /**
   * Conferência no ML por seller_sku. `skipped` = sem SKU/vendedor (não dá
   * para conferir); `not_checked` = token vencido no dry-run (não renova).
   */
  remote:
    | { status: "ok"; adoptable: RemoteItemLite | null; others: RemoteItemLite[] }
    | { status: "search_failed" | "not_checked" | "skipped" };
  /** Pré-validação atual do produto (mesmo motor do create). */
  preflight: { blocked: boolean; message: string | null } | null;
  lastError: string | null;
  /** Produto editado depois do último erro gravado na linha? */
  editedAfterError: boolean;
}

export interface RecoverDecision {
  classe: RecoverClass;
  motivo: string;
}

const VIVO = new Set(["active", "paused", "under_review"]);

/**
 * Recusas do ML que a pré-validação NÃO consegue enxergar (dependem do valor
 * digitado ou da foto) e que só a pessoa resolve. Formatos velhos e novos da
 * mensagem gravada.
 */
const RECUSA_DE_DADO_INVISIVEL: RegExp[] = [
  /INMETRO|invalid_sanitary_registry_value|\b3702\b/i,
  /\b5401\b|seller\.package\.dimensions|medidas? (da embalagem|do pacote)/i,
  /pictures?\.(invalid_size|unavailable)|\bfoto/i,
  /title\.minimum_length|\b3705\b/i,
  /invalid_sale_units|Unidades por kit|\b3709\b/i,
  /exige o campo/i,
  /^\[TERMINAL\]\[CORRIGIVEL\]/,
];

export function classifyRecoverRow(i: RecoverInput): RecoverDecision {
  if (!i.accountActive) {
    return { classe: "conta_inativa", motivo: "Conta do ML não está ativa." };
  }
  if (i.liveLocal) {
    return {
      classe: "ja_publicado",
      motivo: `Já existe anúncio ${i.liveLocal.status} nesta conta (${i.liveLocal.externalListingId}).`,
    };
  }
  if (i.remote.status === "ok" && i.remote.adoptable) {
    return {
      classe: "adotar",
      motivo: `O anúncio ${i.remote.adoptable.id} foi criado no ML depois deste pendente e não estava vinculado.`,
    };
  }
  if (i.remote.status === "ok") {
    const vivos = i.remote.others.filter((o) => VIVO.has(String(o.status ?? "")));
    if (vivos.length > 0) {
      return {
        classe: "duplicidade_possivel",
        motivo: `Já há anúncio com o mesmo SKU nesta conta do ML: ${vivos
          .slice(0, 3)
          .map((o) => `${o.id} (${o.status}) "${(o.title ?? "").slice(0, 60)}"`)
          .join("; ")}. Conferir antes de publicar.`,
      };
    }
  }
  if (i.remote.status === "search_failed" || i.remote.status === "not_checked") {
    return {
      classe: "nao_verificado",
      motivo:
        i.remote.status === "search_failed"
          ? "A busca por SKU no ML falhou — sem ela não dá para descartar duplicidade."
          : "Token vencido no dry-run (o script não renova token); rode de novo depois que o app renovar.",
    };
  }
  if (i.preflight?.blocked) {
    return {
      classe: "precisa_cliente",
      motivo: i.preflight.message ?? "A ficha técnica tem valores que o ML não aceita.",
    };
  }
  const erro = i.lastError ?? "";
  if (!i.editedAfterError && RECUSA_DE_DADO_INVISIVEL.some((r) => r.test(erro))) {
    return {
      classe: "precisa_cliente",
      motivo: erro.replace(/^(\[[A-Z]+\])+\s*/, "").slice(0, 300),
    };
  }
  return {
    classe: "publicavel",
    motivo: i.editedAfterError
      ? "Produto editado depois do último erro; pré-validação sem bloqueio."
      : "Pré-validação sem bloqueio; o último erro não aponta dado a corrigir.",
  };
}
