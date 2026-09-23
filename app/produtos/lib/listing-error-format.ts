import {
  describeMLCause,
  pickActionableMLError,
  type MLCause,
} from "@/app/marketplaces/services/ml-error-message.service";

/**
 * O que o card do anúncio mostra a partir de `ProductListing.lastError`.
 *
 * `lastError` é o canal do retry: pode começar com marcadores de máquina
 * (`[TERMINAL]`, `[CORRIGIVEL]`, `[RECONECTAR]`) e, nos anúncios antigos, pode
 * ser o JSON cru do ML (`Erro ao criar item: {"cause":[...]}`) — era isso que a
 * vendedora via na tela. Aqui:
 *  - os marcadores saem do texto (continuam no banco para o retry);
 *  - JSON do ML vira frase, com o original guardado em `technical`;
 *  - texto que não é JSON (mensagens já humanas, Shopee, Magalu…) volta
 *    INTACTO — a Shopee usa o mesmo prefixo "Erro ao criar item:" com texto
 *    puro.
 */
export interface FormattedListingError {
  summary: string;
  /** Texto original do marketplace, para "Detalhes técnicos". */
  technical: string | null;
  markers: string[];
}

const MARKERS_RE = /^((?:\[[A-Z_]+\])+)\s*/;
const ML_CREATE_PREFIX = "Erro ao criar item:";

export function splitListingErrorMarkers(lastError: string): {
  markers: string[];
  text: string;
} {
  const m = MARKERS_RE.exec(lastError);
  if (!m) return { markers: [], text: lastError };
  const markers = m[1].match(/\[([A-Z_]+)\]/g)!.map((s) => s.slice(1, -1));
  return { markers, text: lastError.slice(m[0].length) };
}

function parseMLBody(text: string): { cause?: MLCause[] } | null {
  const idx = text.indexOf(ML_CREATE_PREFIX);
  if (idx !== 0) return null;
  const json = text.slice(ML_CREATE_PREFIX.length).trim();
  if (!json.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function formatListingError(
  lastError: string | null | undefined,
  /**
   * Plataforma da linha. O JSON só é traduzido nas linhas do Mercado Livre —
   * Shopee/Magalu usam o mesmo prefixo com corpo próprio, e dizer "o Mercado
   * Livre recusou" ali seria mentira. Ausente = trata como ML (legado).
   */
  platform?: string | null,
): FormattedListingError | null {
  if (!lastError || !lastError.trim()) return null;
  const { markers, text } = splitListingErrorMarkers(lastError.trim());

  if (platform && platform !== "MERCADO_LIVRE") {
    return { summary: text, technical: null, markers };
  }

  const body = parseMLBody(text);
  if (!body) {
    return { summary: text, technical: null, markers };
  }

  const causes = Array.isArray(body.cause) ? body.cause : [];
  const actionable = pickActionableMLError([causes]);
  if (actionable) {
    return { summary: actionable, technical: text, markers };
  }

  const errors = causes.filter(
    (c) => (c?.type ?? "error").toLowerCase() === "error",
  );
  const soFamilyName =
    errors.length > 0 &&
    errors.every(
      (c) => c?.cause_id === 369 || /family_name/i.test(String(c?.message)),
    );
  if (soFamilyName) {
    // A 1ª tentativa sempre leva 369 em conta de "User Products"; a causa real
    // aparecia só na retentativa e não era guardada (anúncios antigos).
    return {
      summary:
        "O Mercado Livre recusou a publicação, mas o motivo real não ficou registrado nesta tentativa. " +
        "Clique em “Tentar publicar novamente” para ver o motivo atual.",
      technical: text,
      markers,
    };
  }

  const first = errors[0] ?? causes[0];
  const described = first ? describeMLCause(first) : null;
  if (described) return { summary: described, technical: text, markers };
  const detalhe = first?.message ? `: ${first.message}` : "";
  const codigo =
    typeof first?.cause_id === "number" ? ` (código ${first.cause_id})` : "";
  return {
    summary: `O Mercado Livre recusou a publicação${detalhe}${codigo}.`,
    technical: text,
    markers,
  };
}
