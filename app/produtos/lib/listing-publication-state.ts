import { splitListingErrorMarkers } from "./listing-error-format";

/**
 * Estado de PUBLICAÇÃO de um anúncio, derivado do que o banco já guarda —
 * sem novo status no banco (workers, filtros e sync continuam lendo os mesmos
 * valores de sempre).
 *
 * Antes a tela resumia situações diferentes em "Aguardando publicação" +
 * badge "Erro": dado a corrigir, falha passageira com nova tentativa marcada,
 * conta a reconectar e publicação que morreu no meio eram indistinguíveis.
 *
 * Regra de ouro: anúncio com id REAL e status vivo é "publicado", qualquer
 * que seja o texto em `lastError` (uma republicação revertida pode deixar
 * marcador velho na linha — o anúncio continua no ar).
 */
export type PublicationState =
  | "published"
  | "needs_fix"
  | "retry_scheduled"
  | "auth_required"
  | "interrupted"
  | "publishing"
  | "failed"
  | "sync_error"
  | "other";

export interface PublicationStateInput {
  status?: string | null;
  externalListingId?: string | null;
  lastError?: string | null;
  retryEnabled?: boolean | null;
  nextRetryAt?: string | Date | null;
  updatedAt?: string | Date | null;
}

export interface PublicationStateView {
  state: PublicationState;
  /** Frase curta para o lugar do "Aguardando publicação". */
  label: string;
  /** O card oferece "Corrigir produto" / "Tentar publicar novamente". */
  canRetry: boolean;
}

/** Placeholder `pending` parado por mais que isto sem retry = morreu no meio. */
export const INTERRUPTED_AFTER_MS = 30 * 60 * 1000;

const LIVE_STATUSES = new Set([
  "active",
  "paused",
  "under_review",
  "reviewing",
  "inactive",
  "unlist",
]);

function toDate(v: string | Date | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function derivePublicationState(
  listing: PublicationStateInput,
  now: Date = new Date(),
): PublicationStateView {
  const externalId = (listing.externalListingId ?? "").trim();
  const isPlaceholder = !externalId || externalId.startsWith("PENDING_");
  const status = (listing.status ?? "").toLowerCase();
  const { markers } = listing.lastError
    ? splitListingErrorMarkers(listing.lastError.trim())
    : { markers: [] as string[] };
  const text = listing.lastError ?? "";

  if (!isPlaceholder) {
    if (LIVE_STATUSES.has(status) && listing.lastError) {
      return {
        state: "sync_error",
        label: "Anúncio no ar — a última sincronização falhou",
        canRetry: false,
      };
    }
    return { state: "published", label: externalId, canRetry: false };
  }

  if (
    markers.includes("RECONECTAR") ||
    /PolicyAgent|Reconecte a conta|reconecte a conta/.test(text)
  ) {
    return {
      state: "auth_required",
      label: "Conta precisa ser reconectada",
      canRetry: true,
    };
  }

  if (markers.includes("TERMINAL")) {
    return {
      state: "needs_fix",
      label: "Não publicado — precisa de correção",
      canRetry: true,
    };
  }

  if (listing.retryEnabled && toDate(listing.nextRetryAt)) {
    return {
      state: "retry_scheduled",
      label: "Nova tentativa agendada",
      canRetry: false,
    };
  }

  if (status === "error") {
    return {
      state: "failed",
      label: "Não publicado — tentativas esgotadas",
      canRetry: true,
    };
  }

  if (status === "pending") {
    const updated = toDate(listing.updatedAt);
    if (
      !listing.retryEnabled &&
      updated &&
      now.getTime() - updated.getTime() > INTERRUPTED_AFTER_MS
    ) {
      return {
        state: "interrupted",
        label: "Publicação interrompida",
        canRetry: true,
      };
    }
    return {
      state: "publishing",
      label: "Aguardando publicação",
      canRetry: false,
    };
  }

  return { state: "other", label: "Aguardando publicação", canRetry: false };
}
