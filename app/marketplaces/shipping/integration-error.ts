/**
 * Erro tipado de integração com marketplace + o normalizador único de erro HTTP.
 *
 * Existe por causa do incidente de 29/07/2026: a Shopee respondeu
 * `HTTP 404 {"error":"error_not_found"}` ao upload da NF-e, mas o catch de
 * `uploadInvoiceDoc` lia só `response.data.message` — campo que aquele corpo
 * não tem — e caía no fallback `error.message` do axios. O usuário via
 * "Shopee upload_invoice_doc 404: Request failed with status code 404", e o
 * dado que resolvia o caso (`error_not_found`, o `request_id`, a URL chamada)
 * era descartado dentro do próprio catch.
 *
 * Regra: NUNCA relançar `error.message` cru do axios. Todo erro de parceiro
 * passa por `toIntegrationError`.
 *
 * Espelha o formato de `mlError` (ml-shipping.service.ts), que já preservava
 * `status` e `responseData` — a referência da casa é o Mercado Livre.
 */
import axios from "axios";

export type IntegrationMarketplace = "SHOPEE" | "MERCADO_LIVRE" | "MAGALU";

/** Contexto do passo que falhou — tudo opcional para não travar call sites. */
export interface IntegrationErrorContext {
  marketplace: IntegrationMarketplace;
  /** Ex.: "shopee.order.upload_invoice_doc" — identifica a operação do parceiro. */
  operation: string;
  /** Etapa do nosso pipeline: "upload_invoice_doc", "create_shipping_document"… */
  step?: string;
  /** Método + URL final, JÁ SANITIZADOS (sem access_token/sign/partner_id). */
  endpoint?: string;
  orderId?: string;
  orderSn?: string;
  shopId?: number | null;
  correlationId?: string;
}

/** Query params que jamais podem aparecer em log, mensagem ou relatório. */
const SECRET_QUERY_KEYS = ["access_token", "sign", "partner_id", "partner_key"];

/**
 * Remove segredos da query string de uma URL, preservando o resto — é essa
 * forma que vai para log e para o campo `endpoint` do erro.
 */
export function sanitizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    for (const key of SECRET_QUERY_KEYS) {
      if (url.searchParams.has(key)) url.searchParams.set(key, "***");
    }
    return url.toString();
  } catch {
    // Não era URL absoluta — devolve sem query para não vazar nada por engano.
    return rawUrl.split("?")[0];
  }
}

/** CPF, CNPJ e sequências numéricas longas (telefone, chave) do comprador. */
export function scrubPii(text: string): string {
  return text
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, "***CPF***")
    .replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, "***CNPJ***")
    .replace(/\b\d{10,}\b/g, "***NUM***");
}

/** Corpo de resposta -> trecho curto, textual e sanitizado. */
export function toBodySnippet(data: unknown, max = 500): string | undefined {
  if (data == null) return undefined;
  let text: string;
  if (Buffer.isBuffer(data)) {
    text = data.toString("utf-8");
  } else if (typeof data === "string") {
    text = data;
  } else {
    try {
      text = JSON.stringify(data);
    } catch {
      return undefined;
    }
  }
  const clean = scrubPii(text);
  return clean.length <= max ? clean : `${clean.slice(0, max)}…[+${clean.length - max}]`;
}

/**
 * Erro de integração com um marketplace. Carrega TUDO que o diagnóstico exige;
 * `message` é legível para humano, os campos estruturados são para log.
 */
export class MarketplaceIntegrationError extends Error {
  readonly marketplace: IntegrationMarketplace;
  readonly operation: string;
  readonly step?: string;
  readonly endpoint?: string;
  /** Status HTTP do parceiro. null quando nem houve resposta (timeout/DNS). */
  readonly httpStatus: number | null;
  /** Código de erro do parceiro (Shopee `error`, ML/Magalu `error`). */
  readonly providerErrorCode?: string;
  readonly providerMessage?: string;
  readonly providerRequestId?: string;
  readonly responseBodySnippet?: string;
  readonly orderId?: string;
  readonly orderSn?: string;
  readonly shopId?: number | null;
  readonly correlationId?: string;
  /**
   * `status` numérico plano — mantido porque `isMarketplaceAuthError` e o
   * código legado leem `error.status`. Remover quebraria o refresh de token.
   */
  readonly status: number | null;

  constructor(
    message: string,
    fields: IntegrationErrorContext & {
      httpStatus: number | null;
      providerErrorCode?: string;
      providerMessage?: string;
      providerRequestId?: string;
      responseBodySnippet?: string;
      cause?: unknown;
    },
  ) {
    super(message, { cause: fields.cause });
    this.name = "MarketplaceIntegrationError";
    this.marketplace = fields.marketplace;
    this.operation = fields.operation;
    this.step = fields.step;
    this.endpoint = fields.endpoint;
    this.httpStatus = fields.httpStatus;
    this.status = fields.httpStatus;
    this.providerErrorCode = fields.providerErrorCode;
    this.providerMessage = fields.providerMessage;
    this.providerRequestId = fields.providerRequestId;
    this.responseBodySnippet = fields.responseBodySnippet;
    this.orderId = fields.orderId;
    this.orderSn = fields.orderSn;
    this.shopId = fields.shopId;
    this.correlationId = fields.correlationId;
  }

  /** Objeto plano para log estruturado. Sem segredo, sem PII. */
  toLogFields(): Record<string, unknown> {
    return {
      marketplace: this.marketplace,
      operation: this.operation,
      step: this.step,
      endpoint: this.endpoint,
      httpStatus: this.httpStatus,
      providerErrorCode: this.providerErrorCode,
      providerMessage: this.providerMessage,
      providerRequestId: this.providerRequestId,
      responseBodySnippet: this.responseBodySnippet,
      orderId: this.orderId,
      orderSn: this.orderSn,
      shopId: this.shopId,
      correlationId: this.correlationId,
    };
  }

  /**
   * Erro determinístico do parceiro (4xx que não é auth nem rate limit):
   * repetir a mesma requisição dá o mesmo resultado → NÃO retentar.
   */
  get isDeterministic4xx(): boolean {
    if (this.httpStatus == null) return false;
    if (this.httpStatus === 429) return false;
    return this.httpStatus >= 400 && this.httpStatus < 500;
  }

  /** Transitório: vale retentar com backoff. */
  get isTransient(): boolean {
    if (this.httpStatus == null) return true; // timeout / rede
    return this.httpStatus === 429 || this.httpStatus >= 500;
  }
}

/**
 * Converte QUALQUER erro (axios ou não) em `MarketplaceIntegrationError`,
 * preservando corpo, código e request_id do parceiro.
 *
 * Cobre os dois formatos de falha da Shopee:
 *  - HTTP != 2xx com corpo `{"error":"error_not_found"}` (sem `message`)
 *  - HTTP 200 com corpo `{"error":"error_param","message":…,"request_id":…}`
 *    — para esse caso use `integrationErrorFromBody`.
 */
export function toIntegrationError(
  error: unknown,
  ctx: IntegrationErrorContext,
): MarketplaceIntegrationError {
  if (error instanceof MarketplaceIntegrationError) return error;

  if (axios.isAxiosError(error)) {
    const httpStatus = error.response?.status ?? null;
    const data = error.response?.data as
      | { error?: string; message?: string; msg?: string; request_id?: string }
      | undefined;

    // A ORDEM IMPORTA: `message` pode não existir (foi o caso do 404), então
    // caímos para o código do parceiro ANTES de usar a mensagem genérica do
    // axios. Era exatamente essa a linha que apagava a evidência.
    const providerErrorCode =
      typeof data?.error === "string" && data.error ? data.error : undefined;
    const providerMessage = data?.message || data?.msg || undefined;
    const detail =
      providerMessage ??
      providerErrorCode ??
      error.code ??
      error.message ??
      "erro desconhecido";

    const endpoint = ctx.endpoint ?? sanitizeUrl(error.config?.url ?? "");

    return new MarketplaceIntegrationError(
      `${ctx.operation} falhou (HTTP ${httpStatus ?? "sem resposta"}): ${detail}`,
      {
        ...ctx,
        endpoint,
        httpStatus,
        providerErrorCode,
        providerMessage,
        providerRequestId: data?.request_id,
        responseBodySnippet: toBodySnippet(error.response?.data),
        cause: error,
      },
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  return new MarketplaceIntegrationError(`${ctx.operation} falhou: ${message}`, {
    ...ctx,
    httpStatus: null,
    // Preserva o texto original como `providerMessage`. Sem isto,
    // `toUserFacingMessage` não teria motivo nenhum e cairia no genérico
    // "não houve resposta", jogando fora explicações acionáveis que vêm em
    // Error puro — ex.: o "Request Source IP (…) is undeclared" da Shopee,
    // que diz exatamente o que fazer.
    providerMessage: message,
    cause: error,
  });
}

const MARKETPLACE_LABEL: Record<IntegrationMarketplace, string> = {
  SHOPEE: "Shopee",
  MERCADO_LIVRE: "Mercado Livre",
  MAGALU: "Magalu",
};

/** Etapas do pipeline em português, para a mensagem que o lojista lê. */
const STEP_LABEL: Record<string, string> = {
  token_refresh: "renovar a autorização da conta",
  upload_invoice_doc: "enviar a NF-e",
  send_invoice_data: "enviar a NF-e",
  ship_order: "confirmar o envio",
  get_shipping_parameter: "consultar as opções de envio",
  get_shipping_document_parameter: "consultar o tipo de etiqueta",
  create_shipping_document: "gerar a etiqueta",
  get_shipping_document_result: "consultar a etiqueta",
  download_shipping_document: "baixar a etiqueta",
};

/**
 * Mensagem em português, acionável, para a UI: o que falhou, em qual pedido, em
 * qual etapa, e o motivo dado pelo parceiro. Nunca "Request failed with status
 * code 404".
 */
export function toUserFacingMessage(error: MarketplaceIntegrationError): string {
  const marketplace = MARKETPLACE_LABEL[error.marketplace] ?? error.marketplace;
  const step = error.step ? (STEP_LABEL[error.step] ?? error.step) : "concluir a operação";
  const pedido = error.orderSn ? ` do pedido ${error.orderSn}` : "";

  const reason =
    error.providerMessage ??
    (error.providerErrorCode
      ? `a ${marketplace} respondeu "${error.providerErrorCode}"`
      : error.httpStatus == null
        ? `não houve resposta da ${marketplace} (tempo esgotado ou rede)`
        : `a ${marketplace} respondeu HTTP ${error.httpStatus}`);

  const ref = error.providerRequestId
    ? ` (referência ${marketplace}: ${error.providerRequestId})`
    : "";

  return `Falha ao ${step}${pedido} na ${marketplace}: ${reason}${ref}`;
}

/**
 * A Shopee devolve erro de negócio como HTTP 200 com `error` preenchido.
 * Este helper transforma esse corpo no mesmo erro tipado, para que 200-com-erro
 * e 4xx sigam pelo mesmo caminho de tratamento.
 */
export function integrationErrorFromBody(
  // `null` além de `undefined`: ShopeeApiResponse declara os campos como
  // `string | null`, não opcionais.
  body: {
    error?: string | null;
    message?: string | null;
    msg?: string | null;
    request_id?: string | null;
  },
  ctx: IntegrationErrorContext,
): MarketplaceIntegrationError {
  const detail = body.message || body.msg || body.error || "erro desconhecido";
  return new MarketplaceIntegrationError(
    `${ctx.operation} recusado pela ${ctx.marketplace}: ${detail}`,
    {
      ...ctx,
      // 200 no transporte, mas é falha de negócio — não é transitório nem
      // 4xx determinístico, então nenhum retry o alcança.
      httpStatus: 200,
      providerErrorCode: body.error ?? undefined,
      providerMessage: body.message ?? body.msg ?? undefined,
      providerRequestId: body.request_id ?? undefined,
      responseBodySnippet: toBodySnippet(body),
    },
  );
}
