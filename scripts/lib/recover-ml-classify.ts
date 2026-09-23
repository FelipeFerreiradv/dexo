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
  | "em_andamento"
  | "agendado"
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
  /**
   * A linha já está com outro agente: `publishing` = publicação em curso
   * (pending recente, ou reservada pelo botão "Tentar publicar novamente");
   * `scheduled` = o cron já vai tentar. Nenhum dos dois pode ser tocado —
   * re-armar ou marcar por cima duplicaria o anúncio.
   */
  inFlight?: "publishing" | "scheduled" | null;
  /** Anúncio vivo local (id real) no mesmo par produto/conta. */
  liveLocal: { externalListingId: string; status: string } | null;
  /**
   * Conferência no ML por seller_sku. `skipped` = sem SKU/vendedor (não dá
   * para conferir); `not_checked` = token vencido no dry-run (não renova).
   */
  remote:
    | {
        status: "ok";
        adoptable: RemoteItemLite | null;
        others: RemoteItemLite[];
        /** Mesmo SKU, criado na janela, título diferente (ver decideReconcile). */
        ambiguous?: RemoteItemLite | null;
      }
    | { status: "search_failed" | "not_checked" | "skipped" };
  /** Pré-validação atual do produto (mesmo motor do create). */
  preflight: { blocked: boolean; message: string | null } | null;
  lastError: string | null;
  /**
   * `Product.updatedAt` é mais novo que o erro? NÃO prova edição da pessoa:
   * baixa de estoque, sync de preço e troca de foto também movem o
   * `updatedAt`. Por isso só muda o TEXTO do motivo, nunca a classe
   * (revisão de 23/09/2026: usado como prova, uma venda fazia a recusa por
   * INMETRO/medida/foto virar "publicável" sem ninguém ter corrigido).
   */
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
  if (i.inFlight === "publishing") {
    return {
      classe: "em_andamento",
      motivo: "Publicação em andamento agora — não mexer.",
    };
  }
  if (i.inFlight === "scheduled") {
    return {
      classe: "agendado",
      motivo: "A Dexo já tem uma nova tentativa agendada para esta linha.",
    };
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
  if (i.remote.status === "ok" && i.remote.ambiguous) {
    const a = i.remote.ambiguous;
    return {
      classe: "duplicidade_possivel",
      motivo: `Há um anúncio com o mesmo SKU criado depois deste pendente, com outro título: ${a.id} "${(a.title ?? "").slice(0, 60)}". Conferir antes de publicar.`,
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
  if (RECUSA_DE_DADO_INVISIVEL.some((r) => r.test(erro))) {
    const texto = erro.replace(/^(\[[A-Z]+\])+\s*/, "").slice(0, 300);
    return {
      classe: "precisa_cliente",
      motivo: i.editedAfterError
        ? `${texto} (O produto mudou depois desta recusa; se o dado já foi corrigido, basta clicar em "Tentar publicar novamente".)`.slice(0, 460)
        : texto,
    };
  }
  return {
    classe: "publicavel",
    motivo: "Pré-validação sem bloqueio; o último erro não aponta dado a corrigir.",
  };
}
