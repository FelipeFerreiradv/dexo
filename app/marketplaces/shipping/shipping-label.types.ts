/**
 * Tipos compartilhados do módulo de Etiqueta de Envio (Mercado Livre + Shopee).
 *
 * Módulo 100% aditivo: consome a NF-e já autorizada do pedido, envia ao
 * marketplace e baixa a etiqueta. Nada aqui altera emissão de NF-e, OAuth,
 * importação de pedidos ou sync.
 */

export type LabelSize = "A4" | "THERMAL";

export type ShippingPlatform = "MERCADO_LIVRE" | "SHOPEE";

/**
 * Estados persistidos em `ShipmentLabel.labelStatus`.
 * - NONE: nada feito ainda
 * - INVOICE_SENT: NF-e enviada ao marketplace (aguardando liberação)
 * - READY_TO_PRINT: marketplace liberou o envio (etiqueta disponível)
 * - GENERATED: PDF da etiqueta gerado e armazenado
 * - ERROR: falha no fluxo (ver labelError)
 */
export type LabelStatus =
  | "NONE"
  | "INVOICE_SENT"
  | "READY_TO_PRINT"
  | "GENERATED"
  | "ERROR";

/** Resultado de `ensureReadyToShip`. */
export interface ShipReadiness {
  ready: boolean;
  /** Motivo legível quando não está pronto (ex.: "invoice_pending"). */
  reason?: string;
  /** Status/substatus crus do provedor (diagnóstico/log). */
  status?: string | null;
  substatus?: string | null;
  /** id do envio (ML shipment id; Shopee usa order_sn = externalOrderId). */
  shipmentId?: string | null;
  trackingNumber?: string | null;
}

/** Conta de marketplace resolvida (credenciais por conta). */
export interface ShippingAccount {
  id: string;
  platform: ShippingPlatform;
  accessToken: string;
  refreshToken: string | null;
  /** Seller do ML. */
  externalUserId: string | null;
  /** shopId da Shopee. */
  shopId: number | null;
}

/** Referência à NF-e autorizada de produção do pedido (com o XML já lido). */
export interface AuthorizedNfeRef {
  id: string;
  chaveAcesso: string;
  xmlAutorizadoPath: string;
  /** Conteúdo do XML autorizado (já decodificado de Buffer para string). */
  xml: string;
}

/**
 * Contexto de um pedido a processar — resolvido pelo usecase (pedido + conta +
 * NF-e). É o que cada adapter recebe.
 */
export interface ShippingOrderContext {
  order: {
    id: string;
    externalOrderId: string;
    marketplaceAccountId: string;
  };
  account: ShippingAccount;
  nfe: AuthorizedNfeRef;
}

export type ShippingLabelErrorCode =
  | "ORDER_NOT_FOUND"
  | "NFE_NOT_FOUND" // pedido sem NF-e AUTORIZADA de produção
  | "NFE_HOMOLOGACAO" // só há NF-e de homologação autorizada
  | "NFE_XML_MISSING" // xmlAutorizadoPath nulo ou arquivo ausente
  | "NOT_READY" // marketplace ainda não liberou (ex.: invoice_pending)
  | "UNSUPPORTED_PLATFORM"
  | "SHIPMENT_NOT_FOUND" // pedido sem shipment id no marketplace
  | "PROVIDER_ERROR"; // erro genérico do provedor

/**
 * Erro de domínio do módulo. Carrega um `code` estável para a rota traduzir em
 * status HTTP + mensagem legível, sem vazar detalhes internos.
 */
export class ShippingLabelError extends Error {
  code: ShippingLabelErrorCode;
  constructor(code: ShippingLabelErrorCode, message: string) {
    super(message);
    this.name = "ShippingLabelError";
    this.code = code;
  }
}
