/**
 * Orquestração do módulo de Etiqueta de Envio (ML + Shopee).
 *
 * Fluxo por pedido: resolveContext (pedido + conta + NF-e autorizada de
 * produção, com guardas) → seleciona o adapter pela plataforma →
 * ensureInvoiceSent → ensureReadyToShip → getLabelPdf → persiste em
 * ShipmentLabel + storage. Estilo espelhado em OrderUseCase (classe estática,
 * logs "[Shipping] ...", erros não-bloqueantes em lote).
 *
 * Aditivo: não toca emissão de NF-e, OAuth, importação ou sync.
 */
import prisma from "../../lib/prisma";
import { NfeRepository } from "../../repositories/nfe.repository";
import {
  shipmentLabelRepository,
  type ShipmentLabelRecord,
} from "../../repositories/shipment-label.repository";
import { FiscalStorageService } from "../../fiscal/storage/fiscal-storage.service";
import { ShippingLabelStorageService } from "../shipping/shipping-label-storage.service";
import { getShippingProvider } from "../shipping/provider-factory";
import {
  MarketplaceIntegrationError,
  toUserFacingMessage,
} from "../shipping/integration-error";
import { composeA4, mergePdfs } from "../shipping/pdf-merge";
import {
  ShippingLabelError,
  type LabelSize,
  type ShippingOrderContext,
  type ShippingPlatform,
} from "../shipping/shipping-label.types";

export interface GenerateLabelResult {
  record: ShipmentLabelRecord;
  pdf: Buffer;
  /** true quando devolveu a etiqueta já gerada (idempotência), sem novas chamadas. */
  reused: boolean;
}

export interface BatchLabelFailure {
  orderId: string;
  code?: string;
  error: string;
}

export interface BatchLabelResult {
  /** PDF único combinado de todas as etiquetas geradas (null se nenhuma). */
  pdf: Buffer | null;
  /** Quantidade de etiquetas geradas com sucesso. */
  count: number;
  failures: BatchLabelFailure[];
}

export class ShippingLabelUseCase {
  private static nfeRepo = new NfeRepository();
  private static fiscalStorage = new FiscalStorageService();
  private static labelStorage = new ShippingLabelStorageService();

  /**
   * Resolve pedido + conta + NF-e autorizada de produção e aplica as guardas.
   * Lança ShippingLabelError com `code` específico para a rota traduzir.
   */
  static async resolveContext(
    userId: string,
    orderId: string,
  ): Promise<ShippingOrderContext> {
    const order = await prisma.order.findFirst({
      where: { id: orderId, marketplaceAccount: { userId } },
      select: {
        id: true,
        externalOrderId: true,
        marketplaceAccountId: true,
        marketplaceAccount: {
          select: {
            id: true,
            platform: true,
            accessToken: true,
            refreshToken: true,
            externalUserId: true,
            shopId: true,
          },
        },
      },
    });
    if (!order || !order.marketplaceAccount) {
      throw new ShippingLabelError("ORDER_NOT_FOUND", "Pedido não encontrado");
    }

    const prodNfe = await this.nfeRepo.findAuthorizedByOrderId(
      userId,
      orderId,
      "PRODUCAO",
    );
    if (!prodNfe) {
      const anyNfe = await this.nfeRepo.findAuthorizedByOrderId(
        userId,
        orderId,
      );
      if (anyNfe) {
        throw new ShippingLabelError(
          "NFE_HOMOLOGACAO",
          "A NF-e autorizada do pedido é de homologação. Emita uma NF-e de produção antes de gerar a etiqueta.",
        );
      }
      throw new ShippingLabelError(
        "NFE_NOT_FOUND",
        "Pedido sem NF-e autorizada de produção. Emita e autorize a NF-e antes de gerar a etiqueta.",
      );
    }
    if (prodNfe.modelo !== "55") {
      throw new ShippingLabelError(
        "NFE_NOT_FOUND",
        "A NF-e do pedido não é modelo 55 — não aceita pelo marketplace.",
      );
    }
    if (!prodNfe.xmlAutorizadoPath) {
      throw new ShippingLabelError(
        "NFE_XML_MISSING",
        "XML autorizado da NF-e ainda não disponível. Tente novamente em instantes.",
      );
    }
    const xmlBuf = await this.fiscalStorage.readFile(prodNfe.xmlAutorizadoPath);
    if (!xmlBuf) {
      throw new ShippingLabelError(
        "NFE_XML_MISSING",
        "Arquivo do XML autorizado não encontrado no storage.",
      );
    }

    // Pré-condição de conteúdo: falhar aqui, com mensagem clara, é muito melhor
    // que mandar lixo ao marketplace e receber de volta um erro genérico.
    // Vazio ou não começando com "<" indica arquivo truncado ou JSON gravado
    // com extensão .xml.
    if (process.env.SHIPPING_LABEL_PRECHECKS_DISABLED !== "1") {
      const head = xmlBuf.subarray(0, 256).toString("utf-8").trimStart();
      if (xmlBuf.length === 0 || !head.startsWith("<")) {
        throw new ShippingLabelError(
          "NFE_XML_MISSING",
          `O arquivo do XML autorizado da NF-e está inválido (${xmlBuf.length} bytes, não começa com "<"). Reemita ou rebaixe o XML antes de gerar a etiqueta.`,
        );
      }
    }

    const acc = order.marketplaceAccount;
    return {
      order: {
        id: order.id,
        externalOrderId: order.externalOrderId,
        marketplaceAccountId: order.marketplaceAccountId,
      },
      account: {
        id: acc.id,
        platform: acc.platform as ShippingPlatform,
        accessToken: acc.accessToken,
        refreshToken: acc.refreshToken,
        externalUserId: acc.externalUserId,
        shopId: acc.shopId,
      },
      nfe: {
        id: prodNfe.id,
        chaveAcesso: prodNfe.chaveAcesso ?? "",
        xmlAutorizadoPath: prodNfe.xmlAutorizadoPath,
        xml: xmlBuf.toString("utf-8"),
      },
    };
  }

  /**
   * Envia a NF-e ao marketplace, garante a liberação e baixa o PDF CRU (10×15
   * do provedor). Persiste o andamento (INVOICE_SENT/READY_TO_PRINT). Em
   * NOT_READY lança (estado segue INVOICE_SENT); outras falhas marcam ERROR.
   * Não compõe A4 nem salva o arquivo final — isso é do finalizeLabel.
   */
  private static async produceRawLabel(
    ctx: ShippingOrderContext,
    size: LabelSize,
  ): Promise<Buffer> {
    const provider = getShippingProvider(ctx.account.platform);
    const orderId = ctx.order.id;

    // Orçamento de tempo. Sem ele o pior caso do pipeline Shopee (upload +
    // parâmetros + ship + tracking + create + 8 polls + download, a 30s cada)
    // passa de 7 min dentro de UM request HTTP — tempo suficiente para o proxy
    // cortar a conexão e o usuário ver 504 sem CORS, em vez de um erro nosso.
    // Checado ENTRE etapas: limita o estouro a uma etapa, sem mudar a interface
    // dos providers.
    const startedAt = Date.now();
    const budgetMs = Number(process.env.SHIPPING_LABEL_BUDGET_MS ?? 90_000);
    const budgetEnabled =
      process.env.SHIPPING_LABEL_TIME_BUDGET_DISABLED !== "1";
    const checkBudget = (nextStep: string): void => {
      if (!budgetEnabled) return;
      const elapsed = Date.now() - startedAt;
      if (elapsed > budgetMs) {
        throw new ShippingLabelError(
          "NOT_READY",
          `A geração da etiqueta excedeu ${Math.round(budgetMs / 1000)}s no marketplace (parou antes de "${nextStep}"). O andamento foi salvo — tente novamente em instantes.`,
        );
      }
    };

    try {
      checkBudget("envio da NF-e");
      await provider.ensureInvoiceSent(ctx);
      await shipmentLabelRepository.upsert(orderId, {
        provider: ctx.account.platform,
        labelStatus: "INVOICE_SENT",
        invoiceSentAt: new Date(),
        labelError: null,
      });

      checkBudget("liberação do envio");
      const readiness = await provider.ensureReadyToShip(ctx);
      if (!readiness.ready) {
        await shipmentLabelRepository.upsert(orderId, {
          provider: ctx.account.platform,
          labelStatus: "INVOICE_SENT",
          shipmentId: readiness.shipmentId ?? undefined,
          trackingNumber: readiness.trackingNumber ?? undefined,
        });
        throw new ShippingLabelError(
          "NOT_READY",
          readiness.reason ??
            "Aguardando liberação do marketplace para impressão da etiqueta.",
        );
      }

      await shipmentLabelRepository.upsert(orderId, {
        provider: ctx.account.platform,
        labelStatus: "READY_TO_PRINT",
        shipmentId: readiness.shipmentId ?? undefined,
        trackingNumber: readiness.trackingNumber ?? undefined,
      });

      checkBudget("geração do PDF");
      return await provider.getLabelPdf([ctx], { size });
    } catch (error) {
      if (error instanceof ShippingLabelError && error.code === "NOT_READY") {
        throw error;
      }

      // Erro de integração vira PROVIDER_ERROR (→ HTTP 502) com mensagem
      // legível. Antes ele subia como Error puro, escapava do mapa de status da
      // rota e virava 500 opaco com o texto cru do axios na tela.
      let outgoing = error;
      if (error instanceof MarketplaceIntegrationError) {
        console.error(
          "[Shipping] falha de integração",
          JSON.stringify({
            ...error.toLogFields(),
            orderId,
            outcome: "error",
          }),
        );
        outgoing = new ShippingLabelError(
          "PROVIDER_ERROR",
          toUserFacingMessage(error),
        );
      }

      const message =
        outgoing instanceof Error ? outgoing.message : String(outgoing);
      console.warn(
        `[Shipping] Falha ao gerar etiqueta do pedido ${orderId}: ${message}`,
      );
      await shipmentLabelRepository
        .upsert(orderId, {
          provider: ctx.account.platform,
          labelStatus: "ERROR",
          labelError: message.slice(0, 500),
        })
        .catch(() => {
          /* registrar ERROR é best-effort */
        });
      throw outgoing;
    }
  }

  /** Compõe (A4 = 1 etiqueta por folha) + salva + marca GENERATED. */
  private static async finalizeLabel(
    userId: string,
    ctx: ShippingOrderContext,
    raw: Buffer,
    size: LabelSize,
  ): Promise<GenerateLabelResult> {
    const orderId = ctx.order.id;
    const pdf = size === "A4" ? await composeA4(raw, 1) : raw;
    const pdfPath = await this.labelStorage.saveLabelPdf(
      userId,
      orderId,
      size,
      pdf,
    );
    const record = await shipmentLabelRepository.upsert(orderId, {
      provider: ctx.account.platform,
      labelStatus: "GENERATED",
      labelSize: size,
      labelPdfPath: pdfPath,
      labelError: null,
    });
    return { record, pdf, reused: false };
  }

  /**
   * Gera (ou reaproveita) a etiqueta de um pedido. Idempotente: se já houver
   * etiqueta GENERATED do mesmo tamanho e o arquivo existir, devolve-a sem novas
   * chamadas. A4 = composição em folha A4 (1 etiqueta); térmico = 10×15 cru.
   */
  static async generateLabelForOrder(
    userId: string,
    orderId: string,
    size: LabelSize,
  ): Promise<GenerateLabelResult> {
    if (process.env.SHIPPING_LABEL_LOCK_DISABLED === "1") {
      return this.generateLabelForOrderUnlocked(userId, orderId, size);
    }
    return this.withOrderLock(orderId, () =>
      this.generateLabelForOrderUnlocked(userId, orderId, size),
    );
  }

  /**
   * Serializa as emissões do MESMO pedido.
   *
   * Sem isso, dois cliques (ou duas abas) disparam o pipeline inteiro em
   * paralelo: dois `upload_invoice_doc`, dois `ship_order`, dois
   * `create_shipping_document`. O segundo a chegar espera o primeiro e cai na
   * idempotência de `generateLabelForOrderUnlocked`, devolvendo `reused: true`.
   *
   * Escopo: PROCESSO. A API roda como uma instância única no pm2
   * (`dexo-api`, modo fork), então isso cobre o caso real. Duas instâncias
   * exigiriam lock distribuído — a idempotência por `ShipmentLabel` continua
   * sendo a rede de proteção nesse cenário.
   */
  private static orderLocks = new Map<string, Promise<unknown>>();

  private static async withOrderLock<T>(
    orderId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = this.orderLocks.get(orderId) ?? Promise.resolve();
    // `catch` para que a falha de quem está na frente não derrube quem espera.
    const current = previous.catch(() => undefined).then(fn);
    this.orderLocks.set(orderId, current);
    try {
      return await current;
    } finally {
      // Só limpa se ninguém entrou depois — senão apagaria a corrente do outro.
      if (this.orderLocks.get(orderId) === current) {
        this.orderLocks.delete(orderId);
      }
    }
  }

  private static async generateLabelForOrderUnlocked(
    userId: string,
    orderId: string,
    size: LabelSize,
  ): Promise<GenerateLabelResult> {
    const ctx = await this.resolveContext(userId, orderId);

    const existing = await shipmentLabelRepository.findByOrderId(orderId);
    if (
      existing?.labelStatus === "GENERATED" &&
      existing.labelSize === size &&
      existing.labelPdfPath
    ) {
      const cached = await this.labelStorage.readFile(existing.labelPdfPath);
      if (cached) {
        return { record: existing, pdf: cached, reused: true };
      }
    }

    const raw = await this.produceRawLabel(ctx, size);
    return this.finalizeLabel(userId, ctx, raw, size);
  }

  /**
   * Lote: processa cada pedido isoladamente (falhas em `failures[]` sem derrubar
   * os demais) e devolve UM PDF combinado. THERMAL = etiquetas 10×15 em
   * sequência; A4 = composição 3 por folha. Cada pedido também é salvo
   * individualmente (permite baixar depois pelo detalhe do pedido).
   */
  static async generateLabelsBatch(
    userId: string,
    orderIds: string[],
    size: LabelSize,
  ): Promise<BatchLabelResult> {
    // Worker pool com concorrência limitada (mesmo padrão de
    // MLApiService.getItemsDetails). Preserva a ORDEM no PDF combinado
    // (results[i]) e as falhas parciais — saída idêntica ao sequencial, só mais
    // rápido. Seguro p/ ML (refresh com mutex in-flight por conta) e a
    // concorrência baixa evita rate limit. O refresh da Shopee também é
    // serializado por shopId desde ShopeeOAuthService.refreshAccessToken
    // (kill-switch SHOPEE_REFRESH_MUTEX_DISABLED), então lote 100% Shopee da
    // mesma conta não dispara refresh concorrente.
    const BATCH_CONCURRENCY = 5;
    const results: (Buffer | null)[] = new Array(orderIds.length).fill(null);
    const failures: BatchLabelFailure[] = [];
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        const i = nextIndex++;
        if (i >= orderIds.length) break;
        const orderId = orderIds[i];
        try {
          const ctx = await this.resolveContext(userId, orderId);
          const raw = await this.produceRawLabel(ctx, size);
          await this.finalizeLabel(userId, ctx, raw, size);
          results[i] = raw;
        } catch (error) {
          failures.push({
            orderId,
            code:
              error instanceof ShippingLabelError ? error.code : undefined,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(BATCH_CONCURRENCY, orderIds.length) }, () =>
        worker(),
      ),
    );

    const raws = results.filter((r): r is Buffer => r !== null);
    let pdf: Buffer | null = null;
    if (raws.length > 0) {
      const merged = await mergePdfs(raws);
      pdf = size === "A4" ? await composeA4(merged, 3) : merged;
    }
    return { pdf, count: raws.length, failures };
  }

  /** Lê o PDF de etiqueta já gerado do pedido (escopo multi-tenant por userId). */
  static async getStoredLabelPdf(
    userId: string,
    orderId: string,
  ): Promise<{ pdf: Buffer; record: ShipmentLabelRecord } | null> {
    const owned = await prisma.order.findFirst({
      where: { id: orderId, marketplaceAccount: { userId } },
      select: { id: true },
    });
    if (!owned) {
      throw new ShippingLabelError("ORDER_NOT_FOUND", "Pedido não encontrado");
    }
    const record = await shipmentLabelRepository.findByOrderId(orderId);
    if (!record?.labelPdfPath) return null;
    const pdf = await this.labelStorage.readFile(record.labelPdfPath);
    if (!pdf) return null;
    return { pdf, record };
  }
}
