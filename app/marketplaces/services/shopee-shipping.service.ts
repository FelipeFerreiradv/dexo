/**
 * Adapter de etiqueta de envio da Shopee (Open Platform v2 — logistics).
 *
 * Diferença-chave p/ o ML: aqui a etiqueta é assíncrona (create → result(poll)
 * → download) e o ship_order exige escolher coleta/postagem. Os métodos de
 * logistics vivem em ShopeeApiService (públicos; makeAuthenticatedRequest é
 * private). Token/refresh via ShippingAuthRetry.shopee.
 *
 * Shapes a confirmar em homologação (SHOPEE_SANDBOX=true).
 */
import { ShopeeApiService } from "./shopee-api.service";
import { ShippingAuthRetry } from "../shipping/auth-retry";
import type { ShippingLabelProvider } from "../shipping/shipping-label.provider";
import {
  ShippingLabelError,
  type LabelSize,
  type ShipReadiness,
  type ShippingOrderContext,
  type ShippingPlatform,
} from "../shipping/shipping-label.types";

interface ShopeeShippingOpts {
  pollMaxAttempts?: number;
  pollDelayMs?: number;
}

export class ShopeeShippingLabelProvider implements ShippingLabelProvider {
  readonly platform: ShippingPlatform = "SHOPEE";

  constructor(private opts: ShopeeShippingOpts = {}) {}

  private get pollMaxAttempts(): number {
    return this.opts.pollMaxAttempts ?? 8;
  }
  private get pollDelayMs(): number {
    return this.opts.pollDelayMs ?? 1500;
  }
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private docTypeFor(size: LabelSize): string {
    return size === "THERMAL" ? "THERMAL_AIR_WAYBILL" : "NORMAL_AIR_WAYBILL";
  }

  /**
   * Decide pickup vs dropoff a partir do get_shipping_parameter. Regra:
   * dropoff quando suportado e pickup não é exigido (mais simples, sem slot);
   * senão pickup com o 1º endereço/slot disponível.
   */
  private buildShipBody(
    orderSn: string,
    param: Record<string, any>,
  ): { order_sn: string; pickup?: any; dropoff?: any } {
    const infoNeeded = param?.info_needed ?? {};
    const pickupNeeded =
      Array.isArray(infoNeeded.pickup) && infoNeeded.pickup.length > 0;

    if (!pickupNeeded) {
      const dropoff: Record<string, any> = {};
      const branch = param?.dropoff?.branch_list?.[0];
      if (branch?.branch_id) dropoff.branch_id = branch.branch_id;
      return { order_sn: orderSn, dropoff };
    }

    const addr =
      param?.pickup?.address_list?.find((a: any) =>
        a?.address_flag?.includes?.("pickup_address"),
      ) ?? param?.pickup?.address_list?.[0];
    const pickup: Record<string, any> = {};
    if (addr?.address_id) pickup.address_id = addr.address_id;
    const timeId =
      addr?.time_slot_list?.[0]?.pickup_time_id ??
      param?.pickup?.time_slot_list?.[0]?.pickup_time_id;
    if (timeId) pickup.pickup_time_id = timeId;
    return { order_sn: orderSn, pickup };
  }

  private isAlreadyArranged(error: unknown): boolean {
    const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
    const code = (
      (error as { shopeeError?: string })?.shopeeError ??
      // MarketplaceIntegrationError expõe o mesmo código como providerErrorCode.
      (error as { providerErrorCode?: string })?.providerErrorCode ??
      ""
    ).toLowerCase();
    return (
      /already|has been|arranged|logistics_status|ready/.test(msg) ||
      /logistics/.test(code)
    );
  }

  /**
   * A Shopee recusa o get_shipping_parameter depois que o envio já foi
   * arranjado — e quem arranja é o nosso próprio ship_order, na tentativa
   * anterior. Duas frases, medidas em produção em 25/08/2026, dizem a mesma
   * coisa em estados diferentes do pacote:
   *
   *   "Package OFG… not eligible for rescheduling"
   *      → envio criado, ainda não coletado (LOGISTICS_REQUEST_CREATED)
   *   "Shipping parameters can only be obtained when package is ready to be
   *    shipped"
   *      → pacote já coletado ou entregue
   *
   * Como get_shipping_parameter só existe para ARRANJAR/REMARCAR o envio, e ele
   * é a PRIMEIRA etapa da cadeia, um pedido que já passou desse ponto nunca mais
   * conseguia etiqueta: 14 pedidos ficaram presos em labelStatus=ERROR assim.
   *
   * O casamento é pelo TEXTO de propósito. O código que a Shopee devolve é
   * "error_other" na primeira frase e "error_param" na segunda — baldes
   * genéricos dela. Casar por código toleraria QUALQUER erro desta etapa, que é
   * exatamente o que não se quer.
   *
   * A segunda alternativa é escrita por inteiro pelo mesmo motivo: /ready/
   * sozinho casaria também com "not ready", que significa o oposto.
   */
  private isShippingParameterNoLongerApplicable(error: unknown): boolean {
    const msg = (
      error instanceof Error ? error.message : String(error)
    ).toLowerCase();
    return (
      /not eligible for rescheduling/.test(msg) ||
      /shipping parameters can only be obtained when package is ready to be shipped/.test(
        msg,
      )
    );
  }

  /**
   * A Shopee recusa o upload da NF-e depois que o envio já foi arranjado:
   * "Upload is not accepted after shipment is arranged". Isso NÃO é falha —
   * significa que a etapa fiscal já não se aplica àquele pedido, e insistir
   * jamais vai passar. Bloquear a etiqueta por causa disso deixaria o pedido
   * permanentemente preso.
   *
   * Mesmo espírito do adapter do ML, que checa `invoiceAlreadyHandled` e não
   * reenvia quando o envio já foi impresso/despachado.
   */
  private isInvoiceNoLongerAccepted(error: unknown): boolean {
    const msg = (
      error instanceof Error ? error.message : String(error)
    ).toLowerCase();
    return (
      /not accepted after shipment is arranged/.test(msg) ||
      /invoice.*already.*(upload|exist)/.test(msg)
    );
  }

  async ensureInvoiceSent(ctx: ShippingOrderContext): Promise<void> {
    // upload_invoice_doc envia/atualiza — re-chamar é idempotente (update).
    try {
      await ShippingAuthRetry.shopee(ctx.account, (token, shopId) =>
        ShopeeApiService.uploadInvoiceDoc(
          token,
          shopId,
          ctx.order.externalOrderId,
          ctx.nfe.xml,
        ),
      );
    } catch (error) {
      if (
        process.env.SHOPEE_INVOICE_ARRANGED_TOLERANT_DISABLED === "1" ||
        !this.isInvoiceNoLongerAccepted(error)
      ) {
        throw error;
      }
      console.warn(
        `[Shipping] Shopee não aceita mais a NF-e do pedido ${ctx.order.externalOrderId} (envio já arranjado) — seguindo para a etiqueta.`,
      );
    }
  }

  async ensureReadyToShip(ctx: ShippingOrderContext): Promise<ShipReadiness> {
    return ShippingAuthRetry.shopee(ctx.account, async (token, shopId) => {
      const orderSn = ctx.order.externalOrderId;
      let param: Record<string, any>;
      try {
        param = await ShopeeApiService.getShippingParameter(
          token,
          shopId,
          orderSn,
        );
      } catch (error) {
        if (
          process.env.SHOPEE_SHIPPING_PARAM_TOLERANT_DISABLED === "1" ||
          !this.isShippingParameterNoLongerApplicable(error)
        ) {
          throw error;
        }
        const code =
          (error as { providerErrorCode?: string })?.providerErrorCode ??
          "sem codigo";
        console.warn(
          `[Shipping] Shopee nao permite mais consultar as opcoes de envio do pedido ${orderSn} (${code}) — o envio ja foi arranjado, entao ship_order nao tem o que fazer; indo direto buscar o rastreio.`,
        );
        // O rastreio é a confirmação POSITIVA e independente de que o envio foi
        // mesmo arranjado. Sem ele, a frase "…when package is ready to be
        // shipped" também caberia num pedido que AINDA NÃO chegou lá — e aí
        // pular o ship_order seria errado.
        let tracking: string | null = null;
        try {
          tracking = await ShopeeApiService.getTrackingNumber(
            token,
            shopId,
            orderSn,
          );
        } catch {
          // sem rastreio não dá para confirmar — cai no não-pronto abaixo
        }
        // trim: logo depois do ship_order a Shopee devolve string VAZIA, não
        // null. É o que está gravado nos 14 registros presos.
        if (tracking?.trim()) {
          return { ready: true, shipmentId: orderSn, trackingNumber: tracking };
        }
        console.warn(
          `[Shipping] Pedido ${orderSn}: envio ja arranjado, mas a Shopee ainda nao devolveu o rastreio — nao-pronto (NOT_READY, o pedido NAO e marcado como erro).`,
        );
        return {
          ready: false,
          reason: error instanceof Error ? error.message : String(error),
          shipmentId: orderSn,
        };
      }
      const body = this.buildShipBody(orderSn, param);
      try {
        await ShopeeApiService.shipOrder(token, shopId, body);
      } catch (error) {
        // Já arranjado → segue. Senão, ainda não liberado (ex.: NF-e validando
        // na SEFAZ) → não-pronto com a mensagem da Shopee.
        if (!this.isAlreadyArranged(error)) {
          return {
            ready: false,
            reason: error instanceof Error ? error.message : String(error),
            shipmentId: orderSn,
          };
        }
      }
      let tracking: string | null = null;
      try {
        tracking = await ShopeeApiService.getTrackingNumber(
          token,
          shopId,
          orderSn,
        );
      } catch {
        // tracking pode ainda não estar disponível — não bloqueia
      }
      return { ready: true, shipmentId: orderSn, trackingNumber: tracking };
    });
  }

  async getLabelPdf(
    ctxs: ShippingOrderContext[],
    opts: { size: LabelSize },
  ): Promise<Buffer> {
    if (ctxs.length === 0) {
      throw new ShippingLabelError(
        "PROVIDER_ERROR",
        "Nenhum pedido para gerar etiqueta.",
      );
    }
    const account = ctxs[0].account;
    const docType = this.docTypeFor(opts.size);
    const orderList = ctxs.map((c) => ({ order_sn: c.order.externalOrderId }));

    return ShippingAuthRetry.shopee(account, async (token, shopId) => {
      // A transportadora do pedido dita quais tipos de documento existem.
      // Pedir um tipo não suportado falha no create com o motivo enterrado no
      // result_list; consultar antes troca isso por uma escolha informada.
      // Best-effort: se a consulta falhar, segue com o tipo pedido — o
      // comportamento anterior.
      let effectiveDocType = docType;
      if (process.env.SHOPEE_LABEL_DOC_PARAM_DISABLED !== "1") {
        try {
          const param = await ShopeeApiService.getShippingDocumentParameter(
            token,
            shopId,
            orderList,
          );
          if (
            param.selectable.length > 0 &&
            !param.selectable.includes(docType)
          ) {
            effectiveDocType = param.suggested ?? param.selectable[0];
            console.warn(
              `[Shipping] Shopee não aceita ${docType} para este pedido; usando ${effectiveDocType} (aceitos: ${param.selectable.join(", ")}).`,
            );
          }
        } catch (error) {
          console.warn(
            `[Shipping] get_shipping_document_parameter indisponível: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      await ShopeeApiService.createShippingDocument(
        token,
        shopId,
        orderList,
        effectiveDocType,
      );

      let ready = false;
      for (let i = 0; i < this.pollMaxAttempts; i++) {
        const results = await ShopeeApiService.getShippingDocumentResult(
          token,
          shopId,
          orderList,
          effectiveDocType,
        );
        if (results.some((r) => r.status === "FAILED")) {
          throw new ShippingLabelError(
            "PROVIDER_ERROR",
            "Shopee falhou ao gerar o documento de envio (status FAILED).",
          );
        }
        if (
          results.length > 0 &&
          results.every((r) => r.status === "READY")
        ) {
          ready = true;
          break;
        }
        await this.sleep(this.pollDelayMs);
      }
      if (!ready) {
        throw new ShippingLabelError(
          "NOT_READY",
          "Documento de envio da Shopee ainda não está pronto. Tente novamente em instantes.",
        );
      }

      return ShopeeApiService.downloadShippingDocument(
        token,
        shopId,
        orderList,
        effectiveDocType,
      );
    });
  }
}
