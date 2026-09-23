/**
 * Representação ESTRUTURADA de uma falha do Mercado Livre — hoje a aplicação
 * só tinha a string `Erro ao criar item: {json}` e decidia retry por texto.
 *
 * Classes (o que cada uma autoriza):
 *  - VALIDATION  → o dado precisa mudar. Retentar sem mudar nada só repete o
 *                  mesmo 400 (medido: 5 tentativas em ~14 min, todas iguais).
 *  - TRANSIENT   → 5xx, rede caída, "reenvie a foto" (3706). Retry com backoff.
 *  - RATE_LIMIT  → 429. Retry com backoff.
 *  - AUTH        → token/permissão. Reconectar a conta.
 *  - UNKNOWN     → sem evidência; inclui TIMEOUT: o `withTimeout` não aborta o
 *                  POST, então o item pode ter sido criado no ML mesmo assim —
 *                  quem retentar precisa reconciliar antes (anti-duplicata).
 *
 * Puro: não loga, não lê env, não chama rede.
 */

export type MLErrorKind =
  | "VALIDATION"
  | "TRANSIENT"
  | "RATE_LIMIT"
  | "AUTH"
  | "UNKNOWN";

export interface MLRawCause {
  cause_id?: number;
  code?: string;
  type?: string;
  message?: string;
  references?: unknown;
  department?: string;
}

export interface NormalizedMLError {
  provider: "mercadolivre";
  operation: string;
  kind: MLErrorKind;
  httpStatus: number | null;
  networkCode: string | null;
  /** `error` do corpo do ML (ex.: "validation_error"). */
  code: string | null;
  /** Só causas `type:"error"` — avisos (306, 4053…) vêm de carona. */
  causeIds: number[];
  causeCodes: string[];
  /** Campos citados pelas causas (family_name, GTIN, VEHICLE_TYPE…). */
  fields: string[];
  retryable: boolean;
  userActionRequired: boolean;
  timedOut: boolean;
  /**
   * AUTH que só a pessoa resolve (403 de permissão / PolicyAgent). 401 de
   * token vencido no meio da publicação NÃO é: o retry renova o token e
   * publica (era assim antes do marcador, e continua sendo).
   */
  authPermanent: boolean;
  step: string | null;
  categoryId: string | null;
}

/**
 * Causas 400 que NÃO dependem do dado do vendedor. 3706 = "Ocorreu um erro
 * ao processar a foto. Por favor, envie-a novamente." — medido nos logs de
 * 16-22/09: o mesmo produto publica numa tentativa seguinte.
 */
const TRANSIENT_CAUSE_IDS = new Set<number>([3706]);

const NETWORK_TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);
const NETWORK_TIMEOUT_CODES = new Set(["ECONNABORTED", "ETIMEDOUT"]);

/**
 * Conexão que CAIU depois de aberta: o POST pode ter chegado ao ML e criado o
 * item antes de a resposta se perder. Diferente de ECONNREFUSED/ENOTFOUND
 * (nunca conectou — nada foi criado).
 */
const NETWORK_MAYBE_SENT_CODES = new Set(["ECONNRESET", "EPIPE"]);

/** Mensagem do `ListingUseCase.withTimeout`: "Timeout (label) after 15000ms". */
const WITH_TIMEOUT_RE = /^Timeout \(.+\) after \d+ms$/;

const AUTH_TEXT_RE =
  /invalid access token|invalid_token|unauthorized|expired_token|PolicyAgent|PA_UNAUTHORIZED/i;

function extractFields(causes: MLRawCause[]): string[] {
  const out = new Set<string>();
  for (const c of causes) {
    const msg = String(c?.message || "");
    // "...properties [family_name]" / "The attributes [BRAND, PART_NUMBER] are required"
    for (const m of msg.matchAll(/\[([A-Za-z_][A-Za-z0-9_, ]*)\]/g)) {
      for (const part of m[1].split(",")) {
        const id = part.trim();
        if (id && /^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) out.add(id);
      }
    }
    // "Attribute INLET_CONNECTION_DIAMETER with value 1 was omitted"
    const single = /Attribute:?\s+([A-Z][A-Z0-9_]+)\b/.exec(msg);
    if (single) out.add(single[1]);
  }
  return [...out];
}

/**
 * Marcadores no começo de `ProductListing.lastError` (convenção que já existia
 * com `[TERMINAL]`). O cron só olha `startsWith("[TERMINAL]")`; a tela remove
 * todos antes de mostrar (listing-error-format.ts).
 *
 *  - CORRIGIVEL: dado a corrigir. Terminal para o retry cego, mas a EDIÇÃO do
 *    produto re-arma (ProductUseCase.update) — publica sozinho depois da
 *    correção, sem tentar 5 vezes o mesmo corpo recusado.
 *  - RECONECTAR: conta sem autorização. Terminal; reconectar e tentar de novo.
 *  - VERIFICAR: a tentativa pode ter criado o item no ML sem a Dexo saber
 *    (timeout, 5xx). O retry CONFERE no ML antes de criar de novo.
 */
export const LAST_ERROR_MARKER = {
  CORRIGIVEL: "[TERMINAL][CORRIGIVEL]",
  RECONECTAR: "[TERMINAL][RECONECTAR]",
  VERIFICAR: "[VERIFICAR]",
} as const;

export type LastErrorMarker =
  (typeof LAST_ERROR_MARKER)[keyof typeof LAST_ERROR_MARKER];

export function lastErrorMarkerFor(n: {
  kind: MLErrorKind;
  httpStatus: number | null;
  timedOut: boolean;
  networkCode?: string | null;
  authPermanent?: boolean;
}): LastErrorMarker | null {
  if (n.kind === "VALIDATION") return LAST_ERROR_MARKER.CORRIGIVEL;
  // Token vencido: sem marcador ⇒ o retry renova e tenta de novo (como antes).
  if (n.kind === "AUTH") {
    return n.authPermanent === false ? null : LAST_ERROR_MARKER.RECONECTAR;
  }
  if (
    n.timedOut ||
    n.kind === "UNKNOWN" ||
    (n.kind === "TRANSIENT" && n.httpStatus !== null && n.httpStatus >= 500) ||
    (n.kind === "TRANSIENT" &&
      !!n.networkCode &&
      NETWORK_MAYBE_SENT_CODES.has(n.networkCode))
  ) {
    return LAST_ERROR_MARKER.VERIFICAR;
  }
  return null;
}

/** Marcador de terminal? (o retry não deve seguir sozinho) */
export function isTerminalMarker(marker: string | null | undefined): boolean {
  return !!marker && marker.startsWith("[TERMINAL]");
}

/**
 * Frase para a pessoa quando nenhuma causa específica foi reconhecida. Nunca
 * devolve JSON — o técnico vai para o log estruturado.
 */
export function humanMessageForKind(
  n: NormalizedMLError,
  ctx: { accountName?: string | null; firstCause?: MLRawCause | null } = {},
): string {
  switch (n.kind) {
    case "VALIDATION": {
      const c = ctx.firstCause;
      if (c?.message) {
        const codigo = typeof c.cause_id === "number" ? ` (código ${c.cause_id})` : "";
        return `O Mercado Livre recusou o anúncio: ${c.message}${codigo}. Corrija o cadastro do produto e tente publicar novamente.`;
      }
      return "O Mercado Livre recusou o anúncio sem detalhar o motivo. Revise o cadastro do produto e tente publicar novamente.";
    }
    case "AUTH":
      if (!n.authPermanent) {
        return `O acesso da conta ${ctx.accountName ? `"${ctx.accountName}" ` : ""}ao Mercado Livre expirou durante a publicação. A Dexo renova o acesso e tenta de novo automaticamente.`;
      }
      return `A conta ${ctx.accountName ? `"${ctx.accountName}" ` : ""}do Mercado Livre precisa ser reconectada — o Mercado Livre recusou a autorização. Reconecte a conta em Integrações e tente publicar novamente.`;
    case "RATE_LIMIT":
      return "O Mercado Livre limitou as requisições neste momento. A Dexo vai tentar publicar de novo automaticamente.";
    case "TRANSIENT":
      return "O Mercado Livre ficou indisponível durante a publicação. A Dexo vai tentar de novo automaticamente.";
    case "UNKNOWN":
    default:
      return n.timedOut
        ? "O Mercado Livre não respondeu a tempo. Antes de tentar de novo, a Dexo confere se o anúncio chegou a ser criado."
        : "A publicação falhou por um motivo que o Mercado Livre não detalhou. A Dexo vai tentar de novo automaticamente.";
  }
}

export function normalizeMLError(input: {
  err: unknown;
  operation?: string;
  step?: string | null;
  categoryId?: string | null;
}): NormalizedMLError {
  const err = input.err as
    | {
        message?: unknown;
        mlError?: unknown;
        mlHttpStatus?: unknown;
        mlNetworkCode?: unknown;
        code?: unknown;
        response?: { status?: unknown };
      }
    | null
    | undefined;

  const message =
    err && typeof err.message === "string" ? err.message : String(err ?? "");
  const body =
    err && err.mlError && typeof err.mlError === "object"
      ? (err.mlError as {
          status?: unknown;
          error?: unknown;
          message?: unknown;
          cause?: unknown;
        })
      : null;

  const statusCandidates = [
    err?.mlHttpStatus,
    err?.response?.status,
    body?.status,
  ];
  const httpStatus =
    (statusCandidates.find(
      (s) => typeof s === "number" && Number.isFinite(s),
    ) as number | undefined) ?? null;

  const networkCode =
    typeof err?.mlNetworkCode === "string"
      ? err.mlNetworkCode
      : typeof err?.code === "string" && /^E[A-Z_]+$/.test(err.code)
        ? err.code
        : null;

  const allCauses: MLRawCause[] = Array.isArray(body?.cause)
    ? (body!.cause as MLRawCause[]).filter((c) => c && typeof c === "object")
    : [];
  const errorCauses = allCauses.filter(
    (c) => (c.type ?? "error").toLowerCase() === "error",
  );
  const causeIds = errorCauses
    .map((c) => c.cause_id)
    .filter((n): n is number => typeof n === "number");
  const causeCodes = errorCauses
    .map((c) => c.code)
    .filter((s): s is string => typeof s === "string");

  const timedOut =
    WITH_TIMEOUT_RE.test(message) ||
    (networkCode !== null && NETWORK_TIMEOUT_CODES.has(networkCode));

  let kind: MLErrorKind;
  if (timedOut) {
    kind = "UNKNOWN";
  } else if (httpStatus === 429) {
    kind = "RATE_LIMIT";
  } else if (httpStatus !== null && httpStatus >= 500) {
    kind = "TRANSIENT";
  } else if (networkCode !== null && NETWORK_TRANSIENT_CODES.has(networkCode)) {
    kind = "TRANSIENT";
  } else if (
    httpStatus === 401 ||
    (httpStatus === 403 &&
      AUTH_TEXT_RE.test(`${message} ${JSON.stringify(body ?? "")}`))
  ) {
    kind = "AUTH";
  } else if (
    httpStatus !== null &&
    httpStatus >= 400 &&
    httpStatus < 500 &&
    errorCauses.length > 0 &&
    errorCauses.every(
      (c) => typeof c.cause_id === "number" && TRANSIENT_CAUSE_IDS.has(c.cause_id),
    )
  ) {
    kind = "TRANSIENT";
  } else if (httpStatus !== null && httpStatus >= 400 && httpStatus < 500) {
    kind = "VALIDATION";
  } else {
    kind = "UNKNOWN";
  }

  const authPermanent =
    kind === "AUTH" &&
    (httpStatus === 403 ||
      /PolicyAgent|PA_UNAUTHORIZED/i.test(
        `${message} ${JSON.stringify(body ?? "")}`,
      ));

  return {
    provider: "mercadolivre",
    operation: input.operation ?? "create_item",
    kind,
    authPermanent,
    httpStatus,
    networkCode,
    code: typeof body?.error === "string" ? body.error : null,
    causeIds,
    causeCodes,
    fields: extractFields(errorCauses),
    retryable:
      kind === "TRANSIENT" ||
      kind === "RATE_LIMIT" ||
      kind === "UNKNOWN" ||
      (kind === "AUTH" && !authPermanent),
    userActionRequired: kind === "VALIDATION" || authPermanent,
    timedOut,
    step: input.step ?? null,
    categoryId: input.categoryId ?? null,
  };
}
