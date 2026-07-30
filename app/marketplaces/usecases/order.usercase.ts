/**
 * OrderUseCase - Orquestração de importação e gestão de pedidos
 *
 * Responsabilidades:
 * - Importar pedidos do Mercado Livre
 * - Vincular itens do pedido aos produtos locais (por SKU)
 * - Descontar estoque automaticamente ao importar pedidos pagos
 * - Registrar logs de estoque e sincronização
 */

import prisma from "@/app/lib/prisma";
import { Platform, SyncType, SyncStatus } from "@prisma/client";
import { MLApiService } from "../services/ml-api.service";
import { MLOAuthService } from "../services/ml-oauth.service";
import { ShopeeApiService } from "../services/shopee-api.service";
import { ShopeeOAuthService } from "../services/shopee-oauth.service";
import { MagaluApiService } from "../services/magalu-api.service";
import { MagaluOAuthService } from "../services/magalu-oauth.service";
import {
  StockDeductionService,
  type StockDeductionResult,
  type StockOversellAlert,
} from "../services/stock-deduction.service";
import { ListingRepository } from "../repositories/listing.repository";
import { MarketplaceRepository } from "../repositories/marketplace.repository";
import { OrderCustomerService } from "../services/order-customer.service";
import { SyncUseCase } from "./sync.usercase";
import { orderRepository } from "@/app/repositories/order.repository";
import { normalizeSku } from "@/app/lib/sku";
import type { MLOrderDetails, MLOrderItem } from "../types/ml-order.types";
import type {
  ShopeeOrderDetail,
  ShopeeOrderItem,
} from "../types/shopee-api.types";
import type { MagaluOrder, MagaluOrderItem } from "../types/magalu-order.types";
import {
  extractMagaluOrderItems,
  magaluMoneyToNumber,
} from "../types/magalu-order.types";
import type {
  OrderCreate,
  OrderItemCreate,
  Order,
  OrderStatus,
} from "@/app/interfaces/order.interface";
import { SystemLogService } from "@/app/services/system-log.service";
import { OrderIngestionIssueService } from "../services/order-ingestion-issue.service";

// ====================================================================
// TIPOS PARA RESULTADOS
// ====================================================================

export interface ImportOrderResult {
  success: boolean;
  orderId: string | null;
  externalOrderId: string;
  status: "imported" | "already_exists" | "no_products" | "error";
  message: string;
  stockDeducted: boolean;
  itemsLinked: number;
  itemsTotal: number;
}

export interface ImportOrdersResult {
  totalOrders: number;
  imported: number;
  alreadyExists: number;
  noProducts: number;
  errors: number;
  stockDeductions: number;
  /**
   * Pedidos que a importacao descartou por status fora da janela de venda
   * confirmada (PAID/SHIPPED/DELIVERED). Antes esse descarte era um `continue`
   * mudo: um vocabulario de status inesperado zerava a importacao sem deixar
   * rastro. Opcional para nao alterar o shape de quem ja consome o resultado.
   */
  skippedByStatus?: number;
  /**
   * Os rotulos de status crus que causaram descarte, de-duplicados. E o dado
   * que responde "a API mudou o vocabulario?" sem precisar de um pedido real.
   */
  skippedStatuses?: string[];
  results: ImportOrderResult[];
}

export interface OrderStockDeduction {
  productId: string;
  productName: string;
  previousStock: number;
  newStock: number;
  quantity: number;
}

export interface OrderCancellationResult {
  success: boolean;
  orderId: string | null;
  externalOrderId: string;
  action:
    | "disabled"
    | "not_found"
    | "already_cancelled"
    | "cancelled_restored"
    | "cancelled_no_restore"
    | "error";
  restoredItems: number;
  message?: string;
}

export interface OrderUncancellationResult {
  success: boolean;
  orderId: string | null;
  externalOrderId: string;
  action:
    | "disabled"
    | "not_found"
    | "not_cancelled"
    | "reactivated_rededucted"
    | "reactivated_no_deduct"
    | "error";
  deductedItems: number;
  message?: string;
}

interface SyncLogContext {
  orderId?: string;
  platform?: string | null;
}

// ====================================================================
// USE CASE
// ====================================================================

export class OrderUseCase {
  /**
   * Pedidos Magalu já reportados como "sem produto vinculado", por processo.
   *
   * Existe para não repetir o alerta a cada ciclo do poll: um pedido sem
   * vínculo nunca vira Order, então reaparece em todas as passagens enquanto
   * estiver na janela de data. Memória: só os ids da janela corrente (7 dias)
   * de pedidos órfãos — na prática dezenas, no pior caso.
   */
  private static readonly magaluNoProductsLogged = new Set<string>();

  /**
   * Importa pedidos recentes do Mercado Livre
   * @param userId ID do usuário
   * @param days Número de dias para trás (padrão: 7)
   * @param deductStock Se deve descontar estoque automaticamente (padrão: true)
   */
  static async importRecentOrders(
    userId: string,
    days: number = 7,
    deductStock: boolean = true,
  ): Promise<ImportOrdersResult> {
    const aggregated: ImportOrdersResult = {
      totalOrders: 0,
      imported: 0,
      alreadyExists: 0,
      noProducts: 0,
      errors: 0,
      stockDeductions: 0,
      results: [],
    };

    const accounts = await MarketplaceRepository.findAllByUserIdAndPlatform(
      userId,
      Platform.MERCADO_LIVRE,
    );

    const validAccounts =
      accounts?.filter((acc) => acc.accessToken && acc.externalUserId) ?? [];

    if (validAccounts.length === 0) {
      throw new Error(
        "Conta do Mercado Livre não conectada ou sem credenciais",
      );
    }

    for (const account of validAccounts) {
      try {
        const result = await this.importRecentOrdersForAccount(
          account.id,
          days,
          deductStock,
        );

        aggregated.totalOrders += result.totalOrders;
        aggregated.imported += result.imported;
        aggregated.alreadyExists += result.alreadyExists;
        aggregated.noProducts += result.noProducts;
        aggregated.errors += result.errors;
        aggregated.stockDeductions += result.stockDeductions;
        aggregated.results.push(...result.results);
      } catch (error) {
        aggregated.errors += 1;
        aggregated.results.push({
          success: false,
          orderId: null,
          externalOrderId: `ACCOUNT_${account.id}`,
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Erro ao importar conta Mercado Livre",
          stockDeducted: false,
          itemsLinked: 0,
          itemsTotal: 0,
        });
      }
    }

    return aggregated;
  }

  /**
   * Importa pedidos recentes do Mercado Livre para uma conta específica
   */
  static async importRecentOrdersForAccount(
    marketplaceAccountId: string,
    days: number = 7,
    deductStock: boolean = true,
    maxOrders: number = 500,
  ): Promise<ImportOrdersResult> {
    const account = await MarketplaceRepository.findById(marketplaceAccountId);
    if (!account || !account.accessToken || !account.externalUserId) {
      throw new Error(
        "Conta do Mercado Livre não conectada ou sem credenciais",
      );
    }

    const result: ImportOrdersResult = {
      totalOrders: 0,
      imported: 0,
      alreadyExists: 0,
      noProducts: 0,
      errors: 0,
      stockDeductions: 0,
      results: [],
    };

    const mlOrders = await this.getRecentMLOrdersWithRefresh(
      {
        id: account.id,
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        externalUserId: account.externalUserId,
      },
      days,
      maxOrders,
    );

    result.totalOrders = mlOrders.length;

    // Batch check + prefetch (same optimization as importRecentOrders).
    // Escopado por marketplaceAccountId — o unique é composto, não global.
    const externalIds = mlOrders.map((o) => o.id.toString());
    const existingOrders = await prisma.order.findMany({
      where: {
        marketplaceAccountId: account.id,
        externalOrderId: { in: externalIds },
      },
      // EGRESS: `id` e `status` no select JA existente (dois textos curtos por
      // pedido da janela) — e o que permite descobrir os pedidos sem item por
      // Index Only Scan em OrderItem_orderId_idx, em vez do `Seq Scan` da
      // OrderItem inteira que o `items: { none: {} }` do Prisma produz. Medido:
      // 0,333 ms contra 3,496 ms. Ver `pedidosVaziosNaJanela`.
      select: { id: true, externalOrderId: true, status: true },
    });
    const existingSet = new Set(existingOrders.map((o) => o.externalOrderId));

    // EGRESS: o listingMap só é consumido por processOrder, que só roda para
    // pedidos NOVOS. Em regime estável (nenhum pedido novo no ciclo) NÃO relemos
    // todos os anúncios da conta (com product) — antes isso era feito a cada
    // ciclo de 15 min por conta, relendo o catálogo inteiro = grosso do egress.
    // Comportamento idêntico: quando há pedido novo, o mapa é montado igual.
    const hasNewOrders = mlOrders.some(
      (o) => !existingSet.has(o.id.toString()),
    );
    const listingMap = new Map<string, any>();
    if (hasNewOrders) {
      const accountListings = await prisma.productListing.findMany({
        where: { marketplaceAccountId: account.id },
        // EGRESS: select mínimo. mapOrderItems/mapShopeeOrderItems usam APENAS
        // listing.id, listing.productId e checam se listing.product EXISTE —
        // nenhum campo do product é lido. Antes o include puxava o product
        // inteiro (name/description/imageUrl/...) de TODOS os anúncios.
        select: {
          id: true,
          productId: true,
          marketplaceAccountId: true,
          externalListingId: true,
          product: { select: { id: true } },
        },
      });
      for (const l of accountListings) {
        listingMap.set(`${l.marketplaceAccountId}_${l.externalListingId}`, l);
      }
    }

    // Pedidos que existem localmente com ZERO itens: a venda esta registrada e o
    // estoque nunca baixou. Sem este passo o `already_exists` abaixo os pularia
    // para sempre (ver `completarOrderSemItens`).
    const vaziosPorExtId = await this.pedidosVaziosNaJanela(existingOrders);

    for (const mlOrder of mlOrders) {
      const extId = mlOrder.id.toString();
      if (existingSet.has(extId)) {
        const orderVazioId = vaziosPorExtId.get(extId);
        if (orderVazioId) {
          // `listingMap` fica de fora de proposito: aqui sao um ou dois pedidos,
          // e o mapper faz o findUnique por item. Passar o mapa deste ciclo seria
          // pior de duas formas — ele so e montado quando ha pedido NOVO, e um
          // mapa vazio faz todo `.get()` devolver undefined, tratando como nao
          // vinculado um item que TEM anuncio no banco.
          const { items } = await this.mapOrderItems(
            mlOrder.order_items,
            account.userId,
            account.id,
            undefined,
          );
          const desfecho = await this.completarOrderSemItens({
            plataforma: "MERCADO_LIVRE",
            marketplaceAccountId: account.id,
            externalOrderId: extId,
            orderId: orderVazioId,
            itens: items,
            itemsTotal: mlOrder.order_items.length,
            esperavaBaixa: deductStock && mlOrder.status === "paid",
          });
          result.results.push(desfecho);
          if (desfecho.status === "imported") {
            result.imported++;
            if (desfecho.stockDeducted) result.stockDeductions++;
          } else if (desfecho.status === "no_products") {
            // Continua sendo perda: a venda esta la e o estoque nao baixou. O
            // ciclo tem de ser rebaixado para WARNING.
            result.noProducts++;
          } else {
            result.alreadyExists++;
          }
          continue;
        }
        result.alreadyExists++;
        result.results.push({
          success: true,
          orderId: null,
          externalOrderId: extId,
          status: "already_exists",
          message: "Pedido já importado anteriormente",
          stockDeducted: false,
          itemsLinked: 0,
          itemsTotal: mlOrder.order_items.length,
        });
        continue;
      }

      const importResult = await this.processOrder(
        mlOrder,
        account.id,
        deductStock,
        listingMap,
        account.userId,
      );
      result.results.push(importResult);

      switch (importResult.status) {
        case "imported":
          result.imported++;
          if (importResult.stockDeducted) {
            result.stockDeductions++;
          }
          // ADITIVO (auto-cliente): best-effort, nunca afeta o import.
          // Kill-switch ORDER_AUTO_CUSTOMER_DISABLED=1 restaura o caminho
          // atual byte-idêntico. Sequencial (await) para o 2º pedido do mesmo
          // comprador no batch deduplicar contra o 1º.
          if (importResult.orderId) {
            try {
              await OrderCustomerService.ensureCustomerForOrder({
                platform: "MERCADO_LIVRE",
                marketplaceAccountId: account.id,
                orderId: importResult.orderId,
                externalOrderId: importResult.externalOrderId,
                fallbackName: this.extractCustomerName(mlOrder) ?? null,
              });
            } catch {
              /* nunca propaga — um throw aqui abortaria o batch inteiro */
            }
          }
          break;
        case "already_exists":
          result.alreadyExists++;
          break;
        case "no_products":
          result.noProducts++;
          break;
        case "error":
          result.errors++;
          break;
      }

      // Quarentena do ML. Antes deste ponto, um pedido do ML que não vinculasse
      // ou que não baixasse estoque não deixava rastro nenhum.
      await this.registrarDesfechoIngestao({
        platform: "MERCADO_LIVRE",
        marketplaceAccountId: account.id,
        resultado: importResult,
        esperavaBaixa: deductStock && mlOrder.status === "paid",
      });
    }

    // Veredito honesto (auditoria 29/07/2026): antes só `errors` rebaixava o
    // ciclo, então uma passada que perdeu pedidos por falta de vínculo era
    // gravada como SUCCESS — e "sincronizado sem erro" é exatamente o que o
    // cliente não podia ler nesse caso. `noProducts` conta como perda: são
    // vendas que não viraram Order.
    const perdeuAlgo = result.errors > 0 || result.noProducts > 0;
    await this.logSync(
      account.id,
      SyncType.ORDER_IMPORT,
      perdeuAlgo ? SyncStatus.WARNING : SyncStatus.SUCCESS,
      `Importados ${result.imported} de ${result.totalOrders} pedidos do ML (account import)` +
        (result.noProducts > 0
          ? `; ${result.noProducts} sem vinculo de produto (em quarentena)`
          : ""),
      {
        totalOrders: result.totalOrders,
        imported: result.imported,
        alreadyExists: result.alreadyExists,
        errors: result.errors,
        noProducts: result.noProducts,
      },
    );

    return result;
  }

  /**
   * Importa pedidos recentes do Shopee (todas as contas ativas do usuário)
   */
  static async importRecentShopeeOrders(
    userId: string,
    days: number = 3,
    deductStock: boolean = true,
  ): Promise<ImportOrdersResult> {
    const accounts = await MarketplaceRepository.findAllByUserIdAndPlatform(
      userId,
      Platform.SHOPEE,
    );

    const validAccounts =
      accounts?.filter((acc) => acc.accessToken && acc.shopId) ?? [];

    if (validAccounts.length === 0) {
      throw new Error("Conta do Shopee não conectada ou sem credenciais");
    }

    const aggregated: ImportOrdersResult = {
      totalOrders: 0,
      imported: 0,
      alreadyExists: 0,
      noProducts: 0,
      errors: 0,
      stockDeductions: 0,
      results: [],
    };

    // Executa sequencialmente para evitar estouro de rate limit
    for (const account of validAccounts) {
      try {
        const result = await this.importRecentShopeeOrdersForAccount(
          account.id,
          days,
          deductStock,
        );

        aggregated.totalOrders += result.totalOrders;
        aggregated.imported += result.imported;
        aggregated.alreadyExists += result.alreadyExists;
        aggregated.noProducts += result.noProducts;
        aggregated.errors += result.errors;
        aggregated.stockDeductions += result.stockDeductions;
        aggregated.results.push(...result.results);
      } catch (error) {
        aggregated.errors += 1;
        aggregated.results.push({
          success: false,
          orderId: null,
          externalOrderId: `ACCOUNT_${account.id}`,
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Erro ao importar conta Shopee",
          stockDeducted: false,
          itemsLinked: 0,
          itemsTotal: 0,
        });
      }
    }

    return aggregated;
  }

  /**
   * Importa pedidos recentes do Shopee para uma conta específica.
   *
   * `options.orderSns` busca pedidos específicos ALÉM da janela — é o que o
   * webhook usa, já que a Shopee informa no push qual pedido mudou.
   */
  static async importRecentShopeeOrdersForAccount(
    marketplaceAccountId: string,
    days: number = 3,
    deductStock: boolean = true,
    options?: { orderSns?: string[] },
  ): Promise<ImportOrdersResult> {
    const account = await MarketplaceRepository.findById(marketplaceAccountId);
    if (!account || !account.accessToken || !account.shopId) {
      throw new Error("Conta Shopee não encontrada ou sem credenciais");
    }

    const result: ImportOrdersResult = {
      totalOrders: 0,
      imported: 0,
      alreadyExists: 0,
      noProducts: 0,
      errors: 0,
      stockDeductions: 0,
      results: [],
    };

    // Kill-switch: com "1", volta à janela por `create_time` e à whitelist
    // fechada de status — comportamento anterior, byte-idêntico.
    const byUpdateTime =
      process.env.SHOPEE_ORDER_SYNC_BY_UPDATE_TIME_DISABLED !== "1";

    const windowEnd = new Date();
    const watermark = (account as { shopeeOrdersSyncedThrough?: Date | null })
      .shopeeOrdersSyncedThrough;
    // Sobreposição de 6 h sobre a marca d'água: cobre desvio de relógio entre
    // nós e a Shopee e o atraso de indexação dela.
    //
    // É `min` (e não `max`) de propósito: a marca d'água aqui serve para
    // ALARGAR a janela, nunca para estreitá-la. A janela por dias segue sendo
    // o piso, então este caminho jamais varre MENOS do que o anterior. O ganho
    // real aparece quando o processo fica fora do ar por mais tempo que
    // `days` — aí a marca d'água puxa a busca para trás e recupera o atraso
    // (o serviço clampa em 15 dias, que é o teto da API).
    const OVERLAP_SEC = 6 * 60 * 60;
    const windowFloorSec =
      Math.floor(windowEnd.getTime() / 1000) - days * 24 * 60 * 60;
    const timeFrom =
      byUpdateTime && watermark
        ? Math.min(
            Math.floor(watermark.getTime() / 1000) - OVERLAP_SEC,
            windowFloorSec,
          )
        : undefined;

    const skippedStatuses = new Set<string>();
    let skippedByStatus = 0;
    /**
     * Vira true quando a varredura NÃO cobriu todo o período pedido (marca
     * d'água velha além do teto de blocos). A marca d'água não pode avançar
     * nesse caso: declararia como sincronizado um intervalo que ninguém leu.
     */
    let janelaTruncada = false;
    /** `order_sn` listados pela Shopee cujo detalhe não voltou. */
    const semDetalhe: string[] = [];

    // Com o kill-switch ligado E sem busca dirigida, nenhuma opção é passada:
    // a chamada a getRecentOrders fica com os mesmos 3 argumentos de antes.
    const fetchOptions =
      byUpdateTime || options?.orderSns?.length
        ? {
            timeFrom,
            timeRangeField: byUpdateTime ? ("update_time" as const) : undefined,
            statusFilter: byUpdateTime
              ? ("exclude_non_sale" as const)
              : ("legacy_whitelist" as const),
            onStatusSkipped: (orderSn: string, status: string) => {
              skippedByStatus++;
              if (status) skippedStatuses.add(status);
            },
            onDetailMissing: (sns: string[]) => {
              semDetalhe.push(...sns);
            },
            onWindowTruncated: (info: { desdeSec: number; ateSec: number }) => {
              janelaTruncada = true;
              console.log(
                JSON.stringify({
                  event: "shopee.order_import.window_truncated",
                  marketplaceAccountId,
                  desde: new Date(info.desdeSec * 1000).toISOString(),
                  ate: new Date(info.ateSec * 1000).toISOString(),
                }),
              );
            },
            orderSns: options?.orderSns,
          }
        : undefined;

    const shopeeOrders = await this.getRecentShopeeOrdersWithRefresh(
      {
        id: account.id,
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        shopId: account.shopId,
      },
      days,
      fetchOptions,
    );

    result.totalOrders = shopeeOrders.length;
    if (skippedByStatus > 0) {
      result.skippedByStatus = skippedByStatus;
      result.skippedStatuses = [...skippedStatuses];
    }

    // Batch check + prefetch (same optimization as ML imports).
    // Escopado por marketplaceAccountId — o unique é composto, não global.
    const externalIds = (shopeeOrders as ShopeeOrderDetail[]).map(
      (o) => o.order_sn,
    );
    const existingOrders = await prisma.order.findMany({
      where: {
        marketplaceAccountId: account.id,
        externalOrderId: { in: externalIds },
      },
      // EGRESS: `id` e `status` junto — ver a nota em `pedidosVaziosNaJanela`.
      select: { id: true, externalOrderId: true, status: true },
    });
    const existingSet = new Set(existingOrders.map((o) => o.externalOrderId));

    // EGRESS: idem ML — só relê todos os anúncios da conta (com product) se
    // houver pedido novo no ciclo (listingMap só é usado em pedidos novos).
    const hasNewOrders = (shopeeOrders as ShopeeOrderDetail[]).some(
      (o) => !existingSet.has(o.order_sn),
    );
    const listingMap = new Map<string, any>();
    // Busca DIRIGIDA (webhook, reconciliador, script) traz 1 ou 2 pedidos. Ler os
    // anuncios todos da conta para montar o mapa custa mais do que a consulta por
    // item que o fallback faz: numa conta de producao com 11.670 ProductListing
    // sao ~1,6 MB de egress por chamada, contra 1-2 findUnique por id. O
    // resultado e identico — `mapShopeeOrderItems` sem mapa faz o mesmo lookup,
    // um a um (convencao 9 do repo: nao carregar colecao grande fora do caminho
    // que precisa dela).
    const vaiUsarMapa = hasNewOrders && !options?.orderSns?.length;
    if (vaiUsarMapa) {
      const accountListings = await prisma.productListing.findMany({
        where: { marketplaceAccountId: account.id },
        // EGRESS: select mínimo. mapOrderItems/mapShopeeOrderItems usam APENAS
        // listing.id, listing.productId e checam se listing.product EXISTE —
        // nenhum campo do product é lido. Antes o include puxava o product
        // inteiro (name/description/imageUrl/...) de TODOS os anúncios.
        select: {
          id: true,
          productId: true,
          marketplaceAccountId: true,
          externalListingId: true,
          product: { select: { id: true } },
        },
      });
      for (const l of accountListings) {
        listingMap.set(`${l.marketplaceAccountId}_${l.externalListingId}`, l);
      }
    }

    // Pedidos que existem local com ZERO itens. Na Shopee o reconciliador
    // resolve isso re-buscando o pedido por `order_sn`, mas SO enquanto a
    // pendencia esta OPEN: ao virar NEEDS_ACTION ela sai da fila automatica, e a
    // partir dai o cliente cadastrar o produto nao completava mais nada — o poll
    // caia em `already_exists` e o pedido ficava sem baixa para sempre. Aqui o
    // pedido ja veio da API neste ciclo, entao completar nao custa chamada
    // externa nenhuma.
    const vaziosPorExtId = await this.pedidosVaziosNaJanela(existingOrders);

    for (const shopeeOrder of shopeeOrders as ShopeeOrderDetail[]) {
      const orderVazioId = vaziosPorExtId.get(shopeeOrder.order_sn);
      const entry = orderVazioId
        ? await this.completarPedidoVazioShopee(
            marketplaceAccountId,
            shopeeOrder,
            orderVazioId,
            account.userId,
            deductStock,
          )
        : await this.ingestShopeeOrder(marketplaceAccountId, shopeeOrder, {
            userId: account.userId,
            deductStock,
            alreadyExists: existingSet.has(shopeeOrder.order_sn),
            // `undefined` (nao um Map vazio) quando o mapa nao foi montado: o
            // Map vazio faria todo `.get()` devolver undefined e o item cairia
            // como NAO vinculado, sem nem tentar o lookup por id.
            listingMap: vaiUsarMapa ? listingMap : undefined,
          });

      result.results.push(entry);
      switch (entry.status) {
        case "already_exists":
          result.alreadyExists++;
          break;
        case "no_products":
          result.noProducts++;
          break;
        case "imported":
          result.imported++;
          result.stockDeductions += entry.stockDeducted ? 1 : 0;
          break;
        case "error":
          result.errors++;
          break;
      }
    }

    // Pedido que a Shopee listou e cujo detalhe não voltou é venda que ela
    // conhece e nós não. Antes desaparecia sem contador e sem afetar o veredito
    // do ciclo. Conta como erro: a marca d'água não avança e a próxima passada
    // tenta de novo.
    if (semDetalhe.length) {
      result.errors += semDetalhe.length;
      console.log(
        JSON.stringify({
          event: "shopee.order_import.detail_missing",
          marketplaceAccountId,
          orderSns: semDetalhe.slice(0, 50),
          total: semDetalhe.length,
        }),
      );
    }

    // Marca d'água só avança em ciclo limpo: se um pedido deu erro, refazer a
    // janela na próxima volta é mais barato do que pular a venda dele.
    //
    // Três condições a mais, todas da auditoria de 29/07/2026:
    //  - `!options?.orderSns?.length`: a busca dirigida NÃO varre a janela, então
    //    não pode declarar a janela sincronizada. Era o caso do reconciliador e
    //    do webhook, que avançavam a marca d'água sem ter lido o período.
    //  - `!janelaTruncada`: se a varredura não alcançou o início pedido, existe
    //    um intervalo não lido. Avançar aqui tornava a perda permanente.
    //  - `!result.noProducts`/`partialLinks` seguem fora de propósito: esses
    //    pedidos JÁ estão na quarentena, que é quem os re-tenta.
    if (
      byUpdateTime &&
      result.errors === 0 &&
      !options?.orderSns?.length &&
      !janelaTruncada
    ) {
      try {
        await prisma.marketplaceAccount.update({
          where: { id: marketplaceAccountId },
          data: { shopeeOrdersSyncedThrough: windowEnd },
        });
      } catch (err) {
        // Perder a marca d'água só custa uma janela maior no próximo ciclo.
        console.warn(
          `[OrderUseCase] Falha ao gravar marca d'agua de pedidos Shopee (conta ${marketplaceAccountId}):`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // SyncLog honesto. Antes o status vinha SÓ de `errors`: um ciclo em que
    // 100% dos pedidos foram descartados por falta de vínculo gravava SUCCESS
    // com "Importados 0 de 37 pedidos do Shopee", e `noProducts` não ia nem
    // para o payload — o número de pedidos perdidos não ficava em lugar nenhum.
    // "Sucesso" agora só quando de fato não se perdeu nada.
    const partialLinks = result.results.filter(
      (r) => r.status === "imported" && r.itemsLinked < r.itemsTotal,
    ).length;
    // Só conta como falha de baixa quando a baixa foi PEDIDA. Com
    // deductStock=false (opção da rota /orders/import) nenhum pedido baixa por
    // definição, e contar isso como falha marcaria WARNING em toda importação.
    const stockDeductionFailures = deductStock
      ? result.results.filter((r) => r.status === "imported" && !r.stockDeducted)
          .length
      : 0;
    const perdeuAlgo =
      result.errors > 0 ||
      result.noProducts > 0 ||
      partialLinks > 0 ||
      stockDeductionFailures > 0;

    await this.logSync(
      marketplaceAccountId,
      SyncType.ORDER_IMPORT,
      perdeuAlgo ? SyncStatus.WARNING : SyncStatus.SUCCESS,
      `Importados ${result.imported} de ${result.totalOrders} pedidos do Shopee`,
      {
        totalOrders: result.totalOrders,
        imported: result.imported,
        alreadyExists: result.alreadyExists,
        errors: result.errors,
        noProducts: result.noProducts,
        partialLinks,
        stockDeductionFailures,
        ...(result.skippedByStatus
          ? {
              skippedByStatus: result.skippedByStatus,
              skippedStatuses: result.skippedStatuses,
            }
          : {}),
      },
    );

    return result;
  }

  /**
   * Ingere UM pedido Shopee. Extraído do laço de
   * `importRecentShopeeOrdersForAccount` sem mudar comportamento: mesma ordem
   * de operações, mesmos textos, mesmo tratamento de P2002.
   *
   * Existe para haver um ÚNICO ponto de ingestão por plataforma — usado pelo
   * poll, pela busca dirigida do webhook e pelo script de recuperação. Retorna
   * a entrada de resultado; quem chama contabiliza.
   */
  static async ingestShopeeOrder(
    marketplaceAccountId: string,
    shopeeOrder: ShopeeOrderDetail,
    ctx: {
      userId: string;
      deductStock: boolean;
      alreadyExists: boolean;
      listingMap?: Map<string, any>;
    },
  ): Promise<ImportOrderResult> {
    const externalOrderId = shopeeOrder.order_sn;
    const itemsTotal = shopeeOrder.item_list?.length ?? 0;

    try {
      if (ctx.alreadyExists) {
        return {
          success: true,
          orderId: null,
          externalOrderId,
          status: "already_exists",
          message: "Pedido já importado anteriormente",
          stockDeducted: false,
          itemsLinked: 0,
          itemsTotal,
        };
      }

      const { items, linkedCount, unlinked } = await this.mapShopeeOrderItems(
        shopeeOrder.item_list,
        ctx.userId,
        marketplaceAccountId,
        ctx.listingMap,
      );

      if (items.length === 0) {
        // NUNCA descartar em silêncio: sem isto o pedido some — não vira Order,
        // não aparece em /pedidos e o SyncLog do ciclo fica SUCCESS.
        //
        // Mas registrar a pendência não bastava. Medição em produção
        // (29/07/2026): 89 vendas concretizadas de 3 tenants presas aqui, sendo
        // 26 de um só cliente em 12 dias. Nenhuma existia como Order, logo
        // nenhuma aparecia em /pedidos, no Financeiro nem no Dashboard: a venda
        // acontecia e o faturamento do cliente ficava incompleto. O produto
        // realmente não existe no Dexo (conferido contra o banco: item_id, SKU
        // exato, skuNormalized e partNumber, todos zero), então não há estoque a
        // baixar — mas a VENDA existe, e o invariante manda ela virar Order.
        //
        // Order com ZERO itens, portanto: carrega o valor da venda e fica
        // visível. A pendência continua aberta para a parte do estoque, e quando
        // o cliente cadastrar o produto o reconciliador acrescenta o item
        // (completePartialShopeeOrder) e baixa (retryStockDeduction) sozinho —
        // é a máquina que já existe, sem caminho novo.
        //
        // Continua contando como `no_products`: o ciclo rebaixa para WARNING,
        // porque estoque nenhum foi baixado. Nada de "sincronizado sem erro".
        const orderSemItens = await this.criarOrderSemItens({
          marketplaceAccountId,
          externalOrderId,
          status: this.mapShopeeStatus(shopeeOrder.order_status),
          totalAmount:
            typeof shopeeOrder.total_amount === "number"
              ? Number(shopeeOrder.total_amount)
              : 0,
          customerName: shopeeOrder.buyer_username ?? undefined,
          soldAt: this.resolveSoldAt(shopeeOrder.create_time),
          plataforma: "SHOPEE",
          itemsTotal,
        });

        await OrderIngestionIssueService.open({
          marketplaceAccountId,
          platform: "SHOPEE",
          externalOrderId,
          reason: "NO_LINKED_ITEMS",
          detail: this.describeUnlinked(unlinked),
          payload: shopeeOrder,
          orderId: orderSemItens,
        });

        return {
          success: false,
          orderId: orderSemItens,
          externalOrderId,
          status: "no_products",
          message: orderSemItens
            ? "Nenhum item do pedido Shopee pôde ser vinculado; venda registrada sem itens e sem baixa"
            : "Nenhum item do pedido Shopee pôde ser vinculado",
          stockDeducted: false,
          itemsLinked: 0,
          itemsTotal,
        };
      }

      const totalAmount =
        typeof shopeeOrder.total_amount === "number"
          ? Number(shopeeOrder.total_amount)
          : items.reduce((sum, it) => sum + it.unitPrice * it.quantity, 0);

      const orderData: OrderCreate = {
        marketplaceAccountId,
        externalOrderId,
        status: this.mapShopeeStatus(shopeeOrder.order_status),
        totalAmount,
        customerName: shopeeOrder.buyer_username ?? undefined,
        soldAt: this.resolveSoldAt(shopeeOrder.create_time),
        items,
      };

      const created = await orderRepository.create(orderData);

      let stockDeducted = false;
      // getRecentOrders() já retorna apenas pedidos em estados pós-venda.
      // Não repetir a decisão de baixa com base no status local mapeado.
      if (ctx.deductStock) {
        try {
          await this.deductStockForOrder(
            created,
            `Venda Shopee #${externalOrderId}`,
          );
          stockDeducted = true;
        } catch (err) {
          console.error(
            `[OrderUseCase] Falha ao descontar estoque para pedido Shopee #${externalOrderId} (order=${created.id}). Estoque NÃO foi descontado.`,
            err,
          );
          // Antes parava aqui: o Order ficava visível na tela com o estoque
          // intacto e ninguém tentava de novo — na passada seguinte o pedido
          // caía em `already_exists`. Agora o reconciliador re-tenta só a
          // baixa, usando o net do StockLog para não baixar duas vezes.
          await OrderIngestionIssueService.open({
            marketplaceAccountId,
            platform: "SHOPEE",
            externalOrderId,
            reason: "STOCK_DEDUCTION_FAILED",
            detail: err instanceof Error ? err.message : String(err),
            payload: shopeeOrder,
            orderId: created.id,
          });
        }
      }

      if (stockDeducted && linkedCount >= itemsTotal) {
        // Pedido completo e com baixa: se havia pendência dele, fecha.
        await OrderIngestionIssueService.resolve(
          marketplaceAccountId,
          externalOrderId,
          created.id,
        );
      } else if (!stockDeducted) {
        // A pendência da baixa já foi aberta acima com o motivo certo
        // (STOCK_DEDUCTION_FAILED). Abrir PARTIAL_LINK aqui sobrescreveria esse
        // motivo e mandaria o reconciliador pelo caminho errado — ele decide o
        // que fazer a partir do `reason`.
      } else if (linkedCount < itemsTotal) {
        // Pedido PARCIAL: o Order é criado com o que deu (comportamento
        // preservado), mas os itens que ficaram de fora nunca dariam baixa e
        // até agora isso não deixava rastro nenhum.
        await OrderIngestionIssueService.open({
          marketplaceAccountId,
          platform: "SHOPEE",
          externalOrderId,
          reason: "PARTIAL_LINK",
          detail: this.describeUnlinked(unlinked),
          payload: shopeeOrder,
          orderId: created.id,
        });
      }

      // ADITIVO (auto-cliente): best-effort, nunca afeta o import.
      // Kill-switch ORDER_AUTO_CUSTOMER_DISABLED=1 restaura o caminho atual
      // byte-idêntico. Try/catch próprio: um throw vazado cairia no catch
      // externo e empurraria um segundo result para o mesmo pedido.
      try {
        await OrderCustomerService.ensureCustomerForOrder({
          platform: "SHOPEE",
          marketplaceAccountId,
          orderId: created.id,
          externalOrderId,
          fallbackName: shopeeOrder.buyer_username ?? null,
        });
      } catch {
        /* nunca propaga */
      }

      return {
        success: true,
        orderId: created.id,
        externalOrderId,
        status: "imported",
        message: "Pedido Shopee importado com sucesso",
        stockDeducted,
        itemsLinked: linkedCount,
        itemsTotal,
      };
    } catch (error) {
      // Handle concurrent duplicate (P2002) gracefully as "already_exists"
      const isPrismaUniqueError =
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as any).code === "P2002";
      if (isPrismaUniqueError) {
        return {
          success: true,
          orderId: null,
          externalOrderId,
          status: "already_exists",
          message: "Pedido já importado (concurrent)",
          stockDeducted: false,
          itemsLinked: 0,
          itemsTotal,
        };
      }
      console.error("[OrderUseCase] Erro ao importar pedido Shopee:", error);
      await OrderIngestionIssueService.open({
        marketplaceAccountId,
        platform: "SHOPEE",
        externalOrderId,
        reason: "INGEST_FAILED",
        detail: error instanceof Error ? error.message : String(error),
        payload: shopeeOrder,
      });
      return {
        success: false,
        orderId: null,
        externalOrderId,
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "Erro desconhecido ao importar pedido Shopee",
        stockDeducted: false,
        itemsLinked: 0,
        itemsTotal,
      };
    }
  }

  /**
   * Completa um pedido Shopee que entrou PARCIAL: acrescenta ao `Order` que já
   * existe os itens que agora vinculam, e baixa só eles.
   *
   * Sem isto a pendência `PARTIAL_LINK` era insolúvel por construção — re-impor
   * um pedido existente devolve `already_exists` e nunca acrescenta item algum,
   * então o item que faltava jamais daria baixa, mesmo depois de o cliente
   * vincular o anúncio ao produto. A pendência ficaria para sempre na tela.
   *
   * Idempotente: só acrescenta produto que ainda não está no pedido, e a baixa
   * vai por `retryStockDeduction`, ancorada no net do StockLog.
   *
   * Retorna quantos itens foram acrescentados.
   */
  static async completePartialShopeeOrder(
    marketplaceAccountId: string,
    shopeeOrder: ShopeeOrderDetail,
    orderId: string,
    userId: string,
  ): Promise<number> {
    const { items } = await this.mapShopeeOrderItems(
      shopeeOrder.item_list,
      userId,
      marketplaceAccountId,
    );
    if (!items.length) return 0;

    return this.acrescentarItensAoPedido({
      orderId,
      externalOrderId: shopeeOrder.order_sn,
      itens: items,
      evento: "shopee.order_import.partial_completed",
    });
  }

  /**
   * Completa um pedido Shopee que existe com ZERO itens, usando o detalhe que o
   * poll acabou de trazer da API.
   *
   * Existe para o caso que o reconciliador nao cobre: pendencia em
   * `NEEDS_ACTION` (fora da fila automatica) ou pendencia ja fechada. O cliente
   * cadastra o produto e o proximo ciclo do poll completa o pedido sozinho, sem
   * uma unica chamada externa a mais — o pedido ja veio na varredura.
   */
  private static async completarPedidoVazioShopee(
    marketplaceAccountId: string,
    shopeeOrder: ShopeeOrderDetail,
    orderId: string,
    userId: string,
    deductStock: boolean,
  ): Promise<ImportOrderResult> {
    const { items, unlinked } = await this.mapShopeeOrderItems(
      shopeeOrder.item_list,
      userId,
      marketplaceAccountId,
    );

    return this.completarOrderSemItens({
      plataforma: "SHOPEE",
      marketplaceAccountId,
      externalOrderId: shopeeOrder.order_sn,
      orderId,
      itens: items,
      itemsTotal: shopeeOrder.item_list?.length ?? 0,
      // A listagem da Shopee ja devolve so pedido em estado pos-venda, entao
      // nao ha decisao de status a repetir aqui (mesma regra do
      // `ingestShopeeOrder`).
      esperavaBaixa: deductStock,
      payload: shopeeOrder,
      detalheSemVinculo: this.describeUnlinked(unlinked),
    });
  }

  /**
   * Insere no `Order` os itens que ainda nao estao nele, e devolve quantos
   * entraram.
   *
   * Extraido de `completePartialShopeeOrder` sem mudanca de comportamento: a
   * transacao, a ordem do lock e o log sao os mesmos. Passou a ser compartilhado
   * porque o ML e a Magalu precisam do mesmo passo (ver
   * `completarOrderSemItens`).
   *
   * "Ler os itens atuais e inserir o que falta" precisa ser ATOMICO. Nao existe
   * unique em (orderId, productId), entao duas execucoes concorrentes — o tick do
   * reconciliador e um clique em "Tentar novamente", que rodam em processos
   * diferentes — liam as duas o conjunto vazio e inseriam as duas o mesmo item. O
   * pedido ficava com a quantidade DOBRADA, e a baixa seguinte descontava o dobro
   * do estoque.
   *
   * O lock e na linha do Order (mesma ordem de lock do resto: Order antes de
   * Product) e o mapeamento dos itens fica FORA da transacao de proposito, para a
   * janela do lock ser so o read+insert.
   */
  private static async acrescentarItensAoPedido(params: {
    orderId: string;
    externalOrderId: string;
    itens: OrderItemCreate[];
    /** Nome do evento no log estruturado. */
    evento: string;
    /** Campos extra do log (plataforma, conta). */
    extra?: Record<string, unknown>;
  }): Promise<number> {
    const { orderId, itens } = params;
    if (!itens.length) return 0;

    const novos = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;

      const atuais = await tx.orderItem.findMany({
        where: { orderId },
        select: { productId: true },
      });
      const jaTem = new Set(atuais.map((i) => i.productId));
      const aInserir = itens.filter((i) => !jaTem.has(i.productId));
      if (!aInserir.length) return [];

      await tx.orderItem.createMany({
        data: aInserir.map((i) => ({
          orderId,
          productId: i.productId,
          quantity: i.quantity,
          unitPrice: i.unitPrice,
          listingId: i.listingId ?? null,
        })),
      });
      return aInserir;
    });

    if (!novos.length) return 0;

    console.log(
      JSON.stringify({
        event: params.evento,
        orderId,
        externalOrderId: params.externalOrderId,
        itensAcrescentados: novos.length,
        ...(params.extra ?? {}),
      }),
    );

    return novos.length;
  }

  /**
   * Completa um `Order` do ML ou da Magalu que existe com ZERO itens.
   *
   * A OUTRA METADE do Order sem itens. O pedido de zero itens registra a venda
   * (valor, data, visibilidade em /pedidos e no Financeiro), mas so faz sentido
   * se existir um caminho que acrescente os itens e baixe o estoque quando o
   * cliente finalmente cadastrar o produto. Na Shopee esse caminho e o
   * reconciliador, que re-busca o pedido por `order_sn`
   * (`completePartialShopeeOrder`). No ML e na Magalu nao existe busca dirigida
   * por id no poll, e sem esta funcao o Order vazio era uma ARMADILHA:
   * `orderRepository.exists()` passava a devolver true, o ciclo seguinte
   * respondia `already_exists` e os itens nunca entravam — venda no faturamento
   * pelo valor, sem baixa de estoque, para sempre (achado ALTA da auditoria de
   * 30/07/2026).
   *
   * Quem chama e o proprio poll, com o payload FRESCO que ele ja tem em maos:
   * nenhuma chamada externa a mais, e nenhum payload de pedido guardado no banco
   * (o `OrderIngestionIssue` de ML/Magalu segue com `payload: null`, para nao
   * persistir PII sem finalidade).
   *
   * Medido em producao em 30/07/2026: 84 pedidos do ML com zero itens, R$
   * 27.731,47 de faturamento, de 8 tenants — 77 deles com a pendencia fechada em
   * falso pela regressao que o `retryStockDeduction` de zero itens causava.
   *
   * Idempotente nas duas pontas: o acrescimo ignora produto que ja esta no
   * pedido, e a baixa vai por `retryStockDeduction`, ancorada no net do StockLog
   * lido DENTRO da transacao.
   *
   * O desfecho e entregue a `registrarDesfechoIngestao`, que ja e quem decide
   * fechar ou reabrir a quarentena de ML/Magalu — nenhuma regra nova de
   * pendencia.
   */
  private static async completarOrderSemItens(params: {
    plataforma: "MERCADO_LIVRE" | "MAGALU" | "SHOPEE";
    marketplaceAccountId: string;
    externalOrderId: string;
    orderId: string;
    itens: OrderItemCreate[];
    itemsTotal: number;
    /** true quando este pedido deveria baixar estoque (pago e deductStock). */
    esperavaBaixa: boolean;
    /** Shopee: detalhe cru do pedido, para a quarentena poder re-buscar. */
    payload?: unknown;
    /** Shopee: descricao dos itens que nao vincularam. */
    detalheSemVinculo?: string | null;
  }): Promise<ImportOrderResult> {
    const {
      plataforma,
      marketplaceAccountId,
      externalOrderId,
      orderId,
      itens,
      itemsTotal,
      esperavaBaixa,
    } = params;

    // Nenhum item casou AINDA: o produto continua fora do Dexo. A venda ja esta
    // registrada (o Order existe), a quarentena continua aberta, e a proxima
    // passada tenta de novo. Nunca fecha nada aqui.
    if (!itens.length) {
      console.log(
        JSON.stringify({
          event: "order_import.pedido_vazio_sem_vinculo",
          platform: plataforma,
          marketplaceAccountId,
          externalOrderId,
          orderId,
          itemsTotal,
        }),
      );
      const semVinculo: ImportOrderResult = {
        success: false,
        orderId,
        externalOrderId,
        status: "no_products",
        message:
          "Venda registrada sem itens: nenhum item casou com produto do estoque",
        stockDeducted: false,
        itemsLinked: 0,
        itemsTotal,
      };
      await this.registrarDesfechoDaCompletude({
        ...params,
        resultado: semVinculo,
      });
      return semVinculo;
    }

    const acrescentados = await this.acrescentarItensAoPedido({
      orderId,
      externalOrderId,
      itens,
      evento: "order_import.pedido_vazio_completado",
      extra: { platform: plataforma, marketplaceAccountId },
    });

    // Zero acrescentados com itens mapeados = outra execucao inseriu primeiro
    // (poll e webhook do ML rodam em processos diferentes). Nao e desfecho novo:
    // devolve `already_exists` e deixa a pendencia como esta.
    if (acrescentados === 0) {
      return {
        success: true,
        orderId,
        externalOrderId,
        status: "already_exists",
        message: "Itens do pedido ja tinham sido acrescentados",
        stockDeducted: false,
        itemsLinked: 0,
        itemsTotal,
      };
    }

    const baixou = esperavaBaixa
      ? await this.retryStockDeduction(orderId, plataforma, externalOrderId)
      : false;

    const resultado: ImportOrderResult = {
      success: true,
      orderId,
      externalOrderId,
      status: "imported",
      message: `Pedido ${this.rotuloDaPlataforma(plataforma)} completado com ${acrescentados} item(ns)`,
      stockDeducted: baixou,
      itemsLinked: acrescentados,
      itemsTotal,
    };

    await this.registrarDesfechoDaCompletude({ ...params, resultado });

    return resultado;
  }

  /**
   * Abre ou fecha a quarentena depois de completar um pedido vazio.
   *
   * ML e Magalu reusam `registrarDesfechoIngestao`, que ja e a arvore de decisao
   * das duas. A Shopee tem a sua propria, porque a pendencia dela guarda o
   * `payload` podado (e o que permite o reconciliador re-buscar o pedido) — e a
   * arvore aqui e a MESMA de `ingestShopeeOrder`, so aplicada ao pedido que foi
   * completado em vez de criado.
   *
   * Best-effort de ponta a ponta: nada aqui pode derrubar o ciclo.
   */
  private static async registrarDesfechoDaCompletude(params: {
    plataforma: "MERCADO_LIVRE" | "MAGALU" | "SHOPEE";
    marketplaceAccountId: string;
    externalOrderId: string;
    orderId: string;
    itemsTotal: number;
    esperavaBaixa: boolean;
    payload?: unknown;
    detalheSemVinculo?: string | null;
    resultado: ImportOrderResult;
  }): Promise<void> {
    const {
      plataforma,
      marketplaceAccountId,
      externalOrderId,
      orderId,
      itemsTotal,
      esperavaBaixa,
      resultado,
    } = params;

    if (plataforma !== "SHOPEE") {
      await this.registrarDesfechoIngestao({
        platform: plataforma,
        marketplaceAccountId,
        resultado,
        esperavaBaixa,
      });
      return;
    }

    try {
      const base = {
        marketplaceAccountId,
        platform: "SHOPEE" as const,
        externalOrderId,
        payload: params.payload,
        orderId,
      };

      if (resultado.status === "no_products") {
        await OrderIngestionIssueService.open({
          ...base,
          reason: "NO_LINKED_ITEMS",
          detail:
            params.detalheSemVinculo ??
            `Nenhum dos ${itemsTotal} item(ns) do pedido casou com produto do tenant.`,
        });
        return;
      }

      if (esperavaBaixa && !resultado.stockDeducted) {
        await OrderIngestionIssueService.open({
          ...base,
          reason: "STOCK_DEDUCTION_FAILED",
          detail: "Itens acrescentados ao pedido, baixa de estoque NAO efetivada.",
        });
        return;
      }

      if (resultado.itemsLinked < itemsTotal) {
        await OrderIngestionIssueService.open({
          ...base,
          reason: "PARTIAL_LINK",
          detail:
            params.detalheSemVinculo ??
            `${resultado.itemsLinked} de ${itemsTotal} item(ns) vinculados.`,
        });
        return;
      }

      await OrderIngestionIssueService.resolve(
        marketplaceAccountId,
        externalOrderId,
        orderId,
      );
    } catch (err) {
      console.warn(
        `[OrderUseCase] Falha ao registrar desfecho da completude de ${plataforma} #${externalOrderId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Dos pedidos que EXISTEM localmente, quais estao com zero itens.
   *
   * Recebe os pedidos que o batch check do ciclo JA trouxe (id, externalOrderId e
   * status) e devolve `externalOrderId -> Order.id`. Mapa vazio significa "nada a
   * completar", que e o caso normal.
   *
   * EGRESS — a forma importa, e foi medida contra o banco de producao em
   * 31/07/2026 (conta com 91 pedidos na janela de 7 dias, `OrderItem` com 6.414
   * linhas):
   *
   *   `order.findMany({ items: { none: {} } })`  ->  3,496 ms | 154 buffers
   *   `NOT EXISTS` correlacionado em SQL cru     ->  0,850 ms | 281 buffers
   *   esta forma (findMany em OrderItem)         ->  0,333 ms |  26 buffers
   *
   * O `items: { none: {} }` do Prisma NAO gera anti-join: ele emite
   * `"Order"."id" NOT IN (SELECT "orderId" FROM "OrderItem" WHERE "orderId" IS NOT
   * NULL)`, um subselect NAO correlacionado — o plano e `Seq Scan on "OrderItem"`
   * da tabela INTEIRA, a cada conta, a cada ciclo. Custo que cresce para sempre
   * junto com o numero de itens de pedido de TODOS os tenants, para responder uma
   * pergunta sobre ~100 pedidos.
   *
   * A forma escolhida pergunta o inverso ("quais destes ids TEM item") por
   * `OrderItem_orderId_idx`: Index Only Scan, custo proporcional a janela e nao ao
   * tamanho da tabela. Os campos novos no batch check (`id`, `status`) sao dois
   * textos curtos por pedido da janela — a mesma troca que o caminho da Magalu ja
   * fazia para o gate de cancelamento.
   *
   * Com o kill-switch ligado nao ha consulta nenhuma, e o caminho fica
   * byte-identico ao anterior.
   *
   * Best-effort: falhar aqui so faz o ciclo se comportar como antes.
   */
  private static async pedidosVaziosNaJanela(
    candidatos: Array<{
      id: string;
      externalOrderId: string;
      status: OrderStatus;
    }>,
  ): Promise<Map<string, string>> {
    if (process.env.ORDER_COMPLETE_EMPTY_ORDER_DISABLED === "1") {
      return new Map();
    }
    // Pedido cancelado nao entra: nao ha venda a completar nem estoque a baixar.
    const elegiveis = candidatos.filter((o) => o.status !== "CANCELLED");
    if (!elegiveis.length) return new Map();

    try {
      const comItem = await prisma.orderItem.findMany({
        where: { orderId: { in: elegiveis.map((o) => o.id) } },
        select: { orderId: true },
      });
      const temItem = new Set(comItem.map((i) => i.orderId));
      return new Map(
        elegiveis
          .filter((o) => !temItem.has(o.id))
          .map((o) => [o.externalOrderId, o.id] as [string, string]),
      );
    } catch (err) {
      console.warn(
        "[OrderUseCase] Falha ao listar pedidos sem itens:",
        err instanceof Error ? err.message : err,
      );
      return new Map();
    }
  }

  /**
   * Re-tenta APENAS a baixa de um pedido que já existe (usado pelo
   * OrderIngestionReconcilerService quando a quarentena é
   * STOCK_DEDUCTION_FAILED).
   *
   * A segurança contra baixa dupla vem do NET do `StockLog` por `reason`
   * determinística — o mesmo mecanismo que o `processOrderCancellation` usa:
   * se a baixa original já aconteceu (mesmo parcialmente, por clamp de
   * oversell), o net já cobre a quantidade e não há o que descontar.
   *
   * Retorna true quando, ao fim, o pedido está com a baixa efetivada.
   */
  static async retryStockDeduction(
    orderId: string,
    platformLabel: string,
    externalOrderId: string,
  ): Promise<boolean> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) return false;

    // Pedido cancelado não baixa — e a pendência deixa de fazer sentido.
    if (order.status === "CANCELLED") return true;

    // A `reason` do StockLog e a UNICA ancora de idempotencia da baixa. Ela tem
    // de ser identica string por string a que a baixa ORIGINAL gravou, senao o
    // net volta zero e o pedido inteiro e descontado de novo.
    //
    // O que estava errado (achado da auditoria de performance, 30/07/2026): o
    // reconciliador passa `issue.platform`, que e o enum do Prisma
    // (MERCADO_LIVRE / MAGALU / SHOPEE), e o mapeamento tratava so o SHOPEE. As
    // baixas originais gravam "Venda ML #", "Venda Magalu #" e "Venda Shopee #"
    // (linhas 1509, 2189 e 863; o tipo canonico esta em processOrderCancellation:
    // "ML" | "Shopee" | "Magalu"). Resultado para ML e Magalu: o retry procurava
    // "Venda MERCADO_LIVRE #id" / "Venda MAGALU #id", nao achava nada, e baixava
    // o pedido OUTRA VEZ. Deterministico, silencioso e irreversivel — a mesma
    // classe de defeito que este mesmo metodo acabou de consertar para a Shopee.
    //
    // Ficou LIVE quando a quarentena de ML/Magalu entrou (a44a0cc), porque foi ai
    // que o reconciliador comecou a chamar este caminho com o enum.
    const reason = `Venda ${this.rotuloDaPlataforma(platformLabel)} #${externalOrderId}`;

    // Pedido SEM item nenhum nao tem baixa a efetivar, e dizer que "baixou"
    // seria mentira com consequencia: o reconciliador usa este retorno para
    // FECHAR a pendencia, e a venda sem item viraria estado terminal silencioso
    // — o que o invariante proibe. Isso passou a acontecer de verdade quando o
    // Order de zero itens foi criado (7a0e282): 173 pedidos em producao.
    if (order.items.length === 0) {
      console.log(
        JSON.stringify({
          event: "order.retry_stock_deduction.sem_itens",
          orderId,
          externalOrderId,
          platform: platformLabel,
        }),
      );
      return false;
    }

    // Agregado POR PRODUTO, nao por linha de OrderItem: um pedido pode ter duas
    // linhas do mesmo produto, e o net do StockLog e por produto. Comparar
    // linha a linha diria "ja baixado" com metade da quantidade descontada.
    const pedidoPorProduto = new Map<string, number>();
    for (const i of order.items) {
      pedidoPorProduto.set(
        i.productId,
        (pedidoPorProduto.get(i.productId) ?? 0) + i.quantity,
      );
    }

    // Caminho padrão (auditoria 29/07/2026): quem decide QUANTO falta é a
    // própria transação da baixa, depois dos locks — ver `netGuard` em
    // `deductStockForOrder`. Ler o net aqui, fora de transação, e só depois
    // abrir a transação da baixa era decremento DUPLO quando duas execuções se
    // cruzavam: o poll (`dexo-sync-orders`) e o reconciliador (`dexo-api`) são
    // processos pm2 distintos, e o botão "Tentar novamente" é um terceiro
    // caminho.
    //
    // ORDER_STOCK_RETRY_TX_NET_DISABLED=1 restaura a leitura fora da transação.
    // NÃO é o default de propósito: o caminho antigo destrói estoque de forma
    // silenciosa e irreversível — dois `-1` sob a MESMA `reason` fazem o net
    // valer `-2`, e daí em diante toda checagem (inclusive o estorno de
    // cancelamento, que clampa na quantidade do pedido) considera o estado
    // correto.
    if (process.env.ORDER_STOCK_RETRY_TX_NET_DISABLED !== "1") {
      try {
        await this.deductStockForOrder(order as unknown as Order, reason, {
          pedidoPorProduto,
        });
        // Sucesso cobre os dois casos: baixou o que faltava, ou não faltava
        // nada. A única falha possível é exceção.
        return true;
      } catch (err) {
        console.warn(
          `[OrderUseCase] Re-tentativa de baixa do pedido ${orderId} falhou:`,
          err instanceof Error ? err.message : err,
        );
        return false;
      }
    }

    // ── Caminho anterior, preservado sob kill-switch ─────────────────────────
    // Já baixado? O net por `reason` responde sem depender de flag.
    const grouped = await prisma.stockLog.groupBy({
      by: ["productId"],
      where: {
        productId: { in: order.items.map((i) => i.productId) },
        reason,
      },
      _sum: { change: true },
    });
    const netByProduct = new Map(
      grouped.map((g) => [g.productId, g._sum.change ?? 0]),
    );

    // So o que FALTA. Passar a lista completa para deductStockForOrder
    // descontaria de novo o que ja foi descontado — o net protege contra
    // repetir o pedido inteiro, mas nao contra um pedido parcialmente baixado.
    const faltando: Array<{ productId: string; quantity: number }> = [];
    for (const [productId, pedido] of pedidoPorProduto) {
      const jaBaixado = -(netByProduct.get(productId) ?? 0);
      const falta = pedido - jaBaixado;
      if (falta > 0) faltando.push({ productId, quantity: falta });
    }

    if (faltando.length === 0) {
      // A baixa tinha acontecido; só a marca de auditoria pode estar faltando.
      if (
        !(order as any).stockDeductedAt &&
        process.env.ORDER_STOCK_DEDUCTED_AT_DISABLED !== "1"
      ) {
        await prisma.order
          .update({
            where: { id: order.id },
            data: { stockDeductedAt: new Date() },
          })
          .catch(() => {});
      }
      return true;
    }

    try {
      // Passa SO os itens que faltam. Com a lista completa, um pedido
      // parcialmente baixado (clamp de oversell, ou produto ausente pulado
      // dentro da tx) seria descontado de novo no item que ja saiu.
      await this.deductStockForOrder(
        { ...(order as unknown as Order), items: faltando as any },
        reason,
      );
      return true;
    } catch (err) {
      console.warn(
        `[OrderUseCase] Re-tentativa de baixa do pedido ${orderId} falhou:`,
        err instanceof Error ? err.message : err,
      );
      return false;
    }
  }

  /** Texto curto e legível dos itens que não vincularam, para o `detail`. */
  private static describeUnlinked(
    unlinked: Array<{ itemId: string; sku: string | null; reason: string }>,
  ): string {
    if (!unlinked.length) return "Nenhum item vinculado.";
    return unlinked
      .map(
        (u) =>
          `item ${u.itemId}${u.sku ? ` (SKU "${u.sku}")` : " (sem SKU)"}: ${u.reason}`,
      )
      .join("; ");
  }

  /**
   * Cria o Order de uma venda cujos itens NAO puderam ser vinculados a produto.
   *
   * Order com ZERO itens: carrega o valor da venda e a data, e fica visivel em
   * /pedidos, no Financeiro e no Dashboard. Sem isto a venda existia no
   * marketplace e nao existia no Dexo — medido em producao em 29/07/2026: 89
   * vendas de 3 tenants presas assim, 26 de um so cliente em 12 dias, com o
   * faturamento dele incompleto.
   *
   * NAO baixa estoque, de proposito: o produto nao esta cadastrado, entao nao
   * existe estoque a descontar. A pendencia da quarentena continua aberta e,
   * quando o cliente cadastrar o produto, o reconciliador acrescenta o item e
   * baixa sozinho.
   *
   * `OrderItem.productId` e NOT NULL com FK obrigatoria, por isso zero itens em
   * vez de item sem produto: tornar a coluna nulavel mexeria no modelo mais
   * usado da plataforma.
   *
   * Devolve o id criado, ou null quando a criacao nao aconteceu (kill-switch
   * ORDER_CREATE_WITHOUT_ITEMS_DISABLED=1, corrida de P2002 ou falha). Nunca
   * lanca: perder o Order e ruim, perder o RASTRO e o que o invariante proibe.
   */
  private static async criarOrderSemItens(params: {
    marketplaceAccountId: string;
    externalOrderId: string;
    status: OrderStatus;
    totalAmount: number;
    customerName?: string;
    soldAt: Date | null;
    plataforma: "SHOPEE" | "MERCADO_LIVRE" | "MAGALU";
    itemsTotal: number;
  }): Promise<string | null> {
    if (process.env.ORDER_CREATE_WITHOUT_ITEMS_DISABLED === "1") return null;

    // O Order sem itens e METADE de um par: a outra metade e o caminho que
    // ACRESCENTA os itens quando o cliente finalmente cadastra o produto. Sem
    // ela, o Order vazio e uma ARMADILHA — `orderRepository.exists()` passa a
    // devolver true, o import seguinte responde `already_exists` e os itens nunca
    // entram: venda no faturamento pelo valor, sem baixa de estoque, para sempre
    // (achado ALTA da auditoria de 30/07/2026).
    //
    // Por isso, entre 30/07 e agora, isto ficou restrito a Shopee, que era a
    // unica com a outra metade (`completePartialShopeeOrder`, via reconciliador).
    // Agora as tres tem: `completarOrderSemItens` completa o pedido vazio no
    // proprio poll, com o payload do ciclo, sem chamada externa a mais.
    //
    // ORDER_CREATE_WITHOUT_ITEMS_ML_MAGALU_DISABLED=1 volta ao recorte de
    // Shopee-apenas. Nesse caso o ML e a Magalu ficam so com a quarentena: a
    // venda continua registrada e visivel na aba de Pendencias (o invariante
    // proibe descarte silencioso, e isso segue garantido), mas nao vira Order.
    if (
      params.plataforma !== "SHOPEE" &&
      process.env.ORDER_CREATE_WITHOUT_ITEMS_ML_MAGALU_DISABLED === "1"
    ) {
      console.log(
        JSON.stringify({
          event: "order_import.sem_itens_nao_criado",
          platform: params.plataforma,
          marketplaceAccountId: params.marketplaceAccountId,
          externalOrderId: params.externalOrderId,
          motivo:
            "ORDER_CREATE_WITHOUT_ITEMS_ML_MAGALU_DISABLED=1; a venda fica registrada na quarentena",
        }),
      );
      return null;
    }

    try {
      const criado = await orderRepository.create({
        marketplaceAccountId: params.marketplaceAccountId,
        externalOrderId: params.externalOrderId,
        status: params.status,
        totalAmount: params.totalAmount,
        customerName: params.customerName,
        soldAt: params.soldAt,
        items: [],
      });

      console.log(
        JSON.stringify({
          event: "order_import.created_without_items",
          platform: params.plataforma,
          marketplaceAccountId: params.marketplaceAccountId,
          externalOrderId: params.externalOrderId,
          orderId: criado.id,
          itemsTotal: params.itemsTotal,
        }),
      );
      return criado.id;
    } catch (err) {
      // P2002 = outro caminho criou o mesmo pedido no meio. Nao e erro: o
      // @@unique(marketplaceAccountId, externalOrderId) fez o trabalho.
      const duplicado =
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code?: string }).code === "P2002";
      if (!duplicado) {
        console.warn(
          `[OrderUseCase] Falha ao criar Order sem itens para ${params.plataforma} #${params.externalOrderId}:`,
          err instanceof Error ? err.message : err,
        );
      }
      return null;
    }
  }

  /**
   * Rotulo canonico da plataforma nas `reason` de StockLog.
   *
   * Aceita tanto o enum do Prisma (MERCADO_LIVRE / SHOPEE / MAGALU) quanto o
   * rotulo ja pronto ("ML" / "Shopee" / "Magalu"), porque os dois circulam: o
   * importador usa o rotulo e o reconciliador tem em maos o enum da pendencia.
   *
   * Estritamente ADITIVO em relacao ao mapeamento anterior
   * (`p === "SHOPEE" ? "Shopee" : p`): para "SHOPEE", "ML", "Shopee" e "Magalu" a
   * saida e exatamente a mesma. O que muda e so o que antes produzia uma `reason`
   * QUE NAO EXISTIA no banco — MERCADO_LIVRE e MAGALU. Por isso nao precisa de
   * kill-switch: nao ha comportamento correto anterior a preservar.
   */
  private static rotuloDaPlataforma(p: string): string {
    switch (p) {
      case "MERCADO_LIVRE":
      case "ML":
        return "ML";
      case "SHOPEE":
      case "Shopee":
        return "Shopee";
      case "MAGALU":
      case "Magalu":
        return "Magalu";
      default:
        // Plataforma nova: preserva o valor recebido, como antes.
        return p;
    }
  }

  /**
   * Data da VENDA no marketplace, para gravar em `Order.soldAt`.
   *
   * Cada plataforma expoe num formato diferente: ML `date_created` (ISO),
   * Shopee `create_time` (epoch em segundos), Magalu `purchased_at` (ISO).
   * Devolve null quando o valor nao da para interpretar — e ai o COALESCE cai
   * para `createdAt` e nada muda.
   *
   * Kill-switch ORDER_SOLD_AT_DISABLED=1 devolve sempre null, deixando a coluna
   * NULL como antes da migracao.
   */
  private static resolveSoldAt(
    valor: string | number | null | undefined,
  ): Date | null {
    if (process.env.ORDER_SOLD_AT_DISABLED === "1") return null;
    if (valor === null || valor === undefined || valor === "") return null;

    // Shopee: epoch em SEGUNDOS. Numero pequeno tratado como ms daria 1970.
    if (typeof valor === "number") {
      if (!Number.isFinite(valor) || valor <= 0) return null;
      const d = new Date(valor * 1000);
      return Number.isNaN(d.getTime()) ? null : d;
    }

    const d = new Date(valor);
    if (Number.isNaN(d.getTime())) return null;
    // Data absurda (ano < 2000 ou no futuro distante) e mais provavel bug de
    // parsing do que venda real: melhor null e cair no createdAt.
    const ano = d.getUTCFullYear();
    if (ano < 2000 || ano > 2100) return null;
    return d;
  }

  /**
   * Abre ou fecha a quarentena a partir do desfecho de UM pedido do ML ou da
   * Magalu.
   *
   * Por que existe (auditoria 29/07/2026): a quarentena cobria SÓ a Shopee. No
   * ML, um pedido cujos itens não casassem devolvia `no_products` e o ciclo
   * seguia — sem Order, sem SystemLog, sem aparecer em /pedidos, e com o SyncLog
   * gravado como SUCCESS. Uma falha de baixa era só um `console.error` e nunca
   * era re-tentada. Na Magalu, idem. O invariante do cliente ("toda venda vira
   * Order E baixa estoque, sempre; nenhum descarte silencioso") valia para um
   * marketplace de três.
   *
   * Best-effort de propósito: um erro aqui nunca pode derrubar a importação —
   * trocaria um pedido incompleto por nenhum pedido.
   *
   * Kill-switch ORDER_INGESTION_ISSUES_ML_MAGALU_DISABLED=1 volta ao
   * comportamento anterior (só a Shopee registra). O
   * ORDER_INGESTION_ISSUES_DISABLED continua desligando a quarentena inteira.
   */
  private static async registrarDesfechoIngestao(params: {
    platform: "MERCADO_LIVRE" | "MAGALU";
    marketplaceAccountId: string;
    resultado: ImportOrderResult;
    /** true quando este pedido deveria ter baixado estoque. */
    esperavaBaixa: boolean;
  }): Promise<void> {
    if (process.env.ORDER_INGESTION_ISSUES_ML_MAGALU_DISABLED === "1") return;

    const { platform, marketplaceAccountId, resultado, esperavaBaixa } = params;
    const rotulo = platform === "MERCADO_LIVRE" ? "ML" : "Magalu";

    try {
      const base = {
        marketplaceAccountId,
        platform,
        externalOrderId: resultado.externalOrderId,
        // Payload NÃO é guardado: a reingestão de ML/Magalu não é dirigida por
        // id, então ele nunca seria lido — e guardar dado de pedido sem
        // finalidade é PII persistida sem prazo para sair.
        payload: null,
      };

      if (resultado.status === "no_products") {
        console.log(
          JSON.stringify({
            event: `${rotulo.toLowerCase()}.order_import.no_linked_items`,
            marketplaceAccountId,
            externalOrderId: resultado.externalOrderId,
            itemsTotal: resultado.itemsTotal,
          }),
        );
        await OrderIngestionIssueService.open({
          ...base,
          reason: "NO_LINKED_ITEMS",
          // Com o Order criado sem itens, o reconciliador precisa do id para
          // achar o pedido e acrescentar o item quando o produto aparecer.
          orderId: resultado.orderId,
          detail: `Nenhum dos ${resultado.itemsTotal} item(ns) do pedido casou com produto do tenant.`,
        });
        return;
      }

      if (resultado.status === "error") {
        await OrderIngestionIssueService.open({
          ...base,
          reason: "INGEST_FAILED",
          detail: resultado.message?.slice(0, 500) ?? null,
        });
        return;
      }

      if (resultado.status !== "imported") return;

      // Importado: a baixa é o motivo mais grave, porque o pedido JÁ aparece na
      // tela e o estoque continua vendável nos outros canais (oversell).
      if (esperavaBaixa && !resultado.stockDeducted) {
        await OrderIngestionIssueService.open({
          ...base,
          reason: "STOCK_DEDUCTION_FAILED",
          orderId: resultado.orderId,
          detail: `Pedido ${rotulo} importado, baixa de estoque NAO efetivada.`,
        });
        return;
      }

      if (resultado.itemsLinked < resultado.itemsTotal) {
        await OrderIngestionIssueService.open({
          ...base,
          reason: "PARTIAL_LINK",
          orderId: resultado.orderId,
          detail: `${resultado.itemsLinked} de ${resultado.itemsTotal} item(ns) vinculados.`,
        });
        return;
      }

      // Completo e com baixa: se havia pendência antiga deste pedido, fecha.
      await OrderIngestionIssueService.resolve(
        marketplaceAccountId,
        resultado.externalOrderId,
        resultado.orderId ?? null,
      );
    } catch (err) {
      console.warn(
        `[OrderUseCase] Falha ao registrar desfecho de ingestao ${rotulo} #${resultado.externalOrderId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Processa um único pedido do ML
   */
  private static async processOrder(
    mlOrder: MLOrderDetails,
    marketplaceAccountId: string,
    deductStock: boolean,
    listingMap?: Map<string, any>,
    userId?: string,
  ): Promise<ImportOrderResult> {
    const externalOrderId = mlOrder.id.toString();

    try {
      // Verificar se pedido já foi importado (fallback for direct calls without batch check)
      const exists = await orderRepository.exists(
        marketplaceAccountId,
        externalOrderId,
      );
      if (exists) {
        return {
          success: true,
          orderId: null,
          externalOrderId,
          status: "already_exists",
          message: "Pedido já importado anteriormente",
          stockDeducted: false,
          itemsLinked: 0,
          itemsTotal: mlOrder.order_items.length,
        };
      }

      // Mapear itens do pedido para produtos locais
      const { items, linkedCount } = await this.mapOrderItems(
        mlOrder.order_items,
        userId,
        marketplaceAccountId,
        listingMap,
      );

      if (items.length === 0) {
        // A venda existe no ML. Antes o pedido simplesmente nao entrava: sem
        // Order, sem rastro, e o ciclo gravado como SUCCESS. Agora entra sem
        // itens (a quarentena e aberta pelo chamador) e o estoque fica pendente.
        const orderSemItens = await this.criarOrderSemItens({
          marketplaceAccountId,
          externalOrderId,
          status: this.mapMLStatusToLocal(mlOrder.status),
          totalAmount:
            typeof mlOrder.total_amount === "number" &&
            Number.isFinite(mlOrder.total_amount)
              ? Number(mlOrder.total_amount)
              : 0,
          customerName: this.extractCustomerName(mlOrder),
          soldAt: this.resolveSoldAt(
            (mlOrder as { date_created?: string }).date_created,
          ),
          plataforma: "MERCADO_LIVRE",
          itemsTotal: mlOrder.order_items.length,
        });

        return {
          success: false,
          orderId: orderSemItens,
          externalOrderId,
          status: "no_products",
          message: orderSemItens
            ? "Nenhum item do pedido pôde ser vinculado a produtos locais; venda registrada sem itens e sem baixa"
            : "Nenhum item do pedido pôde ser vinculado a produtos locais",
          stockDeducted: false,
          itemsLinked: 0,
          itemsTotal: mlOrder.order_items.length,
        };
      }

      // Criar pedido no banco
      const orderData: OrderCreate = {
        marketplaceAccountId,
        externalOrderId,
        status: this.mapMLStatusToLocal(mlOrder.status),
        totalAmount: mlOrder.total_amount,
        customerName: this.extractCustomerName(mlOrder),
        customerEmail: undefined, // ML não fornece email diretamente
        soldAt: this.resolveSoldAt(
          (mlOrder as { date_created?: string }).date_created,
        ),
        items,
      };

      const order = await orderRepository.create(orderData);

      // Descontar estoque se solicitado e pedido está pago
      let stockDeducted = false;
      if (deductStock && mlOrder.status === "paid") {
        try {
          await this.deductStockForOrder(order, `Venda ML #${externalOrderId}`);
          stockDeducted = true;
        } catch (err) {
          console.error(
            `[OrderUseCase] Falha ao descontar estoque para pedido ML #${externalOrderId} (order=${order.id}). Estoque NÃO foi descontado.`,
            err,
          );
        }
      }

      return {
        success: true,
        orderId: order.id,
        externalOrderId,
        status: "imported",
        message: `Pedido importado com ${linkedCount} itens vinculados`,
        stockDeducted,
        itemsLinked: linkedCount,
        itemsTotal: mlOrder.order_items.length,
      };
    } catch (error) {
      // Handle concurrent duplicate (P2002) gracefully as "already_exists"
      const isPrismaUniqueError =
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as any).code === "P2002";
      if (isPrismaUniqueError) {
        return {
          success: true,
          orderId: null,
          externalOrderId,
          status: "already_exists",
          message: "Pedido já importado (concurrent)",
          stockDeducted: false,
          itemsLinked: 0,
          itemsTotal: mlOrder.order_items.length,
        };
      }
      console.error(
        `[OrderUseCase] Error processing order ${externalOrderId}:`,
        error,
      );
      return {
        success: false,
        orderId: null,
        externalOrderId,
        status: "error",
        message: error instanceof Error ? error.message : "Erro desconhecido",
        stockDeducted: false,
        itemsLinked: 0,
        itemsTotal: mlOrder.order_items.length,
      };
    }
  }

  /**
   * Mapeia itens do pedido ML priorizando o anúncio vinculado e faz fallback por SKU.
   */
  private static async mapOrderItems(
    mlItems: MLOrderItem[],
    userId: string | undefined,
    marketplaceAccountId: string,
    listingMap?: Map<string, any>,
  ): Promise<{ items: OrderItemCreate[]; linkedCount: number }> {
    const items: OrderItemCreate[] = [];
    let linkedCount = 0;

    for (const mlItem of mlItems) {
      // 1) Tentar vincular pelo ID do anúncio no marketplace
      const externalListingId = mlItem.item.id;
      const cacheKey = `${marketplaceAccountId}_${externalListingId}`;

      // Use prefetched map if available, otherwise fallback to DB query
      const listing = listingMap
        ? listingMap.get(cacheKey)
        : await prisma.productListing.findUnique({
            where: {
              marketplaceAccountId_externalListingId: {
                marketplaceAccountId,
                externalListingId,
              },
            },
            // EGRESS: consumo verificado logo abaixo — so `listing.productId`,
            // `listing.id` e a EXISTENCIA de `listing.product`. O `include`
            // anterior trazia a linha inteira do Product, com quatro JSONB
            // (`attributes`, `imageUrls`, `mlCatalogSnapshot`, `compatibilities`)
            // e a `description`, por item de pedido. Mesmo select do caminho em
            // lote, o que tambem deixa as duas pontas com o mesmo shape.
            select: {
              id: true,
              productId: true,
              product: { select: { id: true } },
            },
          });

      if (listing && listing.product) {
        items.push({
          productId: listing.productId,
          listingId: listing.id,
          quantity: mlItem.quantity,
          unitPrice: mlItem.unit_price,
        });
        linkedCount++;
        continue;
      }

      // 2) Fallback: vincular por SKU
      const sku = this.extractSku(mlItem);

      if (!sku) {
        console.log(
          `[OrderUseCase] Item ${mlItem.item.id} sem SKU e sem listing vinculado, pulando`,
        );
        continue;
      }

      // Buscar produto pelo SKU
      const product = await this.findProductByFallbackSku(sku, userId);

      if (!product) {
        console.log(`[OrderUseCase] Produto com SKU "${sku}" não encontrado`);
        continue;
      }

      const fallbackListing = await this.upsertFallbackListing({
        productId: product.id,
        marketplaceAccountId,
        externalListingId,
        externalSku: sku,
      });

      items.push({
        productId: product.id,
        listingId: fallbackListing?.id ?? null,
        quantity: mlItem.quantity,
        unitPrice: mlItem.unit_price,
      });
      linkedCount++;
    }

    return { items, linkedCount };
  }

  /**
   * Extrai SKU de um item do pedido ML
   */
  private static extractSku(mlItem: MLOrderItem): string | null {
    // Tentar seller_custom_field primeiro
    if (mlItem.item.seller_custom_field) {
      return mlItem.item.seller_custom_field;
    }

    // Depois, seller_sku
    if (mlItem.item.seller_sku) {
      return mlItem.item.seller_sku;
    }

    return null;
  }

  private static async findProductByFallbackSku(
    sku: string | null,
    userId?: string,
  ) {
    const normalizedSku = normalizeSku(sku);
    if (!normalizedSku) {
      return null;
    }

    // EGRESS: os três chamadores (ML, Shopee e Magalu) usam SÓ `product.id`.
    // Sem o select, cada item de pedido sem vínculo trazia a linha inteira do
    // Product — ~50 colunas, incluindo `description`, o array `imageUrls` e o
    // Json `attributes`. Este caminho roda por item, a cada ciclo de
    // importação, nas três plataformas.
    return prisma.product.findFirst({
      where: userId
        ? { skuNormalized: normalizedSku, userId }
        : { skuNormalized: normalizedSku },
      select: { id: true },
    });
  }

  private static async upsertFallbackListing(data: {
    productId: string;
    marketplaceAccountId: string;
    externalListingId: string;
    externalSku?: string | null;
  }) {
    try {
      return await ListingRepository.upsertFromOrderFallback({
        ...data,
        status: "active",
      });
    } catch (error) {
      console.error(
        `[OrderUseCase] Erro ao materializar listing via fallback para ${data.marketplaceAccountId}/${data.externalListingId}:`,
        error,
      );
      return null;
    }
  }

  /**
   * Mapeia itens do pedido Shopee priorizando o anúncio vinculado e faz fallback por SKU.
   */
  // ====================================================================
  // MAGALU — importação de pedidos + baixa automática (espelha Shopee)
  // ====================================================================

  /**
   * Importa pedidos recentes da Magalu de todas as contas ativas do usuário.
   */
  static async importRecentMagaluOrders(
    userId: string,
    days: number = 7,
    deductStock: boolean = true,
  ): Promise<ImportOrdersResult> {
    const accounts = await MarketplaceRepository.findAllByUserIdAndPlatform(
      userId,
      Platform.MAGALU,
    );

    const validAccounts =
      accounts?.filter((acc) => acc.accessToken && acc.externalUserId) ?? [];

    if (validAccounts.length === 0) {
      throw new Error("Conta da Magalu não conectada ou sem credenciais");
    }

    const aggregated: ImportOrdersResult = {
      totalOrders: 0,
      imported: 0,
      alreadyExists: 0,
      noProducts: 0,
      errors: 0,
      stockDeductions: 0,
      results: [],
    };

    for (const account of validAccounts) {
      try {
        const result = await this.importRecentMagaluOrdersForAccount(
          account.id,
          days,
          deductStock,
        );
        aggregated.totalOrders += result.totalOrders;
        aggregated.imported += result.imported;
        aggregated.alreadyExists += result.alreadyExists;
        aggregated.noProducts += result.noProducts;
        aggregated.errors += result.errors;
        aggregated.stockDeductions += result.stockDeductions;
        if (result.skippedByStatus) {
          aggregated.skippedByStatus =
            (aggregated.skippedByStatus ?? 0) + result.skippedByStatus;
        }
        for (const s of result.skippedStatuses ?? []) {
          if (!aggregated.skippedStatuses?.includes(s)) {
            aggregated.skippedStatuses = [
              ...(aggregated.skippedStatuses ?? []),
              s,
            ];
          }
        }
        aggregated.results.push(...result.results);
      } catch (error) {
        aggregated.errors += 1;
        aggregated.results.push({
          success: false,
          orderId: null,
          externalOrderId: `ACCOUNT_${account.id}`,
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Erro ao importar conta Magalu",
          stockDeducted: false,
          itemsLinked: 0,
          itemsTotal: 0,
        });
      }
    }

    return aggregated;
  }

  /**
   * Importa pedidos recentes da Magalu para uma conta específica.
   */
  /**
   * @param opts.orderIds Ids de pedido a buscar EXPLICITAMENTE via
   *   `GET /seller/v1/orders/{id}`, somados (com dedupe) ao resultado do poll
   *   por janela de data. É o que o webhook usa: ele conhece o id exato do
   *   pedido (`data.params.id`) e antes o descartava, dependendo de o pedido
   *   aparecer no poll genérico. Um pedido fora da janela, ou além do teto de
   *   paginação, ficava invisível. Toda a lógica de criação, vínculo, baixa e
   *   cancelamento é a mesma — só a origem da lista muda.
   */
  static async importRecentMagaluOrdersForAccount(
    marketplaceAccountId: string,
    days: number = 7,
    deductStock: boolean = true,
    opts?: { orderIds?: string[] },
  ): Promise<ImportOrdersResult> {
    const account = await MarketplaceRepository.findById(marketplaceAccountId);
    if (!account || !account.accessToken || !account.externalUserId) {
      throw new Error("Conta Magalu não encontrada ou sem credenciais");
    }

    const result: ImportOrdersResult = {
      totalOrders: 0,
      imported: 0,
      alreadyExists: 0,
      noProducts: 0,
      errors: 0,
      stockDeductions: 0,
      results: [],
    };

    const magaluOrders = await this.getRecentMagaluOrdersWithRefresh(
      {
        id: account.id,
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
      },
      days,
    );

    const extractExternalOrderId = (o: MagaluOrder): string =>
      String(o.id ?? o.code ?? o.order_id ?? "");

    // Pedidos pedidos explicitamente (webhook / backfill dirigido). Buscados um
    // a um e mesclados por id — o poll continua sendo a rede de segurança.
    // Best-effort por pedido: falhar em buscar UM não pode derrubar o ciclo.
    if (opts?.orderIds?.length) {
      const jaNaLista = new Set(
        magaluOrders.map((o) => extractExternalOrderId(o)).filter(Boolean),
      );
      // Também indexa por `code`: o poll devolve o pedido com `id` (UUID) e
      // `code` (número), e quem pede pode conhecer qualquer um dos dois.
      for (const o of magaluOrders) {
        if (o.code) jaNaLista.add(String(o.code));
      }
      for (const wantedId of opts.orderIds) {
        const id = String(wantedId ?? "").trim();
        if (!id || jaNaLista.has(id)) continue;
        // EGRESS/chamadas externas: o endpoint de detalhe só aceita o `code`
        // (numérico) — com um UUID responde 404 sempre. O webhook manda
        // `data.params.id`, que é UUID; tentar buscá-lo gastaria uma requisição
        // garantidamente inútil e ainda poluiria o log a cada evento. Nesse
        // caso o poll por janela, que já rodou acima, é quem cobre o pedido.
        if (!/^\d+$/.test(id)) {
          console.log(
            JSON.stringify({
              event: "magalu.order.fetch_by_id_skipped",
              externalOrderId: id,
              marketplaceAccountId,
              motivo: "detalhe_exige_code_numerico",
            }),
          );
          continue;
        }
        try {
          const one = await this.getMagaluOrderWithRefresh(
            {
              id: account.id,
              accessToken: account.accessToken,
              refreshToken: account.refreshToken,
            },
            id,
          );
          if (one) {
            magaluOrders.push(one);
            jaNaLista.add(id);
          }
        } catch (err) {
          console.warn(
            JSON.stringify({
              event: "magalu.order.fetch_by_id_failed",
              externalOrderId: id,
              marketplaceAccountId,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      }
    }

    result.totalOrders = magaluOrders.length;

    const externalIds = magaluOrders
      .map((o) => extractExternalOrderId(o))
      .filter(Boolean);
    const existingOrders = await prisma.order.findMany({
      where: {
        marketplaceAccountId: account.id,
        externalOrderId: { in: externalIds },
      },
      // EGRESS: status junto no select já existente (bytes desprezíveis) —
      // permite o gate de cancelamento abaixo pular o handler para pedidos
      // já CANCELLED localmente, zerando o custo recorrente por ciclo. O `id`
      // segue a mesma logica, para `pedidosVaziosNaJanela`.
      select: { id: true, externalOrderId: true, status: true },
    });
    const existingSet = new Set(existingOrders.map((o) => o.externalOrderId));
    const existingStatusByExtId = new Map(
      existingOrders.map((o) => [o.externalOrderId, o.status]),
    );

    // EGRESS: idem ML/Shopee — só relê os anúncios da conta se houver pedido novo.
    const hasNewOrders = magaluOrders.some(
      (o) => !existingSet.has(extractExternalOrderId(o)),
    );
    const listingMap = new Map<string, any>();
    if (hasNewOrders) {
      const accountListings = await prisma.productListing.findMany({
        where: { marketplaceAccountId: account.id },
        select: {
          id: true,
          productId: true,
          marketplaceAccountId: true,
          externalListingId: true,
          product: { select: { id: true } },
        },
      });
      for (const l of accountListings) {
        listingMap.set(`${l.marketplaceAccountId}_${l.externalListingId}`, l);
      }
    }

    // Idem ML: pedidos que existem local com zero itens, para completar em vez
    // de pular.
    const vaziosPorExtId = await this.pedidosVaziosNaJanela(existingOrders);

    for (const magaluOrder of magaluOrders) {
      const externalOrderId = extractExternalOrderId(magaluOrder);
      // Os itens vivem em `deliveries[].items[]`, não em `order.items`. Ler o
      // campo errado fazia TODO pedido cair em `no_products` — a razão pela
      // qual nenhuma venda Magalu jamais virou Order.
      const itemList = extractMagaluOrderItems(magaluOrder);
      try {
        if (!externalOrderId) {
          result.errors++;
          continue;
        }

        if (existingSet.has(externalOrderId)) {
          // ADITIVO (cancelamento): pedido já importado que aparece cancelado
          // no poll da API Magalu → estorno via handler idempotente (fast-path
          // barato quando já está CANCELLED). Best-effort: o handler nunca
          // lança e nada aqui toca contadores/results do import.
          // Gate pelo status RAW, não pelo mapeado: "unavailable" também
          // mapeia para CANCELLED, mas é cancelamento por INDISPONIBILIDADE
          // (o vendedor declarou que a peça não existe) — estornar criaria
          // estoque fantasma e oversell cross-channel. Não tocar.
          // normalizeMagaluStatus (e nao String(...)) para que um status vindo
          // como objeto tambem seja reconhecido — antes viraria
          // "[object Object]" e o cancelamento passaria despercebido.
          const rawMagaluStatus = this.normalizeMagaluStatus(
            magaluOrder.status,
          );
          if (
            process.env.ORDER_CANCEL_RESTORE_DISABLED !== "1" &&
            (rawMagaluStatus === "cancelled" ||
              rawMagaluStatus === "canceled" ||
              rawMagaluStatus === "cancelado") &&
            // EGRESS: já CANCELLED local (snapshot deste ciclo) ⇒ o handler
            // seria fast-path no-op — pular poupa 1 query por cancelado por
            // ciclo, para sempre. Snapshot stale ⇒ no pior caso o handler
            // idempotente roda uma vez a mais (inofensivo).
            existingStatusByExtId.get(externalOrderId) !== "CANCELLED"
          ) {
            const cancelResult = await this.processOrderCancellation({
              marketplaceAccountId,
              externalOrderId,
              platformLabel: "Magalu",
            });
            // Loga só na transição real (evita re-logar o mesmo cancelado a
            // cada ciclo de poll enquanto ele estiver na janela).
            if (
              cancelResult.action === "cancelled_restored" ||
              cancelResult.action === "cancelled_no_restore"
            ) {
              void SystemLogService.logInfo(
                "MAGALU_CANCEL_DETECTED",
                `Pedido Magalu #${externalOrderId} consta cancelado no marketplace (${cancelResult.action})`,
                {
                  resource: "Order",
                  details: {
                    externalOrderId,
                    marketplaceAccountId,
                    rawStatus: magaluOrder.status ?? null,
                    action: cancelResult.action,
                    restoredItems: cancelResult.restoredItems,
                  },
                },
              ).catch(() => {});
            }
          }

          // Pedido que existe local com ZERO itens: completa com o payload
          // FRESCO deste ciclo. Mesma logica do ML — ver
          // `completarOrderSemItens`. Pedido que a Magalu esta reportando como
          // cancelado nao entra: quem manda nele e o handler de cancelamento
          // acima.
          const orderVazioId = vaziosPorExtId.get(externalOrderId);
          const constaCancelado =
            rawMagaluStatus === "cancelled" ||
            rawMagaluStatus === "canceled" ||
            rawMagaluStatus === "cancelado";
          if (orderVazioId && !constaCancelado) {
            const statusVazio = this.mapMagaluStatus(magaluOrder.status);
            // `listingMap` de fora de proposito (ver a nota no caminho do ML).
            const { items } = await this.mapMagaluOrderItems(
              itemList,
              account.userId,
              marketplaceAccountId,
              undefined,
            );
            const desfecho = await this.completarOrderSemItens({
              plataforma: "MAGALU",
              marketplaceAccountId: account.id,
              externalOrderId,
              orderId: orderVazioId,
              itens: items,
              itemsTotal: itemList.length,
              esperavaBaixa:
                deductStock &&
                (statusVazio === "PAID" ||
                  statusVazio === "SHIPPED" ||
                  statusVazio === "DELIVERED"),
            });
            result.results.push(desfecho);
            if (desfecho.status === "imported") {
              result.imported++;
              if (desfecho.stockDeducted) result.stockDeductions++;
            } else if (desfecho.status === "no_products") {
              result.noProducts++;
            } else {
              result.alreadyExists++;
            }
            continue;
          }

          result.results.push({
            success: true,
            orderId: null,
            externalOrderId,
            status: "already_exists",
            message: "Pedido já importado anteriormente",
            stockDeducted: false,
            itemsLinked: 0,
            itemsTotal: itemList.length,
          });
          result.alreadyExists++;
          continue;
        }

        // Só importa/deduz pedidos em VENDA CONFIRMADA (PAID/SHIPPED/DELIVERED).
        // Espelha ML (getRecentOrders status="paid") e Shopee (API já devolve só
        // pós-venda); como o getRecentOrders da Magalu NÃO filtra por status,
        // pulamos PENDING/CANCELLED aqui — quando virarem pagos, o próximo ciclo
        // (poll/webhook) reimporta e desconta uma única vez. Evita baixar estoque
        // de pedido ainda não pago / depois cancelado.
        const mappedStatus = this.mapMagaluStatus(magaluOrder.status);
        if (
          mappedStatus !== "PAID" &&
          mappedStatus !== "SHIPPED" &&
          mappedStatus !== "DELIVERED"
        ) {
          // Antes era um `continue` mudo. Um pedido descartado aqui e um
          // pedido que nao existe para o sistema: sem Order, sem baixa de
          // estoque, sem aparecer no financeiro. Se o vocabulario de status
          // da API mudar, este log e o contador sao o unico aviso.
          const rawSkipped = this.normalizeMagaluStatus(magaluOrder.status);
          console.log(
            JSON.stringify({
              event: "magalu.order.skipped_status",
              externalOrderId,
              marketplaceAccountId,
              rawStatus: rawSkipped || null,
              mappedStatus,
            }),
          );
          result.skippedByStatus = (result.skippedByStatus ?? 0) + 1;
          if (rawSkipped && !result.skippedStatuses?.includes(rawSkipped)) {
            result.skippedStatuses = [
              ...(result.skippedStatuses ?? []),
              rawSkipped,
            ];
          }
          continue;
        }

        const { items, linkedCount } = await this.mapMagaluOrderItems(
          itemList,
          account.userId,
          marketplaceAccountId,
          listingMap,
        );

        if (items.length === 0) {
          result.results.push({
            success: false,
            orderId: null,
            externalOrderId,
            status: "no_products",
            message: "Nenhum item do pedido Magalu pôde ser vinculado",
            stockDeducted: false,
            itemsLinked: 0,
            itemsTotal: itemList.length,
          });
          result.noProducts++;
          // Venda existe na Magalu e NAO entrou no sistema: dinheiro perdido,
          // estoque estufado e oversell nos outros canais. Antes so havia um
          // console.log que ninguem le — agora aparece na tela de Logs.
          //
          // Dedupe por processo: um pedido sem vinculo NUNCA vira Order, entao
          // reaparece em todo ciclo do poll (15 min) enquanto estiver na janela.
          // Sem esta guarda seria um INSERT em SystemLog a cada ciclo, para
          // sempre, pelo mesmo pedido — a tabela cresceria sozinha e o alerta
          // viraria ruido. O alerta continua aparecendo uma vez por pedido; um
          // restart do processo pode reemiti-lo, o que e inofensivo.
          if (!OrderUseCase.magaluNoProductsLogged.has(externalOrderId)) {
            OrderUseCase.magaluNoProductsLogged.add(externalOrderId);
            void SystemLogService.logError(
              "SYNC_ORDERS",
              `Pedido Magalu #${externalOrderId} nao pode ser vinculado a nenhum produto`,
              {
                resource: "Order",
                details: {
                  externalOrderId,
                  marketplaceAccountId,
                  itemsTotal: itemList.length,
                  platform: "MAGALU",
                },
              },
            ).catch(() => {});
          }
          // A venda existe na Magalu. Antes o pedido nao entrava de forma alguma.
          // `mappedStatus` só é calculado mais abaixo no laço, então o status é
          // resolvido aqui mesmo — mesmo mapeamento, mesma função.
          const totalMagalu = (() => {
            const doPedido = magaluMoneyToNumber(magaluOrder.amounts);
            if (doPedido > 0) return doPedido;
            const cru =
              magaluOrder.total ?? magaluOrder.total_amount ?? magaluOrder.amount;
            return typeof cru === "number" && Number.isFinite(cru)
              ? Number(cru)
              : 0;
          })();

          const orderSemItens = await this.criarOrderSemItens({
            marketplaceAccountId,
            externalOrderId,
            status: this.mapMagaluStatus(magaluOrder.status),
            totalAmount: totalMagalu,
            customerName:
              magaluOrder.customer?.name ??
              magaluOrder.customer_name ??
              magaluOrder.buyer?.name ??
              undefined,
            soldAt: this.resolveSoldAt(magaluOrder.purchased_at),
            plataforma: "MAGALU",
            itemsTotal: itemList.length,
          });

          // Quarentena (auditoria 29/07/2026): o SystemLog acima nao tem userId,
          // logo NAO aparece na tela /logs do cliente — o filtro dela e
          // `userId IN (...)` e NULL nunca casa. A pendencia e o unico registro
          // que o dono dos dados ve, e a unica coisa que se resolve sozinha
          // quando ele cadastrar o produto.
          await this.registrarDesfechoIngestao({
            platform: "MAGALU",
            marketplaceAccountId,
            resultado: {
              success: false,
              orderId: orderSemItens,
              externalOrderId,
              status: "no_products",
              message: "Nenhum item do pedido Magalu pode ser vinculado",
              stockDeducted: false,
              itemsLinked: 0,
              itemsTotal: itemList.length,
            },
            esperavaBaixa: deductStock,
          });
          continue;
        }

        // Vinculo parcial: parte dos itens entrou, parte sumiu. O pedido e
        // criado (melhor que perder tudo), mas a baixa fica incompleta.
        if (linkedCount < itemList.length) {
          console.warn(
            JSON.stringify({
              event: "magalu.order.items_partially_linked",
              externalOrderId,
              marketplaceAccountId,
              linked: linkedCount,
              total: itemList.length,
            }),
          );
        }

        // `amounts.total` vem em CENTAVOS com o divisor no próprio objeto
        // ({ total: 19999, normalizer: 100 }) e já inclui o frete. Os campos
        // planos (total/total_amount/amount) nunca aparecem na API real, mas
        // seguem como fallback.
        const totalDoPedido = magaluMoneyToNumber(magaluOrder.amounts);
        const rawTotal =
          magaluOrder.total ?? magaluOrder.total_amount ?? magaluOrder.amount;
        const totalAmount =
          totalDoPedido > 0
            ? totalDoPedido
            : typeof rawTotal === "number" && Number.isFinite(rawTotal)
              ? Number(rawTotal)
              : items.reduce((sum, it) => sum + it.unitPrice * it.quantity, 0);

        const orderData: OrderCreate = {
          marketplaceAccountId,
          externalOrderId,
          status: mappedStatus,
          totalAmount,
          customerName:
            magaluOrder.customer?.name ??
            magaluOrder.customer_name ??
            magaluOrder.buyer?.name ??
            undefined,
          soldAt: this.resolveSoldAt(magaluOrder.purchased_at),
          items,
        };

        const created = await orderRepository.create(orderData);

        let stockDeducted = false;
        if (deductStock) {
          try {
            await this.deductStockForOrder(
              created,
              `Venda Magalu #${externalOrderId}`,
            );
            stockDeducted = true;
          } catch (err) {
            console.error(
              `[OrderUseCase] Falha ao descontar estoque para pedido Magalu #${externalOrderId} (order=${created.id}). Estoque NÃO foi descontado.`,
              err,
            );
            // O pedido JA foi criado, entao o ciclo seguinte o vera em
            // `already_exists` e nunca retentara a baixa: o estoque fica
            // estufado para sempre e sem rastro. Este SystemLog e o unico
            // aviso acionavel — sem ele o oversell so aparece na reclamacao
            // do comprador.
            void SystemLogService.logError(
              "SYNC_ORDERS",
              `Pedido Magalu #${externalOrderId} importado SEM baixa de estoque`,
              {
                resource: "Order",
                resourceId: created.id,
                details: {
                  externalOrderId,
                  orderId: created.id,
                  marketplaceAccountId,
                  platform: "MAGALU",
                  productIds: items.map((it) => it.productId),
                  error: err instanceof Error ? err.message : String(err),
                },
              },
            ).catch(() => {});
          }
        }

        result.imported++;
        result.stockDeductions += stockDeducted ? 1 : 0;
        const desfechoMagalu: ImportOrderResult = {
          success: true,
          orderId: created.id,
          externalOrderId,
          status: "imported",
          message: "Pedido Magalu importado com sucesso",
          stockDeducted,
          itemsLinked: linkedCount,
          itemsTotal: itemList.length,
        };
        result.results.push(desfechoMagalu);

        // Baixa que falhou ou vinculo parcial abrem pendencia; completo e com
        // baixa fecha a que existir. Antes, o pedido Magalu importado sem baixa
        // ficava "estufado para sempre e sem rastro" — o proprio comentario
        // acima dizia isso, e nada re-tentava.
        await this.registrarDesfechoIngestao({
          platform: "MAGALU",
          marketplaceAccountId,
          resultado: desfechoMagalu,
          esperavaBaixa: deductStock,
        });

        // ADITIVO (auto-cliente): best-effort, nunca afeta o import.
        // Kill-switch ORDER_AUTO_CUSTOMER_DISABLED=1 restaura o caminho atual
        // byte-idêntico. Try/catch próprio: um throw vazado cairia no catch
        // externo e empurraria um segundo result para o mesmo pedido.
        try {
          await OrderCustomerService.ensureCustomerForOrder({
            platform: "MAGALU",
            marketplaceAccountId,
            orderId: created.id,
            externalOrderId,
            fallbackName:
              magaluOrder.customer_name ?? magaluOrder.buyer?.name ?? null,
          });
        } catch {
          /* nunca propaga */
        }
      } catch (error) {
        const isPrismaUniqueError =
          error &&
          typeof error === "object" &&
          "code" in error &&
          (error as any).code === "P2002";
        if (isPrismaUniqueError) {
          result.results.push({
            success: true,
            orderId: null,
            externalOrderId,
            status: "already_exists",
            message: "Pedido já importado (corrida concorrente)",
            stockDeducted: false,
            itemsLinked: 0,
            itemsTotal: itemList.length,
          });
          result.alreadyExists++;
          continue;
        }
        result.errors++;
        result.results.push({
          success: false,
          orderId: null,
          externalOrderId,
          status: "error",
          message:
            error instanceof Error ? error.message : "Erro ao importar pedido",
          stockDeducted: false,
          itemsLinked: 0,
          itemsTotal: itemList.length,
        });
      }
    }

    return result;
  }

  private static async mapMagaluOrderItems(
    items: MagaluOrderItem[],
    userId: string | undefined,
    marketplaceAccountId: string,
    listingMap?: Map<string, any>,
  ): Promise<{ items: OrderItemCreate[]; linkedCount: number }> {
    const result: OrderItemCreate[] = [];
    let linkedCount = 0;

    for (const item of items) {
      // Shape REAL da Magalu (validado 28/07/2026): o SKU do vendedor está em
      // `item.info.sku`. Os campos de topo (`sku`, `seller_sku`, `product_id`)
      // nunca aparecem na API — ficam como fallback defensivo. O anúncio Magalu
      // é criado com `externalListingId = SKU`, então casar por `info.sku` é o
      // caminho principal, e `info.id` (UUID do produto na Magalu) o secundário.
      const externalListingId = String(
        item.info?.sku ??
          item.product_id ??
          item.sku ??
          item.seller_sku ??
          item.info?.id ??
          "",
      );
      const quantity = Number(item.quantity ?? item.qty ?? 0) || 0;
      // `unit_price` é objeto em centavos: { value: 19999, normalizer: 100 }.
      // O `Number(objeto)` anterior dava NaN → 0, zerando o valor do pedido.
      const unitPrice =
        magaluMoneyToNumber(item.unit_price) ||
        magaluMoneyToNumber(item.amounts) ||
        Number(item.price ?? 0) ||
        0;

      // A Magalu é o único mapper cuja quantidade cai para 0 quando o campo
      // real do payload tem outro nome (o tipo MagaluOrderItem é declaradamente
      // não-validado). Quantidade 0 faz `deductWithinTx` descontar zero em
      // silêncio — e SEM alerta de oversell, porque o alerta só dispara com
      // quantity > estoque. Este log é o único sinal de que a venda entrou sem
      // baixar estoque.
      if (quantity <= 0) {
        console.warn(
          JSON.stringify({
            event: "magalu.order.item_quantity_missing",
            externalListingId: externalListingId || null,
            marketplaceAccountId,
            itemKeys: Object.keys(item ?? {}),
          }),
        );
      }

      const cacheKey = `${marketplaceAccountId}_${externalListingId}`;
      const listing =
        externalListingId && listingMap
          ? listingMap.get(cacheKey)
          : externalListingId
            ? await prisma.productListing.findUnique({
                where: {
                  marketplaceAccountId_externalListingId: {
                    marketplaceAccountId,
                    externalListingId,
                  },
                },
                // EGRESS: idem ML — o consumo abaixo e so `productId`, `id` e a
                // existencia de `product`.
                select: {
                  id: true,
                  productId: true,
                  product: { select: { id: true } },
                },
              })
            : null;

      if (listing && listing.product) {
        result.push({
          productId: listing.productId,
          listingId: listing.id,
          quantity,
          unitPrice,
        });
        linkedCount++;
        continue;
      }

      const sku = this.extractSkuFromMagalu(item);
      if (!sku) {
        console.log(
          `[OrderUseCase] Item Magalu ${externalListingId || "(sem id)"} sem SKU e sem listing vinculado, pulando`,
        );
        continue;
      }

      const product = await this.findProductByFallbackSku(sku, userId);
      if (!product) {
        console.log(
          `[OrderUseCase] Produto com SKU "${sku}" (Magalu) não encontrado`,
        );
        continue;
      }

      const fallbackListing = await this.upsertFallbackListing({
        productId: product.id,
        marketplaceAccountId,
        externalListingId: externalListingId || sku,
        externalSku: sku,
      });

      result.push({
        productId: product.id,
        listingId: fallbackListing?.id ?? null,
        quantity,
        unitPrice,
      });
      linkedCount++;
    }

    return { items: result, linkedCount };
  }

  private static extractSkuFromMagalu(item: MagaluOrderItem): string | null {
    // `info.sku` PRIMEIRO: é onde a API real coloca o SKU do vendedor. Os
    // demais são fallback defensivo do shape antigo.
    return (
      (item.info?.sku as string) ||
      (item.seller_sku as string) ||
      (item.sku as string) ||
      (item.product_sku as string) ||
      null
    );
  }

  /**
   * Normaliza o campo `status` de um pedido Magalu para uma string simples.
   *
   * O tipo `MagaluOrder.status` e declarado como `string?`, mas o shape real do
   * JSON nunca foi confirmado contra a API (ver magalu-order.types.ts). Se a
   * Magalu devolver um objeto — `{ type: "approved" }`, `{ code: "shipped" }` —
   * o `String(...)` anterior produzia "[object Object]", que nao casa com
   * nenhum rotulo conhecido e faz TODO pedido cair no default PENDING e ser
   * descartado em silencio. Aqui o objeto e desembrulhado pelas chaves usuais.
   */
  static normalizeMagaluStatus(status: unknown): string {
    if (status == null) return "";
    if (typeof status === "string") return status.trim().toLowerCase();
    if (typeof status === "number") return String(status);
    if (typeof status === "object") {
      const o = status as Record<string, unknown>;
      for (const key of ["type", "code", "status", "name", "value", "slug"]) {
        const v = o[key];
        if (typeof v === "string" && v.trim().length > 0) {
          return v.trim().toLowerCase();
        }
      }
    }
    return "";
  }

  private static mapMagaluStatus(status?: unknown): OrderStatus {
    switch (this.normalizeMagaluStatus(status)) {
      case "delivered":
      // Variantes pt-BR. ADITIVAS: nenhum rotulo ja reconhecido muda de
      // significado. Sem elas, um vocabulario em portugues faria todo pedido
      // cair no default PENDING e ser descartado sem baixa de estoque.
      case "entregue":
        return "DELIVERED";
      case "shipped":
      case "sent":
      case "enviado":
      case "despachado":
        return "SHIPPED";
      case "approved":
      case "processing":
      case "invoiced":
      // "paid" nao estava na lista original — e o rotulo mais provavel de
      // venda confirmada e o mais caro de perder.
      case "paid":
      case "payment_approved":
      case "payment-approved":
      case "aprovado":
      case "pago":
      case "faturado":
      case "processando":
        return "PAID";
      case "cancelled":
      case "canceled":
      case "cancelado":
      case "unavailable":
      case "indisponivel":
        return "CANCELLED";
      case "new":
      default:
        return "PENDING";
    }
  }

  private static async getRecentMagaluOrdersWithRefresh(
    account: {
      id: string;
      accessToken: string;
      refreshToken: string | null;
    },
    days: number,
  ): Promise<MagaluOrder[]> {
    try {
      return await MagaluApiService.getRecentOrders(account.accessToken, days);
    } catch (error) {
      if (!this.isMarketplaceAuthError(error) || !account.refreshToken) {
        throw error;
      }

      const refreshed = await MagaluOAuthService.refreshAccessTokenForAccount(
        account.id,
        account.refreshToken,
      );

      await MarketplaceRepository.updateTokens(account.id, {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
      });

      return MagaluApiService.getRecentOrders(refreshed.accessToken, days);
    }
  }

  /**
   * Busca UM pedido Magalu por id, com o mesmo tratamento de token expirado do
   * poll. `MagaluApiService.getOrder` já existia e era código morto: o webhook
   * tinha o id em mãos e mesmo assim fazia poll genérico por janela de data.
   */
  private static async getMagaluOrderWithRefresh(
    account: {
      id: string;
      accessToken: string;
      refreshToken: string | null;
    },
    orderId: string,
  ): Promise<MagaluOrder | null> {
    try {
      return await MagaluApiService.getOrder(account.accessToken, orderId);
    } catch (error) {
      if (!this.isMarketplaceAuthError(error) || !account.refreshToken) {
        throw error;
      }

      const refreshed = await MagaluOAuthService.refreshAccessTokenForAccount(
        account.id,
        account.refreshToken,
      );

      await MarketplaceRepository.updateTokens(account.id, {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
      });

      return MagaluApiService.getOrder(refreshed.accessToken, orderId);
    }
  }

  private static async mapShopeeOrderItems(
    items: ShopeeOrderItem[],
    userId: string | undefined,
    marketplaceAccountId: string,
    listingMap?: Map<string, any>,
  ): Promise<{
    items: OrderItemCreate[];
    linkedCount: number;
    /**
     * Itens que NÃO puderam ser vinculados, com o motivo. Antes cada um destes
     * era só um `console.log` + `continue`: não havia como responder "o que
     * exatamente não vinculou neste pedido?" sem ler o log do processo. É o que
     * alimenta o detalhe da quarentena (OrderIngestionIssue).
     */
    unlinked: Array<{
      itemId: string;
      sku: string | null;
      reason: "ITEM_WITHOUT_SKU" | "PRODUCT_NOT_FOUND";
    }>;
  }> {
    const result: OrderItemCreate[] = [];
    const unlinked: Array<{
      itemId: string;
      sku: string | null;
      reason: "ITEM_WITHOUT_SKU" | "PRODUCT_NOT_FOUND";
    }> = [];
    let linkedCount = 0;

    // KILL-SWITCH: com "1", a cadeia volta a ser só (listing da conta → SKU
    // escopado por account.userId), byte-idêntica ao comportamento anterior.
    const matchFallbackAtivo =
      process.env.SHOPEE_ORDER_MATCH_FALLBACK_DISABLED !== "1";

    // Resolvido no máximo uma vez por pedido, e só quando algum item precisa
    // de fallback — o caminho feliz (listing da própria conta) não paga nada.
    let ownerIdCache: string | undefined | null = null;
    const ownerId = async (): Promise<string | undefined> => {
      if (ownerIdCache !== null) return ownerIdCache;
      ownerIdCache = await this.resolveDataOwnerId(userId);
      return ownerIdCache;
    };

    for (const item of items) {
      const externalListingId = item.item_id.toString();
      const cacheKey = `${marketplaceAccountId}_${externalListingId}`;

      // Use prefetched map if available, otherwise fallback to DB query
      const listing = listingMap
        ? listingMap.get(cacheKey)
        : await prisma.productListing.findUnique({
            where: {
              marketplaceAccountId_externalListingId: {
                marketplaceAccountId,
                externalListingId,
              },
            },
            // EGRESS: `include: { product: true }` puxava a linha inteira do
            // Product — `mlCatalogSnapshot`, `attributes`, `imageUrls` (3 JSONB
            // com detoast) e `description` — so para testar se o produto EXISTE.
            // O consumidor abaixo le apenas `listing.id`, `listing.productId` e a
            // existencia de `listing.product`. Mesmo select do caminho em lote
            // (convencao 2 do repo).
            select: {
              id: true,
              productId: true,
              marketplaceAccountId: true,
              externalListingId: true,
              product: { select: { id: true } },
            },
          });

      if (listing && listing.product) {
        result.push({
          productId: listing.productId,
          listingId: listing.id,
          quantity: item.model_quantity_purchased,
          unitPrice: Number(item.model_original_price ?? 0),
        });
        linkedCount++;
        continue;
      }

      // 2) O MESMO item_id, mas num listing pendurado em OUTRA conta do mesmo
      // tenant. Acontece quando o cliente desconecta e reconecta a Shopee: a
      // desconexão é "soft" quando há pedidos (zera tokens, marca a conta
      // INACTIVE) e os ProductListing continuam apontando para a conta antiga.
      // O listingMap é chaveado por `${marketplaceAccountId}_${externalListingId}`,
      // então nesse cenário a etapa 1 erra 100% das vezes. O ML já tinha
      // conserto para essa classe de bug (listing-ownership-repair); a Shopee
      // não tinha nenhum.
      if (matchFallbackAtivo) {
        const doTenant = await this.findShopeeListingInTenant(
          externalListingId,
          marketplaceAccountId,
          await ownerId(),
        );
        if (doTenant) {
          result.push({
            productId: doTenant.productId,
            listingId: doTenant.id,
            quantity: item.model_quantity_purchased,
            unitPrice: Number(item.model_original_price ?? 0),
          });
          linkedCount++;
          // Reaponta o listing para a conta ativa: idempotente e logado, para
          // que a próxima venda resolva já na etapa 1.
          await this.repointShopeeListing(
            doTenant.id,
            doTenant.marketplaceAccountId,
            marketplaceAccountId,
            externalListingId,
            doTenant.product?.userId ?? null,
          );
          continue;
        }
      }

      const sku = this.extractSkuFromShopee(item);
      if (!sku) {
        console.log(
          `[OrderUseCase] Item Shopee ${externalListingId} sem SKU e sem listing vinculado, pulando`,
        );
        unlinked.push({
          itemId: externalListingId,
          sku: null,
          reason: "ITEM_WITHOUT_SKU",
        });
        continue;
      }

      // 3) SKU do item contra Product.skuNormalized, escopado pelo DONO DOS
      // DADOS. Antes usava `account.userId` cru: se a conta Shopee tivesse sido
      // conectada por um colaborador, o produto existia e mesmo assim não era
      // encontrado — a venda não baixava estoque.
      let product = await this.findProductByFallbackSku(
        sku,
        matchFallbackAtivo ? await ownerId() : userId,
      );

      // 4) Último recurso: o mesmo texto contra o part number, e SOMENTE se o
      // resultado for único. Mais de um candidato ⇒ não vincula: baixar no
      // produto errado é pior do que não baixar.
      if (!product && matchFallbackAtivo) {
        product = await this.findProductByPartNumberUnique(
          sku,
          await ownerId(),
        );
      }

      if (!product) {
        console.log(
          `[OrderUseCase] Produto com SKU "${sku}" (Shopee) não encontrado`,
        );
        unlinked.push({
          itemId: externalListingId,
          sku,
          reason: "PRODUCT_NOT_FOUND",
        });
        continue;
      }

      const fallbackListing = await this.upsertFallbackListing({
        productId: product.id,
        marketplaceAccountId,
        externalListingId,
        externalSku: sku,
      });

      result.push({
        productId: product.id,
        listingId: fallbackListing?.id ?? null,
        quantity: item.model_quantity_purchased,
        unitPrice: Number(item.model_original_price ?? 0),
      });
      linkedCount++;
    }

    return { items: result, linkedCount, unlinked };
  }

  /**
   * Dono dos dados do tenant. Colaborador herda do admin — mesma regra do
   * `authMiddleware` (`user.parentUserId ?? user.id`).
   *
   * Existe porque o escopo do fallback por SKU usava `MarketplaceAccount.userId`
   * cru: numa conta conectada por colaborador, o produto existia e não era
   * encontrado, e a venda não baixava estoque.
   */
  private static async resolveDataOwnerId(
    userId?: string | null,
  ): Promise<string | undefined> {
    if (!userId) return undefined;
    try {
      const u = await prisma.user.findUnique({
        where: { id: userId },
        select: { parentUserId: true },
      });
      return u?.parentUserId ?? userId;
    } catch {
      // Nunca degradar para escopo mais amplo: na dúvida, o userId original.
      return userId;
    }
  }

  /**
   * Listing com este `externalListingId` em QUALQUER conta Shopee do mesmo
   * tenant, fora a conta atual. Cobre o listing pendurado em conta antiga
   * depois de desconectar/reconectar a Shopee.
   *
   * O `item_id` da Shopee é único por loja, então um listing com o mesmo id em
   * outra conta do mesmo dono é o MESMO anúncio com o vínculo desatualizado —
   * não é adivinhação.
   */
  private static async findShopeeListingInTenant(
    externalListingId: string,
    currentAccountId: string,
    ownerId?: string,
  ): Promise<any | null> {
    if (!ownerId) return null;
    try {
      return await prisma.productListing.findFirst({
        where: {
          externalListingId,
          marketplaceAccountId: { not: currentAccountId },
          marketplaceAccount: { platform: "SHOPEE", userId: ownerId },
          product: { is: {} },
        },
        select: {
          id: true,
          productId: true,
          marketplaceAccountId: true,
          product: { select: { id: true, userId: true } },
        },
      });
    } catch (err) {
      console.warn(
        `[OrderUseCase] Falha ao procurar listing Shopee ${externalListingId} nas demais contas do tenant:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /**
   * Reaponta o listing para a conta ativa. Best-effort: se falhar, a venda já
   * foi vinculada de qualquer forma — só a próxima vai precisar do fallback
   * de novo. Mesmo padrão do conserto de posse do ML.
   */
  private static async repointShopeeListing(
    listingId: string,
    fromAccountId: string,
    toAccountId: string,
    externalListingId: string,
    productUserId: string | null,
  ): Promise<void> {
    try {
      await ListingRepository.reassignAccount(listingId, toAccountId);
      console.log(
        JSON.stringify({
          event: "shopee.order_import.listing_repointed",
          listingId,
          externalListingId,
          fromAccountId,
          toAccountId,
        }),
      );
      if (productUserId) {
        // Este log LEVA userId de propósito: é uma correção no catálogo do
        // cliente, que ele tem direito de ver na tela dele.
        void SystemLogService.logListingOwnershipRepaired(
          productUserId,
          listingId,
          {
            externalListingId,
            oldAccountId: fromAccountId,
            newAccountId: toAccountId,
          },
        ).catch(() => {});
      }
    } catch (err) {
      console.warn(
        `[OrderUseCase] Falha ao reapontar listing ${listingId} para a conta ${toAccountId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Produto pelo part number, e SOMENTE quando houver exatamente um candidato.
   * Dois ou mais ⇒ devolve null: vincular o produto errado gera baixa no item
   * errado, que é pior do que não vincular.
   */
  private static async findProductByPartNumberUnique(
    sku: string,
    ownerId?: string,
  ): Promise<{ id: string } | null> {
    if (!ownerId) return null;
    const normalizado = normalizeSku(sku);
    if (!normalizado) return null;

    try {
      const candidatos = await prisma.product.findMany({
        where: { userId: ownerId, partNumberNormalized: normalizado },
        select: { id: true },
        take: 2,
      });
      if (candidatos.length !== 1) {
        if (candidatos.length > 1) {
          console.log(
            JSON.stringify({
              event: "shopee.order_import.part_number_ambiguous",
              sku: normalizado,
              candidatos: candidatos.length,
            }),
          );
        }
        return null;
      }
      return candidatos[0];
    } catch (err) {
      console.warn(
        `[OrderUseCase] Falha no fallback por part number ("${sku}"):`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  private static extractSkuFromShopee(item: ShopeeOrderItem): string | null {
    if (item.model_sku) return item.model_sku;
    if (item.item_sku) return item.item_sku;
    return null;
  }

  private static mapShopeeStatus(status: string): OrderStatus {
    // Kill-switch: restaura o switch anterior byte-a-byte. Relevante porque
    // TO_CONFIRM_RECEIVE já era importado e virava PENDING local — corrigir
    // isso muda o rótulo exibido em /pedidos para pedidos existentes.
    if (process.env.SHOPEE_ORDER_SYNC_BY_UPDATE_TIME_DISABLED === "1") {
      switch (status) {
        case "COMPLETED":
          return "DELIVERED";
        case "READY_TO_SHIP":
        case "PROCESSED":
        case "SHIPPED":
          return "SHIPPED";
        case "CANCELLED":
        case "IN_CANCEL":
          return "CANCELLED";
        case "UNPAID":
        default:
          return "PENDING";
      }
    }

    switch (status) {
      case "COMPLETED":
        return "DELIVERED";
      // TO_CONFIRM_RECEIVE já estava na lista de importação mas faltava aqui:
      // caía no `default` e virava PENDING local, com o estoque já baixado.
      case "TO_CONFIRM_RECEIVE":
      case "READY_TO_SHIP":
      case "PROCESSED":
      case "SHIPPED":
      // RETRY_SHIP = nova tentativa de coleta/envio; TO_RETURN = devolução
      // pedida sobre um pedido entregue. Nos dois a venda aconteceu e a peça
      // saiu do estoque — o estado local correto é SHIPPED, não PENDING.
      case "RETRY_SHIP":
      case "TO_RETURN":
        return "SHIPPED";
      // Pago, aguardando a NF-e do vendedor. É venda concretizada.
      case "INVOICE_PENDING":
        return "PAID";
      case "CANCELLED":
      case "IN_CANCEL":
        return "CANCELLED";
      case "UNPAID":
        return "PENDING";
      default:
        // Vocabulário novo da Shopee. Antes sumia calado em PENDING; agora
        // deixa rastro para sabermos que precisa entrar no switch.
        console.log(
          JSON.stringify({
            event: "shopee.order_import.status_unknown",
            status,
            mappedTo: "PENDING",
          }),
        );
        return "PENDING";
    }
  }

  private static async getRecentMLOrdersWithRefresh(
    account: {
      id: string;
      accessToken: string;
      refreshToken: string;
      externalUserId: string;
    },
    days: number,
    maxOrders: number = 500,
  ): Promise<MLOrderDetails[]> {
    try {
      return await MLApiService.getRecentOrders(
        account.accessToken,
        account.externalUserId,
        days,
        "paid",
        maxOrders,
      );
    } catch (error) {
      if (!this.isMarketplaceAuthError(error) || !account.refreshToken) {
        throw error;
      }

      const refreshed = await MLOAuthService.refreshAccessTokenForAccount(
        account.id,
        account.refreshToken,
      );

      await MarketplaceRepository.updateTokens(account.id, {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
      });

      return MLApiService.getRecentOrders(
        refreshed.accessToken,
        account.externalUserId,
        days,
        "paid",
        maxOrders,
      );
    }
  }

  private static async getRecentShopeeOrdersWithRefresh(
    account: {
      id: string;
      accessToken: string;
      refreshToken: string | null;
      shopId: number;
    },
    days: number,
    options?: {
      timeFrom?: number;
      timeRangeField?: "create_time" | "update_time";
      statusFilter?: "legacy_whitelist" | "exclude_non_sale";
      onStatusSkipped?: (orderSn: string, status: string) => void;
      /**
       * Pedidos buscados por `order_sn` ADEMAIS da janela. É o que o webhook
       * usa: a Shopee já disse qual pedido mudou, então não faz sentido varrer
       * a janela e torcer para ele estar lá.
       */
      orderSns?: string[];
    },
  ): Promise<ShopeeOrderDetail[]> {
    const fetchAll = async (token: string): Promise<ShopeeOrderDetail[]> => {
      // Busca DIRIGIDA: só os pedidos pedidos, SEM varrer a janela.
      //
      // Antes os dois caminhos eram somados. Custava caro: cada re-tentativa de
      // pendência fazia um `get_order_list` paginado, os `get_order_detail` de
      // tudo que caísse na janela e a releitura de TODOS os ProductListing da
      // conta (11.670 numa das contas de produção, porque `hasNewOrders` é
      // verdadeiro justamente quando o pedido pendente ainda não existe). Com 89
      // pendências abertas em produção, ~22x o tráfego de import de pedidos, de
      // hora em hora, para sempre.
      //
      // Varrer a janela aqui também nunca foi necessário: quem cobre a janela é
      // o poll, a cada 15 min. Mesmo critério de status do poll, para que um
      // pedido sem venda concretizada (UNPAID/cancelado) não entre por aqui.
      if (options?.orderSns?.length) {
        return ShopeeApiService.filterSaleOrders(
          await ShopeeApiService.getOrderDetails(
            token,
            account.shopId,
            options.orderSns,
          ),
          options,
        ) as ShopeeOrderDetail[];
      }

      // Sem `options` a chamada fica idêntica à anterior (3 argumentos) — é o
      // que o kill-switch precisa para ser byte-a-byte.
      return options
        ? ((await ShopeeApiService.getRecentOrders(
            token,
            account.shopId,
            days,
            options,
          )) as ShopeeOrderDetail[])
        : ((await ShopeeApiService.getRecentOrders(
            token,
            account.shopId,
            days,
          )) as ShopeeOrderDetail[]);
    };

    try {
      return await fetchAll(account.accessToken);
    } catch (error) {
      if (!this.isMarketplaceAuthError(error) || !account.refreshToken) {
        throw error;
      }

      const refreshed = await ShopeeOAuthService.refreshAccessToken(
        account.refreshToken,
        account.shopId,
      );

      await MarketplaceRepository.updateTokens(account.id, {
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token,
        expiresAt: ShopeeOAuthService.calculateExpiryDate(refreshed.expire_in),
      });

      return fetchAll(refreshed.access_token);
    }
  }

  private static isMarketplaceAuthError(error: unknown): boolean {
    const status =
      error &&
      typeof error === "object" &&
      "status" in error &&
      typeof (error as any).status === "number"
        ? (error as any).status
        : undefined;
    const message = error instanceof Error ? error.message : String(error);
    if (status === 401 || status === 403) {
      return true;
    }
    // `access[ _]token` cobre as duas grafias: o ML escreve "invalid access
    // token" e a Shopee "Invalid access_token, please have a check." — sondado
    // na API real em 29/07/2026. Hoje o erro da Shopee chega com status 403 e
    // já casaria pela linha acima, mas o regex era a única rede se ela passar
    // a devolver HTTP 200 com o erro no corpo (que é o formato dela em outras
    // chamadas, e nesse caminho o Error nem carrega `.status`).
    return /unauthorized|invalid access[ _]token|token expired|forbidden/i.test(
      message,
    );
  }

  /**
   * Desconta estoque dos produtos de um pedido de forma atômica.
   *
   * Wrapper fino sobre `StockDeductionService` (Fase 3 do plano venda-balcão).
   * O núcleo in-transação (FOR UPDATE → stockLog → advisory lock → upsert do
   * StockSyncJob) e o efeito pós-commit (setImmediate runOnce) vivem no
   * service compartilhado e são reutilizados pelo `FinanceUseCase.markPaid`.
   *
   * Comportamento preservado byte-idêntico: mesmos opts de tx
   * ({ timeout: 60_000, maxWait: 20_000 }), mesmo `logPrefix "[OrderUseCase]"`,
   * mesmo log de oversell ("Oversell detectado no pedido ${order.id}..."),
   * mesmo retorno `OrderStockDeduction[]`. `pauseOnZero` NÃO é passado —
   * Order não pausa anúncios ao zerar (opt-in apenas para venda balcão).
   */
  private static async deductStockForOrder(
    order: Order,
    reason: string,
    /**
     * ADITIVO (auditoria 29/07/2026). Presente APENAS no caminho de re-tentativa
     * (`retryStockDeduction`): faz a quantidade a baixar de cada produto ser
     * decidida DENTRO desta transação, depois dos locks, a partir do net do
     * `StockLog`.
     *
     * Por que precisa ser aqui e não no chamador: ler o net numa conexão
     * própria, fora de transação, e só depois abrir a transação da baixa é uma
     * corrida com decremento DUPLO — e o `SELECT ... FOR UPDATE` do Order abaixo
     * transforma a corrida em duplicação determinística, porque a segunda
     * execução espera a primeira commitar e então aplica o delta que calculou
     * com o net VELHO. O `processOrderCancellation` já fazia certo (ver
     * "Lock dos produtos ... ANTES do net"); a re-tentativa era o único caminho
     * de baixa fora desse padrão.
     *
     * Sem este parâmetro nada muda: `order.items` é baixado como vem, que é o
     * caminho do importador, byte-idêntico ao anterior.
     */
    netGuard?: { pedidoPorProduto: Map<string, number> },
  ): Promise<OrderStockDeduction[]> {
    const orderItems = order.items;
    if (!orderItems || orderItems.length === 0) return [];

    let deductions: OrderStockDeduction[] = [];
    let oversellAlerts: StockOversellAlert[] = [];

    try {
      await prisma.$transaction(
        async (tx) => {
          // ADITIVO (cancelamento): nunca baixar estoque de pedido já
          // CANCELLED. O SELECT FOR UPDATE na linha do Order serializa com o
          // claim do processOrderCancellation (updateMany na mesma linha):
          // se o cancelamento está em voo, esperamos o commit dele e lemos
          // CANCELLED ⇒ pulamos a baixa; se a baixa vence, o cancelamento
          // espera e o net do StockLog enxerga a baixa commitada ⇒ estorna.
          // Ordem de locks (Order → Products) idêntica nos dois lados ⇒ sem
          // deadlock. Fora do fluxo de cancelamento o status nunca é
          // CANCELLED neste ponto (pedido recém-criado) ⇒ comportamento
          // idêntico ao atual. Kill-switch restaura o caminho byte-idêntico.
          if (process.env.ORDER_CANCEL_RESTORE_DISABLED !== "1") {
            const fresh = await tx.$queryRaw<
              { status: string }[]
            >`SELECT status FROM "Order" WHERE id = ${order.id} FOR UPDATE`;
            if (fresh[0]?.status === "CANCELLED") {
              console.log(
                `[OrderUseCase] Pedido ${order.id} já cancelado — baixa de estoque pulada (${reason}).`,
              );
              return;
            }
          }
          let itemsParaBaixar = orderItems.map((i) => ({
            productId: i.productId,
            quantity: i.quantity,
          }));

          if (netGuard) {
            // Ordem de lock idêntica à do motor de estoque (que trava na ordem
            // de `input.items`) e à do cancelamento ⇒ sem deadlock.
            const productIds = [...netGuard.pedidoPorProduto.keys()];
            for (const productId of productIds) {
              await tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${productId} FOR UPDATE`;
            }

            // Com as linhas travadas, qualquer baixa concorrente já commitou:
            // agora o net é confiável.
            const grouped = await tx.stockLog.groupBy({
              by: ["productId"],
              where: { productId: { in: productIds }, reason },
              _sum: { change: true },
            });
            const netByProduct = new Map(
              grouped.map((g) => [g.productId, g._sum.change ?? 0]),
            );

            itemsParaBaixar = [];
            for (const productId of productIds) {
              const pedido = netGuard.pedidoPorProduto.get(productId) ?? 0;
              const jaBaixado = -(netByProduct.get(productId) ?? 0);
              const falta = pedido - jaBaixado;
              if (falta > 0) itemsParaBaixar.push({ productId, quantity: falta });
            }
          }

          // Sem netGuard a lista nunca é vazia (garantido acima) ⇒ o caminho do
          // importador segue chamando o motor exatamente como antes.
          if (itemsParaBaixar.length > 0) {
            const result = await StockDeductionService.deductWithinTx(tx, {
              items: itemsParaBaixar,
              reason,
              orderId: order.id,
              logPrefix: "[OrderUseCase]",
            });
            deductions = result.deductions;
            oversellAlerts = result.oversellAlerts;
          }

          // Marca de auditoria da baixa, na MESMA transação: ou as duas coisas
          // acontecem, ou nenhuma. Torna trivial a pergunta "quais pedidos
          // estão sem baixa?" (status <> CANCELLED AND stockDeductedAt IS NULL),
          // que antes exigia cruzar StockLog por `reason`, que é texto livre.
          // NÃO é a fonte de verdade da idempotência — essa continua sendo o
          // net do StockLog. Kill-switch restaura o caminho anterior.
          // Sem netGuard a condição é só a da env ⇒ caminho do importador
          // byte-idêntico. Com netGuard, não sobrescreve um carimbo que já
          // existe: perderia a hora da baixa original.
          const jaCarimbado = Boolean((order as { stockDeductedAt?: Date | null }).stockDeductedAt);
          if (
            process.env.ORDER_STOCK_DEDUCTED_AT_DISABLED !== "1" &&
            !(netGuard && jaCarimbado)
          ) {
            await tx.order.update({
              where: { id: order.id },
              data: { stockDeductedAt: new Date() },
            });
          }
        },
        { timeout: 60_000, maxWait: 20_000 },
      );
    } catch (error) {
      console.error(
        `[OrderUseCase] Error in stock deduction transaction (order=${order.id}):`,
        error,
      );
      throw error;
    }

    StockDeductionService.firePostEffects({
      deductions,
      logPrefix: "[OrderUseCase]",
      reason,
      // NÃO passamos pauseOnZero → Order não pausa anúncios ao zerar.
    });

    // Log de oversell preservado byte-idêntico (mesma message + details).
    if (oversellAlerts.length > 0) {
      try {
        await SystemLogService.logWarning(
          "OVERSELL_DETECTED",
          `Oversell detectado no pedido ${order.id}: ${oversellAlerts.length} item(ns) com quantidade maior que estoque disponível`,
          {
            resource: "Order",
            resourceId: order.id,
            details: {
              orderId: order.id,
              platform: order.marketplaceAccount?.platform ?? null,
              items: oversellAlerts,
              reason,
            },
          },
        );
      } catch (logError) {
        console.error(
          "[OrderUseCase] Falha ao registrar OVERSELL_DETECTED:",
          logError,
        );
      }
    }

    return deductions;
  }

  /**
   * Cancela um pedido JÁ IMPORTADO devolvendo ao estoque exatamente o que
   * foi baixado na importação e reabrindo anúncios cujos produtos saíram de
   * zero (`firePostEffects.reopenOnRefill` — paused→active nas 3 plataformas).
   *
   * Idempotência (webhooks repetem; chamadas concorrem):
   *  1. Claim atômico por transição de status na MESMA tx do estorno —
   *     qualquer status ≠ CANCELLED → CANCELLED via updateMany; quem não
   *     vence o claim não estorna. Já CANCELLED → no-op sem abrir tx.
   *     PENDING também entra no claim: existem pedidos PENDING COM baixa
   *     (ex.: Shopee TO_CONFIRM_RECEIVE mapeia para PENDING e o importador
   *     Shopee deduz incondicionalmente) — o net do StockLog decide se há
   *     algo a estornar (pedido sem baixa ⇒ net 0 ⇒ só status).
   *  2. Quantidades pelo "net" do StockLog (baixa − estornos anteriores, com
   *     teto na quantidade do pedido) — estorna só o que foi de fato baixado
   *     (cobre baixa clampada por oversell, pedido sem baixa e flip-flop de
   *     status via PATCH manual).
   *
   * NUNCA lança: os callers são setImmediate fire-and-forget (webhooks) e o
   * loop de poll — erro vira `{ action: "error" }` + SystemLog, e o rollback
   * da tx deixa o estado consistente para a próxima entrega/poll.
   * Kill-switch: ORDER_CANCEL_RESTORE_DISABLED=1 desliga tudo.
   */
  static async processOrderCancellation(params: {
    marketplaceAccountId: string;
    externalOrderId: string;
    platformLabel: "ML" | "Shopee" | "Magalu";
    logPrefix?: string;
  }): Promise<OrderCancellationResult> {
    const { marketplaceAccountId, externalOrderId, platformLabel } = params;
    const logPrefix = params.logPrefix ?? "[OrderUseCase]";
    try {
      if (process.env.ORDER_CANCEL_RESTORE_DISABLED === "1") {
        return {
          success: true,
          orderId: null,
          externalOrderId,
          action: "disabled",
          restoredItems: 0,
        };
      }

      const order = await prisma.order.findFirst({
        where: { marketplaceAccountId, externalOrderId },
        select: {
          id: true,
          status: true,
          items: { select: { productId: true, quantity: true } },
          marketplaceAccount: { select: { userId: true } },
        },
      });
      if (!order) {
        return {
          success: true,
          orderId: null,
          externalOrderId,
          action: "not_found",
          restoredItems: 0,
        };
      }
      if (order.status === "CANCELLED") {
        return {
          success: true,
          orderId: order.id,
          externalOrderId,
          action: "already_cancelled",
          restoredItems: 0,
        };
      }

      // Reasons determinísticas: a da baixa é a string EXATA escrita na
      // importação; estorno e reativação (un-cancel) entram no mesmo net
      // (repetição ⇒ net 0; alternância cancel/un-cancel converge).
      const deductionReason = `Venda ${platformLabel} #${externalOrderId}`;
      const restoreReason = `Estorno venda ${platformLabel} #${externalOrderId}`;
      const reactivateReason = `Reativação venda ${platformLabel} #${externalOrderId}`;

      // Teto do estorno por produto (agrega itens repetidos do mesmo produto).
      const orderedQty = new Map<string, number>();
      for (const item of order.items) {
        orderedQty.set(
          item.productId,
          (orderedQty.get(item.productId) ?? 0) + item.quantity,
        );
      }
      const productIds = [...orderedQty.keys()];

      let restorations: StockDeductionResult[] = [];
      let action: OrderCancellationResult["action"] = "already_cancelled";

      await prisma.$transaction(
        async (tx) => {
          // 1. Claim atômico: só quem transiciona o status estorna
          //    (concorrente bloqueia no row-lock e reavalia ⇒ count 0).
          //    PENDING incluso — o net do StockLog decide o estorno.
          const claimed = await tx.order.updateMany({
            where: {
              id: order.id,
              status: { in: ["PENDING", "PAID", "SHIPPED", "DELIVERED"] },
            },
            data: { status: "CANCELLED" },
          });
          if (claimed.count === 0) {
            action = "already_cancelled";
            return;
          }

          if (productIds.length === 0) {
            action = "cancelled_no_restore";
            return;
          }

          // 2. Lock dos produtos (mesma ordem de lock do motor de estoque)
          //    ANTES do net — serializa com uma baixa em voo do importador.
          for (const productId of productIds) {
            await tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${productId} FOR UPDATE`;
          }

          // 3. Net do StockLog: baixa + re-deduções de reativação (change<0)
          //    e estornos anteriores (change>0) ⇒ a estornar = max(0, -Σ),
          //    com teto no pedido.
          const grouped = await tx.stockLog.groupBy({
            by: ["productId"],
            where: {
              productId: { in: productIds },
              reason: {
                in: [deductionReason, restoreReason, reactivateReason],
              },
            },
            _sum: { change: true },
          });
          const netByProduct = new Map(
            grouped.map((g) => [g.productId, g._sum.change ?? 0]),
          );
          const items = productIds
            .map((productId) => ({
              productId,
              quantity: Math.min(
                Math.max(0, -(netByProduct.get(productId) ?? 0)),
                orderedQty.get(productId)!,
              ),
            }))
            .filter((i) => i.quantity > 0);

          if (items.length === 0) {
            action = "cancelled_no_restore";
            return;
          }

          const result = await StockDeductionService.restoreWithinTx(tx, {
            items,
            reason: restoreReason,
            orderId: order.id,
            logPrefix,
          });
          restorations = result.deductions;
          action = "cancelled_restored";
        },
        { timeout: 60_000, maxWait: 20_000 },
      );

      // Pós-commit: sync de estoque + reabertura de anúncios que saíram de
      // zero. Best-effort, fora da tx (espelha FinanceUseCase.reverse).
      // SEM pauseOnZero — pedido não pausa anúncios. force: quando o estoque
      // zera por venda de marketplace, o sync pausa o item ML só REMOTAMENTE
      // (status local segue "active") — sem force, o fast-path alreadyInState
      // do updateListingStatus faria no-op e o anúncio ficaria pausado para
      // sempre apesar do estoque restaurado.
      if (restorations.length > 0) {
        StockDeductionService.firePostEffects({
          deductions: restorations,
          logPrefix,
          reopenOnRefill: {
            userId: order.marketplaceAccount.userId,
            force: true,
          },
        });
      }

      void SystemLogService.logInfo(
        "ORDER_CANCEL_RESTORE",
        `Pedido ${platformLabel} #${externalOrderId} cancelado (${action})`,
        {
          resource: "Order",
          resourceId: order.id,
          details: {
            action,
            marketplaceAccountId,
            externalOrderId,
            restored: restorations.map((r) => ({
              productId: r.productId,
              quantity: r.quantity,
              previousStock: r.previousStock,
              newStock: r.newStock,
            })),
          },
        },
      ).catch(() => {});

      return {
        success: true,
        orderId: order.id,
        externalOrderId,
        action,
        restoredItems: restorations.length,
      };
    } catch (error) {
      console.error(
        `${logPrefix} Falha no cancelamento ${platformLabel} #${externalOrderId}:`,
        error,
      );
      void SystemLogService.logError(
        "ORDER_CANCEL_RESTORE_FAILED",
        `Falha ao processar cancelamento do pedido ${platformLabel} #${externalOrderId}`,
        {
          resource: "Order",
          details: {
            marketplaceAccountId,
            externalOrderId,
            error: error instanceof Error ? error.message : String(error),
          },
        },
      ).catch(() => {});
      return {
        success: false,
        orderId: null,
        externalOrderId,
        action: "error",
        restoredItems: 0,
        message: error instanceof Error ? error.message : "Erro desconhecido",
      };
    }
  }

  /**
   * Reativa um pedido CANCELLED (un-cancel via PATCH manual) re-deduzindo o
   * estoque que o cancelamento estornou — simétrico ao
   * `processOrderCancellation`, mesmo claim atômico e mesma ordem de locks
   * (Order → Products).
   *
   * Net separável por reason: a re-dedução escreve com reason PRÓPRIA
   * ("Reativação venda <Label> #<extId>") — a deduzir =
   * max(0, Σ[estorno, reativação]) com teto na quantidade do pedido.
   * Repetição ⇒ 0; pedido cujo cancelamento nada estornou ⇒ 0 (nunca deduz
   * estoque "novo"); alternância cancel/un-cancel converge porque o net do
   * cancelamento também soma a reason de reativação.
   *
   * Se a peça foi vendida em outro canal nesse meio-tempo, o clamp do
   * `deductWithinTx` deduz o disponível e o oversell é alertado (mesmo
   * mecanismo da importação).
   *
   * NUNCA lança — o caller (rota PATCH) decide o HTTP pelo retorno.
   * Kill-switch: ORDER_CANCEL_RESTORE_DISABLED=1 desliga tudo.
   */
  static async processOrderUncancellation(params: {
    marketplaceAccountId: string;
    externalOrderId: string;
    platformLabel: "ML" | "Shopee" | "Magalu";
    targetStatus: "PAID" | "SHIPPED" | "DELIVERED";
    logPrefix?: string;
  }): Promise<OrderUncancellationResult> {
    const { marketplaceAccountId, externalOrderId, platformLabel } = params;
    const logPrefix = params.logPrefix ?? "[OrderUseCase]";
    try {
      if (process.env.ORDER_CANCEL_RESTORE_DISABLED === "1") {
        return {
          success: true,
          orderId: null,
          externalOrderId,
          action: "disabled",
          deductedItems: 0,
        };
      }

      const order = await prisma.order.findFirst({
        where: { marketplaceAccountId, externalOrderId },
        select: {
          id: true,
          status: true,
          items: { select: { productId: true, quantity: true } },
          marketplaceAccount: { select: { platform: true } },
        },
      });
      if (!order) {
        return {
          success: true,
          orderId: null,
          externalOrderId,
          action: "not_found",
          deductedItems: 0,
        };
      }
      if (order.status !== "CANCELLED") {
        return {
          success: true,
          orderId: order.id,
          externalOrderId,
          action: "not_cancelled",
          deductedItems: 0,
        };
      }

      const restoreReason = `Estorno venda ${platformLabel} #${externalOrderId}`;
      const reactivateReason = `Reativação venda ${platformLabel} #${externalOrderId}`;

      const orderedQty = new Map<string, number>();
      for (const item of order.items) {
        orderedQty.set(
          item.productId,
          (orderedQty.get(item.productId) ?? 0) + item.quantity,
        );
      }
      const productIds = [...orderedQty.keys()];

      let deductions: StockDeductionResult[] = [];
      let oversellAlerts: StockOversellAlert[] = [];
      let action: OrderUncancellationResult["action"] = "not_cancelled";

      await prisma.$transaction(
        async (tx) => {
          // 1. Claim atômico CANCELLED → targetStatus (concorrente ⇒ count 0).
          const claimed = await tx.order.updateMany({
            where: { id: order.id, status: "CANCELLED" },
            data: { status: params.targetStatus },
          });
          if (claimed.count === 0) {
            action = "not_cancelled";
            return;
          }

          if (productIds.length === 0) {
            action = "reactivated_no_deduct";
            return;
          }

          // 2. Lock dos produtos (mesma ordem do motor) antes do net.
          for (const productId of productIds) {
            await tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${productId} FOR UPDATE`;
          }

          // 3. Net dos estornos: estornos (+) − reativações anteriores (−)
          //    ⇒ a re-deduzir = max(0, Σ), com teto no pedido. Só desfaz o
          //    que o cancelamento fez — nunca cria dedução "nova".
          const grouped = await tx.stockLog.groupBy({
            by: ["productId"],
            where: {
              productId: { in: productIds },
              reason: { in: [restoreReason, reactivateReason] },
            },
            _sum: { change: true },
          });
          const netByProduct = new Map(
            grouped.map((g) => [g.productId, g._sum.change ?? 0]),
          );
          const items = productIds
            .map((productId) => ({
              productId,
              quantity: Math.min(
                Math.max(0, netByProduct.get(productId) ?? 0),
                orderedQty.get(productId)!,
              ),
            }))
            .filter((i) => i.quantity > 0);

          if (items.length === 0) {
            action = "reactivated_no_deduct";
            return;
          }

          const result = await StockDeductionService.deductWithinTx(tx, {
            items,
            reason: reactivateReason,
            orderId: order.id,
            logPrefix,
          });
          deductions = result.deductions;
          oversellAlerts = result.oversellAlerts;
          action = "reactivated_rededucted";
        },
        { timeout: 60_000, maxWait: 20_000 },
      );

      // Pós-commit: propaga o estoque re-deduzido aos marketplaces.
      // SEM pauseOnZero (pedido não pausa anúncios — o sync remoto pausa o
      // ML quando a quantidade chega a 0, como na importação).
      if (deductions.length > 0) {
        StockDeductionService.firePostEffects({
          deductions,
          logPrefix,
        });
      }

      // Peça vendida em outro canal enquanto o pedido esteve cancelado —
      // mesmo alerta de oversell da importação.
      if (oversellAlerts.length > 0) {
        try {
          await SystemLogService.logWarning(
            "OVERSELL_DETECTED",
            `Oversell detectado ao reativar o pedido ${order.id}: ${oversellAlerts.length} item(ns) com quantidade maior que estoque disponível`,
            {
              resource: "Order",
              resourceId: order.id,
              details: {
                orderId: order.id,
                platform: order.marketplaceAccount?.platform ?? null,
                items: oversellAlerts,
                reason: reactivateReason,
              },
            },
          );
        } catch (logError) {
          console.error(
            `${logPrefix} Falha ao registrar OVERSELL_DETECTED (reativação):`,
            logError,
          );
        }
      }

      void SystemLogService.logInfo(
        "ORDER_UNCANCEL_REDEDUCT",
        `Pedido ${platformLabel} #${externalOrderId} reativado para ${params.targetStatus} (${action})`,
        {
          resource: "Order",
          resourceId: order.id,
          details: {
            action,
            marketplaceAccountId,
            externalOrderId,
            targetStatus: params.targetStatus,
            deducted: deductions.map((d) => ({
              productId: d.productId,
              quantity: d.quantity,
              previousStock: d.previousStock,
              newStock: d.newStock,
            })),
          },
        },
      ).catch(() => {});

      return {
        success: true,
        orderId: order.id,
        externalOrderId,
        action,
        deductedItems: deductions.length,
      };
    } catch (error) {
      console.error(
        `${logPrefix} Falha na reativação ${platformLabel} #${externalOrderId}:`,
        error,
      );
      void SystemLogService.logError(
        "ORDER_UNCANCEL_REDEDUCT",
        `Falha ao reativar o pedido ${platformLabel} #${externalOrderId}`,
        {
          resource: "Order",
          details: {
            marketplaceAccountId,
            externalOrderId,
            error: error instanceof Error ? error.message : String(error),
          },
        },
      ).catch(() => {});
      return {
        success: false,
        orderId: null,
        externalOrderId,
        action: "error",
        deductedItems: 0,
        message: error instanceof Error ? error.message : "Erro desconhecido",
      };
    }
  }

  private static async syncMarketplaceStockForProducts(
    productIds: string[],
    context: SyncLogContext = {},
  ): Promise<void> {
    const uniqueProductIds = [...new Set(productIds.filter(Boolean))];
    if (uniqueProductIds.length === 0) return;

    const syncResults = await Promise.allSettled(
      uniqueProductIds.map((productId) =>
        SyncUseCase.syncProductStock(productId),
      ),
    );

    let totalListings = 0;
    let successCount = 0;
    let failureCount = 0;
    const failedPlatforms = new Set<string>();

    syncResults.forEach((result, index) => {
      const productId = uniqueProductIds[index];
      if (result.status === "rejected") {
        failureCount++;
        failedPlatforms.add("UNKNOWN");
        console.error(
          `[OrderUseCase] Error syncing marketplace stock for product ${productId}:`,
          result.reason,
        );
        return;
      }

      totalListings += result.value.length;
      successCount += result.value.filter((entry) => entry.success).length;
      const failedListings = result.value.filter(
        (entry) => !entry.success,
      ).length;
      failureCount += failedListings;

      result.value
        .filter((entry) => !entry.success)
        .forEach((entry) => failedPlatforms.add(entry.platform ?? "UNKNOWN"));

      if (failedListings > 0) {
        console.warn(
          `[OrderUseCase] Marketplace stock sync finished with ${failedListings} failed listing(s) for product ${productId}`,
        );
      }
    });

    const details = {
      orderId: context.orderId ?? null,
      platform: context.platform ?? "UNKNOWN",
      totalListings,
      successCount,
      failureCount,
      failedPlatforms: [...failedPlatforms],
      productIds: uniqueProductIds,
    };

    const message =
      failureCount > 0
        ? `Sincronização cross-marketplace do pedido ${context.orderId ?? "sem-id"} finalizada com falhas parciais`
        : `Sincronização cross-marketplace do pedido ${context.orderId ?? "sem-id"} concluída`;

    try {
      if (failureCount > 0) {
        await SystemLogService.logWarning("SYNC_STOCK", message, {
          resource: "Order",
          resourceId: context.orderId,
          details,
        });
      } else {
        await SystemLogService.logInfo("SYNC_STOCK", message, {
          resource: "Order",
          resourceId: context.orderId,
          details,
        });
      }
    } catch (error) {
      console.error(
        "[OrderUseCase] Falha ao registrar log agregado de sincronização:",
        error,
      );
    }
  }

  /**
   * Mapeia status do ML para status local
   */
  private static mapMLStatusToLocal(
    mlStatus: string,
  ): "PENDING" | "PAID" | "SHIPPED" | "DELIVERED" | "CANCELLED" {
    switch (mlStatus) {
      case "paid":
        return "PAID";
      case "shipped":
        return "SHIPPED";
      case "delivered":
        return "DELIVERED";
      case "cancelled":
        return "CANCELLED";
      default:
        return "PENDING";
    }
  }

  /**
   * Extrai nome do cliente do pedido ML
   */
  private static extractCustomerName(
    mlOrder: MLOrderDetails,
  ): string | undefined {
    const buyer = mlOrder.buyer;
    if (buyer.first_name && buyer.last_name) {
      return `${buyer.first_name} ${buyer.last_name}`;
    }
    if (buyer.nickname) {
      return buyer.nickname;
    }
    return undefined;
  }

  /**
   * Registra log de sincronização
   */
  private static async logSync(
    marketplaceAccountId: string,
    type: SyncType,
    status: SyncStatus,
    message: string,
    payload?: object,
  ): Promise<void> {
    await prisma.syncLog.create({
      data: {
        marketplaceAccountId,
        type,
        status,
        message,
        payload: payload as object | undefined,
      },
    });
  }

  /**
   * Busca pedidos importados de um usuário
   */
  static async getOrders(
    userId: string,
    options?: {
      status?: string;
      platform?: string;
      search?: string;
      page?: number;
      limit?: number;
      dateFrom?: Date;
      dateTo?: Date;
      amountMin?: number;
      amountMax?: number;
    },
  ) {
    // EGRESS: a lista de pedidos NÃO traz o grafo de itens — só uma miniatura
    // leve do 1º item (`thumbnail`) + a contagem (`itemCount`). O sheet recarrega
    // o pedido completo via GET /orders/:id ao abrir. `findAllForList` também
    // aplica os filtros de período (data) e faixa de valor (preço).
    return orderRepository.findAllForList({
      userId,
      status: options?.status as any,
      platform: options?.platform,
      search: options?.search,
      page: options?.page,
      limit: options?.limit,
      dateFrom: options?.dateFrom,
      dateTo: options?.dateTo,
      amountMin: options?.amountMin,
      amountMax: options?.amountMax,
    });
  }

  /**
   * Busca detalhes de um pedido (escopado pelo dono quando `userId` informado).
   */
  static async getOrderById(
    orderId: string,
    userId?: string,
  ): Promise<Order | null> {
    return orderRepository.findById(orderId, userId);
  }
}
