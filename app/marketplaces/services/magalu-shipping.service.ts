/**
 * Adapter de etiqueta de envio da Magalu (API de Logística).
 *
 * A Magalu gera a etiqueta por `delivery.id` (NÃO por order id) + o `channel.id`
 * do seller, devolvendo uma `signed_url` para baixar o PDF/ZPL:
 *   POST /seller/v1/logistics/shipping-labels
 *     body  { channel:{id,extras:{}}, deliveries:[{id}], label:{format,type} }
 *     200   { label:{ signed_url, expires_on }, deliveries:[{id,tracking}] }
 *
 * O `channel.id` vem de GET /seller/v1/portfolios/me (MagaluApiService.getMe) e
 * os `delivery.id` do detalhe do pedido (MagaluApiService.getOrder). Mesmo padrão
 * axios + Bearer do MlShippingService; erros carregam `.status` para o
 * ShippingAuthRetry.magalu detectar 401/403 e refrescar o token.
 *
 * IMPORTANTE: o endpoint de logística é AUTO-CONTIDO — não consome a NF-e. O gate
 * de NF-e autorizada de produção permanece no usecase (resolveContext), por
 * consistência com ML/Shopee e exigência fiscal; a Magalu obtém o documento
 * fiscal pelo próprio fluxo. Por isso `ensureInvoiceSent` é no-op aqui.
 *
 * VALIDAR contra um pedido real: o shape exato do detalhe do pedido (onde vivem
 * os `delivery.id`) não pôde ser confirmado sem Sandbox; `extractDeliveryIds`
 * lê de forma defensiva (deliveries/packages/shipments). Toda a feature fica
 * atrás da flag NEXT_PUBLIC_ETIQUETAS_MODULE_ENABLED.
 */
import axios from "axios";
import { MAGALU_CONSTANTS } from "../magalu/magalu-constants";
import { MagaluApiService } from "./magalu-api.service";
import { ShippingAuthRetry } from "../shipping/auth-retry";
import type { ShippingLabelProvider } from "../shipping/shipping-label.provider";
import {
  ShippingLabelError,
  type LabelSize,
  type ShipReadiness,
  type ShippingAccount,
  type ShippingOrderContext,
  type ShippingPlatform,
} from "../shipping/shipping-label.types";
import type { MagaluOrder } from "../types/magalu-order.types";

/** Subconjunto da resposta de geração de etiqueta da Magalu. */
export interface MagaluLabelResponse {
  label?: {
    signed_url?: string;
    expires_on?: string;
    extras?: Record<string, unknown>;
  };
  deliveries?: Array<{
    id?: string;
    tracking?: { code?: string; url?: string };
  }>;
}

function magaluShippingError(prefix: string, error: unknown): Error {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const data = error.response?.data as
      | { message?: string; error?: string; error_description?: string }
      | undefined;
    const msg =
      data?.error_description || data?.message || data?.error || error.message;
    const e = new Error(`${prefix}: ${msg}`);
    (e as { status?: number }).status = status;
    (e as { responseData?: unknown }).responseData = data;
    return e;
  }
  return new Error(
    `${prefix}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

/**
 * Extrai os `delivery.id` do detalhe do pedido Magalu de forma DEFENSIVA — o
 * shape exato não está confirmado (sem Sandbox). Procura em arrays prováveis
 * (deliveries/packages/shipments) e no objeto único `delivery`, deduplicando.
 */
export function extractDeliveryIds(order: MagaluOrder): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v.trim()) out.push(v.trim());
    else if (typeof v === "number" && Number.isFinite(v)) out.push(String(v));
  };
  const o = order as Record<string, unknown>;
  for (const key of ["deliveries", "packages", "shipments"]) {
    const arr = o[key];
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (item && typeof item === "object") {
          const r = item as Record<string, unknown>;
          push(r.id ?? r.delivery_id ?? r.package_id ?? r.shipment_id);
        }
      }
    }
  }
  const single = o.delivery;
  if (single && typeof single === "object") {
    push((single as Record<string, unknown>).id);
  }
  return Array.from(new Set(out));
}

/** Cliente HTTP de baixo nível da Logística Magalu (estático, sem estado). */
export class MagaluShippingService {
  /**
   * POST /seller/v1/logistics/shipping-labels — gera a etiqueta de 1+ entregas
   * (mesmo channel/seller) e devolve a resposta com a `signed_url`.
   */
  static async generateLabels(
    accessToken: string,
    channelId: string,
    deliveryIds: string[],
    opts: { format: "pdf" | "zpl"; type: "summary" | "full" },
  ): Promise<MagaluLabelResponse> {
    try {
      const resp = await axios.post(
        `${MAGALU_CONSTANTS.API_URL}${MAGALU_CONSTANTS.LOGISTICS_SHIPPING_LABELS_ENDPOINT}`,
        {
          channel: { extras: {}, id: channelId },
          deliveries: deliveryIds.map((id) => ({ id })),
          label: { format: opts.format, type: opts.type },
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          timeout: MAGALU_CONSTANTS.REQUEST_TIMEOUT,
        },
      );
      return resp.data as MagaluLabelResponse;
    } catch (error) {
      throw magaluShippingError("Erro ao gerar etiqueta na Magalu", error);
    }
  }

  /**
   * Baixa a etiqueta a partir da `signed_url` (URL pré-assinada → sem Bearer).
   */
  static async downloadLabel(signedUrl: string): Promise<Buffer> {
    try {
      const resp = await axios.get(signedUrl, {
        responseType: "arraybuffer",
        timeout: MAGALU_CONSTANTS.REQUEST_TIMEOUT,
      });
      return Buffer.from(resp.data as ArrayBuffer);
    } catch (error) {
      throw magaluShippingError("Erro ao baixar etiqueta da Magalu", error);
    }
  }
}

export class MagaluShippingLabelProvider implements ShippingLabelProvider {
  readonly platform: ShippingPlatform = "MAGALU";

  /** Cache do channel.id por conta (evita reconsultar GET /me no fluxo). */
  private channelIdCache = new Map<string, string>();
  /** Cache dos delivery ids por pedido (entre ensureReadyToShip e getLabelPdf). */
  private deliveryIdsCache = new Map<string, string[]>();

  private async resolveChannelId(account: ShippingAccount): Promise<string> {
    const cached = this.channelIdCache.get(account.id);
    if (cached) return cached;
    const me = await ShippingAuthRetry.magalu(account, (token) =>
      MagaluApiService.getMe(token),
    );
    const id = me.channel?.id;
    if (!id) {
      throw new ShippingLabelError(
        "PROVIDER_ERROR",
        "Conta Magalu sem canal de venda (channel) configurado.",
      );
    }
    this.channelIdCache.set(account.id, id);
    return id;
  }

  private async resolveDeliveryIds(
    ctx: ShippingOrderContext,
  ): Promise<string[]> {
    const key = ctx.order.externalOrderId;
    const cached = this.deliveryIdsCache.get(key);
    if (cached) return cached;
    const order = await ShippingAuthRetry.magalu(ctx.account, (token) =>
      MagaluApiService.getOrder(token, ctx.order.externalOrderId),
    );
    const ids = extractDeliveryIds(order);
    this.deliveryIdsCache.set(key, ids);
    return ids;
  }

  /**
   * No-op: a Magalu gera a etiqueta direto pelo endpoint de logística, que NÃO
   * consome a NF-e. O gate de NF-e autorizada continua no usecase (resolveContext).
   */
  async ensureInvoiceSent(_ctx: ShippingOrderContext): Promise<void> {
    // intencionalmente vazio — ver cabeçalho do arquivo.
  }

  /**
   * Pronto quando o pedido tem ao menos uma entrega (delivery) na Magalu. Sem
   * entrega ⇒ não-pronto (retornável, o usuário tenta de novo após a liberação),
   * espelhando o `invoice_pending` do ML.
   */
  async ensureReadyToShip(ctx: ShippingOrderContext): Promise<ShipReadiness> {
    const ids = await this.resolveDeliveryIds(ctx);
    if (ids.length === 0) {
      return {
        ready: false,
        reason:
          "Pedido sem entrega (delivery) disponível na Magalu — aguarde a liberação do envio.",
        shipmentId: null,
      };
    }
    return { ready: true, shipmentId: ids[0] };
  }

  async getLabelPdf(
    ctxs: ShippingOrderContext[],
    _opts: { size: LabelSize },
  ): Promise<Buffer> {
    if (ctxs.length === 0) {
      throw new ShippingLabelError(
        "PROVIDER_ERROR",
        "Nenhum pedido para gerar etiqueta.",
      );
    }
    // Lote por conta garantido a montante (a composição A4 é do usecase). Pedimos
    // sempre format=pdf/type=summary: o buffer precisa ser PDF de verdade p/ o
    // mergePdfs/composeA4 do usecase — por isso `size` não muda a chamada.
    const account = ctxs[0].account;
    const channelId = await this.resolveChannelId(account);
    const deliveryIds: string[] = [];
    for (const ctx of ctxs) {
      deliveryIds.push(...(await this.resolveDeliveryIds(ctx)));
    }
    const uniqueIds = Array.from(new Set(deliveryIds));
    if (uniqueIds.length === 0) {
      throw new ShippingLabelError(
        "SHIPMENT_NOT_FOUND",
        "Pedido sem entrega (delivery) na Magalu.",
      );
    }
    const resp = await ShippingAuthRetry.magalu(account, (token) =>
      MagaluShippingService.generateLabels(token, channelId, uniqueIds, {
        format: "pdf",
        type: "summary",
      }),
    );
    const signedUrl = resp.label?.signed_url;
    if (!signedUrl) {
      throw new ShippingLabelError(
        "PROVIDER_ERROR",
        "A Magalu não retornou a URL da etiqueta (signed_url).",
      );
    }
    return MagaluShippingService.downloadLabel(signedUrl);
  }
}
