import {
  ListingUseCase,
  ListingFullEditInput,
} from "../usecases/listing.usercase";
import { ProductRepositoryPrisma } from "../../repositories/product.repository";
import prisma from "../../lib/prisma";
import {
  applyRules,
  computeBulkPrice,
  toNum,
  type BulkRulesProductInput,
} from "./bulk-listing-rules.service";
import { computeStaggeredPrice } from "./cross-account-price.service";
import type {
  BulkOverrideTemplate,
  BulkListingItemResult,
  BulkListingPlatform,
  PerProductMlOverride,
} from "../repositories/bulk-listing-job.repository";
import { SystemLogService } from "../../services/system-log.service";

export type ListingPlatform = "MERCADO_LIVRE" | "SHOPEE" | "MAGALU";

export interface ListingDispatchRequest {
  platform: ListingPlatform;
  accountId?: string;
  categoryId?: string;
  mlSettings?: {
    listingType?: string;
    hasWarranty?: boolean;
    warrantyUnit?: string;
    warrantyDuration?: number;
    itemCondition?: string;
    shippingMode?: string;
    freeShipping?: boolean;
    localPickup?: boolean;
    manufacturingTime?: number;
  };
}

export interface ListingDispatchInput {
  userId: string;
  productId: string;
  requests: ListingDispatchRequest[];
  // Overrides opcionais aplicados APÓS a criação de cada anúncio (ex.: aumento
  // percentual escalonado entre contas ML). Quando ausente, o fluxo é idêntico
  // ao de hoje (nenhum override, nenhuma busca extra de produto).
  overrideTemplate?: BulkOverrideTemplate | null;
  // Id do ATOR (colaborador) que disparou a criação, p/ atribuir o log
  // `CREATE_LISTING` de produtividade. Ausente em fluxos de sistema/sem ator —
  // nesse caso nenhum log de produtividade é gravado (não fabricamos ator).
  actorId?: string;
}

export interface BulkRunRequest {
  platform: BulkListingPlatform;
  accountId: string;
  categoryId?: string;
  mlSettings?: ListingDispatchRequest["mlSettings"];
}

/**
 * Mescla os mlSettings do request global com o override por produto (modo
 * Revisão individual). O override por produto vence; campos ausentes caem no
 * request global. Não inclui categoria (resolvida à parte) nem attributes/preço
 * (aplicados pós-create). Retorna `undefined` se nada restar.
 */
function mergePerProductMlSettings(
  base: ListingDispatchRequest["mlSettings"],
  ov: PerProductMlOverride,
): ListingDispatchRequest["mlSettings"] {
  const merged: NonNullable<ListingDispatchRequest["mlSettings"]> = {
    ...(base ?? {}),
  };
  const pick = <K extends keyof NonNullable<ListingDispatchRequest["mlSettings"]>>(
    key: K,
    value: NonNullable<ListingDispatchRequest["mlSettings"]>[K] | undefined,
  ) => {
    if (value !== undefined) merged[key] = value;
  };
  pick("listingType", ov.listingType);
  pick("itemCondition", ov.itemCondition);
  pick("hasWarranty", ov.hasWarranty);
  pick("warrantyUnit", ov.warrantyUnit);
  pick("warrantyDuration", ov.warrantyDuration);
  pick("shippingMode", ov.shippingMode);
  pick("freeShipping", ov.freeShipping);
  pick("localPickup", ov.localPickup);
  pick("manufacturingTime", ov.manufacturingTime);
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export interface ListingDispatchSnapshot {
  queued: Array<{
    platform: ListingPlatform;
    accountId?: string;
  }>;
}

/**
 * Kill-switch do escalonamento de preço entre contas para Shopee/Magalu.
 * Com CROSS_ACCOUNT_STAGGER_MARKETPLACES_DISABLED=1, os builders deixam de
 * popular os mapas de índice Shopee/Magalu E o apply deixa de LÊ-los (cobre
 * jobs já persistidos com mapas novos, ex.: retry-failed) — revertendo ao
 * comportamento ML-only anterior. O caminho ML nunca é afetado pelo switch.
 */
export function crossMarketplaceStaggerDisabled(): boolean {
  return process.env.CROSS_ACCOUNT_STAGGER_MARKETPLACES_DISABLED === "1";
}

/**
 * Ponto único de orquestração para criação de anúncios em múltiplos
 * marketplaces. Substitui os blocos fire-and-forget duplicados em
 * `POST /products` (criação) e, futuramente, no fluxo de edição.
 *
 * Comportamento atual (slice 1 da Fase 3):
 *  - Fire-and-forget por request (platform × account).
 *  - Erros individuais são logados mas não propagam — caller recebe o
 *    snapshot do que foi enfileirado imediatamente.
 *  - Preflight, persistência de status e polling serão adicionados em
 *    slices futuros sem quebrar callers.
 */
export class ListingDispatcher {
  static dispatch(input: ListingDispatchInput): ListingDispatchSnapshot {
    const { userId, productId, requests, overrideTemplate, actorId } = input;
    const queued: ListingDispatchSnapshot["queued"] = requests.map((req) => ({
      platform: req.platform,
      accountId: req.accountId,
    }));

    console.log(
      JSON.stringify({
        event: "listing.dispatch",
        productId,
        userId,
        count: queued.length,
        platforms: queued.map((q) => q.platform),
      }),
    );

    if (overrideTemplate) {
      // Caminho com overrides (ex.: aumento escalonado entre contas): busca o
      // produto UMA vez (preço base) e dispara cada request com o template, que
      // é aplicado via updateListingFields após a criação.
      void (async () => {
        let productRules: BulkRulesProductInput | undefined;
        try {
          // Egress: espelho do productRulesCache do dispatchBatch — applyRules
          // só precisa de (id, name, price, costPrice); `rulesLite` evita a
          // row inteira (JSONBs pesados) + compatibilidades, e escopa por
          // userId (isolamento multi-tenant, padrão do hardening). Se a query
          // falhar, o fallback do applyOverridesAfterCreate cobre.
          const p = await new ProductRepositoryPrisma().findById(
            productId,
            userId,
            { rulesLite: true },
          );
          if (p) {
            productRules = {
              id: p.id,
              name: p.name,
              price: p.price as unknown as number | { toNumber(): number },
              costPrice: p.costPrice as unknown as
                | number
                | { toNumber(): number }
                | null
                | undefined,
            };
          }
        } catch (e) {
          console.warn(
            "[ListingDispatcher] falha ao carregar produto p/ overrides:",
            e instanceof Error ? e.message : e,
          );
        }
        for (const req of requests) {
          void this.runOne(
            userId,
            productId,
            req,
            overrideTemplate,
            productRules,
            actorId,
          );
        }
      })();
    } else {
      // Caminho atual (sem overrides): dispara síncrono, comportamento idêntico.
      for (const req of requests) {
        void this.runOne(userId, productId, req, undefined, undefined, actorId);
      }
    }

    return { queued };
  }

  private static async runOne(
    userId: string,
    productId: string,
    req: ListingDispatchRequest,
    overrideTemplate?: BulkOverrideTemplate | null,
    productRules?: BulkRulesProductInput,
    actorId?: string,
  ): Promise<void> {
    // Observabilidade simétrica ML↔Shopee. createMLListing e createShopeeListing
    // ambos retornam CreateListingResult com `success: boolean`. Antes desta
    // simetria, ML descartava o retorno e falhas "normais" (success: false sem
    // throw) ficavam invisíveis — o placeholder PENDING_ era criado, status ia
    // pra "error" no banco, mas nada aparecia no log. O usuário só percebia
    // pelo ícone dimmed no frontend.
    try {
      if (req.platform === "MERCADO_LIVRE") {
        const result = await ListingUseCase.createMLListing(
          userId,
          productId,
          req.categoryId,
          req.accountId,
          req.mlSettings,
          undefined, // titleOverride
          actorId,
          // Simetria com runOneWithResult: o código OEM não pode chegar pelo
          // update pós-criação (o ML não aceita alterá-lo). Aqui costuma ser
          // no-op, porque o fluxo single já gravou o OEM em Product.attributes
          // e o produto tem precedência sobre o override.
          overrideTemplate?.perProductOverrides?.[productId]?.ml?.attributes,
        );
        this.logDispatchResult({
          userId,
          productId,
          req,
          success: !!result.success,
          listingId: (result as any).listingId,
          externalListingId: (result as any).externalListingId,
          error: result.success ? null : result.error || null,
          mlError: (result as any).mlError || null,
        });
        if (!result.success) {
          console.error(
            `[ListingDispatcher] MERCADO_LIVRE listing failed (product=${productId}, account=${req.accountId}): ${result.error}`,
          );
          return;
        }
        // Produtividade: 1 CREATE_LISTING por anúncio criado, atribuído ao ator.
        this.logCreatedListing(
          actorId,
          (result as any).listingId,
          productId,
          "MERCADO_LIVRE",
        );
        // Sucesso na criação — aplica overrides (ex.: aumento escalonado entre
        // contas ML) se houver template. Sem template, nada muda (fluxo atual).
        if (overrideTemplate && (result as any).listingId) {
          await this.applyOverridesAfterCreate({
            userId,
            productId,
            listingId: (result as any).listingId as string,
            req,
            overrideTemplate,
            productRules,
          });
        }
        return;
      }
      if (req.platform === "SHOPEE") {
        const result = await ListingUseCase.createShopeeListing(
          userId,
          productId,
          req.categoryId,
          req.accountId,
          actorId,
        );
        this.logDispatchResult({
          userId,
          productId,
          req,
          success: !!result.success,
          listingId: (result as any).listingId,
          externalListingId: (result as any).externalListingId,
          error: result.success ? null : result.error || null,
        });
        if (!result.success) {
          console.error(
            `[ListingDispatcher] Shopee listing failed (product=${productId}, account=${req.accountId}): ${result.error}`,
          );
        } else {
          // Produtividade: 1 CREATE_LISTING por anúncio criado, atribuído ao ator.
          this.logCreatedListing(
            actorId,
            (result as any).listingId,
            productId,
            "SHOPEE",
          );
          // Sucesso na criação — aplica overrides (ex.: aumento escalonado entre
          // contas Shopee) se houver template. Sem template, nada muda; template
          // sem mapa Shopee (ex.: só ML) ⇒ no-op, comportamento atual.
          if (overrideTemplate && (result as any).listingId) {
            await this.applyOverridesAfterCreate({
              userId,
              productId,
              listingId: (result as any).listingId as string,
              req,
              overrideTemplate,
              productRules,
            });
          }
        }
        return;
      }
      if (req.platform === "MAGALU") {
        const result = await ListingUseCase.createMagaluListing(
          userId,
          productId,
          req.categoryId,
          req.accountId,
          actorId,
        );
        this.logDispatchResult({
          userId,
          productId,
          req,
          success: !!result.success,
          listingId: (result as any).listingId,
          externalListingId: (result as any).externalListingId,
          error: result.success ? null : result.error || null,
        });
        if (!result.success) {
          console.error(
            `[ListingDispatcher] Magalu listing failed (product=${productId}, account=${req.accountId}): ${result.error}`,
          );
        } else {
          this.logCreatedListing(
            actorId,
            (result as any).listingId,
            productId,
            "MAGALU",
          );
          // Sucesso na criação — aplica overrides (ex.: aumento escalonado entre
          // contas Magalu) se houver template. Sem template, nada muda; template
          // sem mapa Magalu (ex.: só ML) ⇒ no-op, comportamento atual.
          if (overrideTemplate && (result as any).listingId) {
            await this.applyOverridesAfterCreate({
              userId,
              productId,
              listingId: (result as any).listingId as string,
              req,
              overrideTemplate,
              productRules,
            });
          }
        }
        return;
      }
    } catch (err) {
      console.error(
        `[ListingDispatcher] ${req.platform} error (product=${productId}, account=${req.accountId}):`,
        err instanceof Error ? err.message : err,
      );
      this.logDispatchResult({
        userId,
        productId,
        req,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        threw: true,
      });
    }
  }

  /**
   * Log estruturado de resultado de cada plataforma×conta. Mesmo formato JSON
   * one-line do `listing.dispatch` event que já existe (linha 72), pra ficar
   * grep-friendly. Não deve lançar — falhas de logging não devem mascarar
   * resultados reais.
   */
  private static logDispatchResult(args: {
    userId: string;
    productId: string;
    req: ListingDispatchRequest;
    success: boolean;
    listingId?: string;
    externalListingId?: string;
    error?: string | null;
    mlError?: unknown;
    threw?: boolean;
  }) {
    try {
      console.log(
        JSON.stringify({
          event: "listing.dispatch.result",
          productId: args.productId,
          userId: args.userId,
          platform: args.req.platform,
          accountId: args.req.accountId,
          success: args.success,
          listingId: args.listingId,
          externalListingId: args.externalListingId,
          error: args.error,
          mlError:
            args.mlError !== undefined && args.mlError !== null
              ? typeof args.mlError === "string"
                ? args.mlError
                : (() => {
                    try {
                      return JSON.stringify(args.mlError);
                    } catch {
                      return String(args.mlError);
                    }
                  })()
              : null,
          threw: args.threw || false,
        }),
      );
    } catch {
      // ignore
    }
  }

  /**
   * Grava UM log estruturado `CREATE_LISTING` por anúncio criado com sucesso,
   * atribuído ao ATOR (colaborador que disparou), para alimentar os relatórios
   * de produtividade. Só grava quando há um ator humano (`actorId`): fluxos de
   * sistema/sem ator não fabricam atribuição. Fire-and-forget e tolerante a
   * falha (`SystemLogService.log` já engole erros). NÃO altera criação/sync.
   */
  private static logCreatedListing(
    actorId: string | undefined,
    listingId: string | undefined,
    productId: string,
    platform: "MERCADO_LIVRE" | "SHOPEE" | "MAGALU",
  ): void {
    if (!actorId || !listingId) return;
    const marketplace =
      platform === "SHOPEE"
        ? "Shopee"
        : platform === "MAGALU"
          ? "Magalu"
          : "MercadoLivre";
    void SystemLogService.logListingCreate(
      actorId,
      listingId,
      productId,
      marketplace,
    );
  }

  /**
   * Variante batch: cria N produtos × M requests (platform × account) com
   * concorrência fixa (mesmo padrão do bulk-delete na UI). Espera cada
   * createMLListing/createShopeeListing finalizar e, em caso de sucesso,
   * aplica overrides do template via updateListingFields.
   *
   * `onItemDone` é chamado AO FINAL de cada par (productId, request) com o
   * resultado completo — usado pelo endpoint para persistir progresso no
   * BulkListingJob.
   *
   * Erros individuais nunca propagam; sempre viram um item com success=false.
   */
  static async dispatchBatch(input: {
    userId: string;
    productIds: string[];
    requests: Array<{
      platform: BulkListingPlatform;
      accountId: string;
      categoryId?: string;
      mlSettings?: ListingDispatchRequest["mlSettings"];
    }>;
    overrideTemplate?: BulkOverrideTemplate | null;
    onItemDone: (item: BulkListingItemResult) => void | Promise<void>;
    // Ator (colaborador) que disparou o lote, p/ atribuir os logs de
    // produtividade. Ver ListingDispatchInput.actorId.
    actorId?: string;
  }): Promise<{ success: number; failed: number; lastError?: string | null }> {
    type Pair = { productId: string; req: BulkRunRequest };
    const pairs: Pair[] = [];
    const perProduct = input.overrideTemplate?.perProductOverrides;
    for (const pid of input.productIds) {
      const ov = perProduct?.[pid];
      for (const r of input.requests) {
        // Skip por conta (modo Revisão individual). Ausente ⇒ inclui tudo, igual
        // ao de hoje. Poda espelhada por countEffectiveItems no front/rota.
        const skipped =
          r.platform === "MERCADO_LIVRE"
            ? ov?.disabledMlAccountIds?.includes(r.accountId)
            : r.platform === "SHOPEE"
              ? ov?.disabledShopeeAccountIds?.includes(r.accountId)
              : ov?.disabledMagaluAccountIds?.includes(r.accountId);
        if (skipped) continue;
        pairs.push({
          productId: pid,
          req: {
            platform: r.platform,
            accountId: r.accountId,
            categoryId: r.categoryId,
            mlSettings: r.mlSettings,
          },
        });
      }
    }

    let success = 0;
    let failed = 0;
    let lastError: string | null = null;

    // Otimização: quando há overrideTemplate, applyRules precisa apenas de
    // (id, name, price, costPrice) por produto. Em vez de N findById com JOIN
    // pesado em compatibilidades dentro de cada worker, faz UM SELECT enxuto
    // antes do pool. O cache é compartilhado entre workers.
    let productRulesCache: Map<string, BulkRulesProductInput> | null = null;
    if (input.overrideTemplate && input.productIds.length > 0) {
      const lite = await prisma.product.findMany({
        where: { id: { in: input.productIds }, userId: input.userId },
        select: { id: true, name: true, price: true, costPrice: true },
      });
      productRulesCache = new Map();
      for (const p of lite) {
        productRulesCache.set(p.id, {
          id: p.id,
          name: p.name,
          price: p.price as unknown as number | { toNumber(): number },
          costPrice: p.costPrice as unknown as
            | number
            | { toNumber(): number }
            | null
            | undefined,
        });
      }
    }

    const concurrency = Math.min(4, pairs.length);
    let cursor = 0;

    const worker = async () => {
      while (cursor < pairs.length) {
        const idx = cursor++;
        const { productId, req } = pairs[idx];
        const result = await this.runOneWithResult(
          input.userId,
          productId,
          req,
          input.overrideTemplate ?? null,
          productRulesCache,
          input.actorId,
        );
        if (result.success) success++;
        else {
          failed++;
          if (result.error) lastError = result.error;
        }
        try {
          await onItemDoneSafe(input.onItemDone, result);
        } catch (e) {
          console.error("[ListingDispatcher] onItemDone callback failed", e);
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    return { success, failed, lastError };
  }

  /**
   * Wrapper de runOne que captura o resultado em vez de descartar (como o
   * fire-and-forget do dispatch single). Aplica overrides após criação.
   */
  static async runOneWithResult(
    userId: string,
    productId: string,
    req: BulkRunRequest,
    overrideTemplate: BulkOverrideTemplate | null,
    productRulesCache?: Map<string, BulkRulesProductInput> | null,
    actorId?: string,
  ): Promise<BulkListingItemResult> {
    const finishedAt = () => new Date().toISOString();

    // Override por produto (modo Revisão individual). Ausente ⇒ usa o request
    // global, idêntico ao de hoje. Categoria e mlSettings entram NO create.
    const ov = overrideTemplate?.perProductOverrides?.[productId];

    try {
      let createResult;
      if (req.platform === "MERCADO_LIVRE") {
        const categoryId = ov?.ml?.categoryId ?? req.categoryId;
        const mlSettings = ov?.ml
          ? mergePerProductMlSettings(req.mlSettings, ov.ml)
          : req.mlSettings;
        createResult = await ListingUseCase.createMLListing(
          userId,
          productId,
          categoryId,
          req.accountId,
          mlSettings,
          undefined, // titleOverride
          actorId,
          // Ficha por produto da Revisão individual. O create só lê o código
          // OEM daqui — os demais atributos seguem indo pelo update
          // pós-criação, logo abaixo, como sempre foi. O OEM precisa deste
          // caminho porque o ML não aceita alterá-lo depois de criado.
          ov?.ml?.attributes,
        );
      } else if (req.platform === "SHOPEE") {
        const categoryId = ov?.shopee?.categoryId ?? req.categoryId;
        createResult = await ListingUseCase.createShopeeListing(
          userId,
          productId,
          categoryId,
          req.accountId,
          actorId,
        );
      } else if (req.platform === "MAGALU") {
        // Override por-produto de Magalu (modo Revisão individual): categoria
        // escolhida vence o request global; ausente ⇒ backend resolve no envio.
        const categoryId = ov?.magalu?.categoryId ?? req.categoryId;
        createResult = await ListingUseCase.createMagaluListing(
          userId,
          productId,
          categoryId,
          req.accountId,
          actorId,
        );
      } else {
        return {
          productId,
          platform: req.platform,
          accountId: req.accountId,
          success: false,
          error: `Plataforma não suportada: ${req.platform}`,
          finishedAt: finishedAt(),
        };
      }

      if (!createResult.success || !createResult.listingId) {
        return {
          productId,
          platform: req.platform,
          accountId: req.accountId,
          success: false,
          error: createResult.error ?? "Falha desconhecida na criação",
          finishedAt: finishedAt(),
        };
      }

      // Sucesso na criação — aplica overrides (regras de bulk + aumento
      // escalonado entre contas ML) via helper compartilhado com o dispatch
      // single. O productRulesCache pré-fetched do dispatchBatch é reutilizado.
      if (overrideTemplate) {
        await this.applyOverridesAfterCreate({
          userId,
          productId,
          listingId: createResult.listingId,
          req,
          overrideTemplate,
          productRulesCache,
        });
      }

      // Produtividade: 1 CREATE_LISTING por anúncio criado, atribuído ao ator.
      this.logCreatedListing(
        actorId,
        createResult.listingId,
        productId,
        req.platform,
      );

      return {
        productId,
        platform: req.platform,
        accountId: req.accountId,
        success: true,
        listingId: createResult.listingId,
        externalListingId: createResult.externalListingId,
        finishedAt: finishedAt(),
      };
    } catch (err) {
      return {
        productId,
        platform: req.platform,
        accountId: req.accountId,
        success: false,
        error: err instanceof Error ? err.message : "Erro desconhecido",
        finishedAt: finishedAt(),
      };
    }
  }

  /**
   * Aplica overrides (regras de bulk + aumento percentual escalonado entre
   * contas, por plataforma) a um anúncio recém-criado, via updateListingFields.
   * Compartilhado entre o dispatch single (runOne) e o batch (runOneWithResult).
   * Resolve o productRules a partir do que for fornecido (pré-fetch / cache) ou
   * busca no repositório. Nunca lança — falhas viram warning.
   */
  private static async applyOverridesAfterCreate(args: {
    userId: string;
    productId: string;
    listingId: string;
    req: { platform: BulkListingPlatform; accountId?: string };
    overrideTemplate: BulkOverrideTemplate | null;
    productRules?: BulkRulesProductInput;
    productRulesCache?: Map<string, BulkRulesProductInput> | null;
  }): Promise<void> {
    const { userId, productId, listingId, req, overrideTemplate } = args;
    if (!overrideTemplate) return;
    try {
      let productRules: BulkRulesProductInput | undefined =
        args.productRules ?? args.productRulesCache?.get(productId);
      if (!productRules) {
        // Fallback FRIO (só quando prefetch/cache falharam): mantém o findById
        // clássico do repositório deliberadamente — caminho raro em produção.
        const product = await new ProductRepositoryPrisma().findById(productId);
        if (product) {
          productRules = {
            id: product.id,
            name: product.name,
            price: product.price as unknown as number | { toNumber(): number },
            costPrice: product.costPrice as unknown as
              | number
              | { toNumber(): number }
              | null
              | undefined,
          };
        }
      }
      if (!productRules) return;

      let fields = applyRules(productRules, overrideTemplate);

      // Aumento percentual escalonado entre contas: compõe o priceOverride
      // por conta sobre o preço base (regra de preço já aplicada, se houver).
      // idx 0 = preço base (sem alteração). Cada plataforma lê SOMENTE o seu
      // mapa (escadas independentes, sem fallback cruzado): ML usa o
      // indexByAccountId legado; Shopee/Magalu usam os mapas próprios e ainda
      // exigem o kill-switch desligado — o gate na LEITURA cobre jobs já
      // persistidos com mapas novos (ex.: retry-failed). Template sem o mapa
      // da plataforma ⇒ idx 0 ⇒ sem escalonamento (jobs antigos = ML-only).
      const ca = overrideTemplate.crossAccountIncrease;
      if (ca?.enabled && ca.percent > 0 && req.accountId) {
        const staggerMap =
          req.platform === "MERCADO_LIVRE"
            ? ca.indexByAccountId
            : crossMarketplaceStaggerDisabled()
              ? undefined
              : req.platform === "SHOPEE"
                ? ca.shopeeIndexByAccountId
                : req.platform === "MAGALU"
                  ? ca.magaluIndexByAccountId
                  : undefined;
        const idx = staggerMap?.[req.accountId] ?? 0;
        if (idx > 0) {
          const base =
            computeBulkPrice(productRules, overrideTemplate.priceRule) ??
            toNum(productRules.price);
          const price = computeStaggeredPrice(base, idx, ca.percent);
          if (price > 0) {
            fields = { ...(fields ?? {}), priceOverride: price };
          }
        }
      }

      // Override por produto (modo Revisão individual): ficha técnica e preço do
      // anúncio entram pelo caminho pós-create existente (updateListingFields já
      // aceita attributesOverride/priceOverride).
      //
      // PRECEDÊNCIA (é o último `fields = {...}` do fluxo, então vence tudo):
      //   "Valor do Anúncio" > escada crossAccountIncrease > regra global de
      //   preço do bulk > product.price.
      // Regra `> 0` deliberada: vazio ou zero significa herdar o preço do
      // produto — os três marketplaces rejeitam publicação por R$ 0.
      const ov = overrideTemplate.perProductOverrides?.[productId];
      const ppm = ov?.ml;
      if (ppm && req.platform === "MERCADO_LIVRE") {
        // `attributes` segue restrito ao ML: o mapa é de attribute_id do ML.
        // A ficha da Shopee tem vocabulário próprio e é montada no create,
        // pelo shopee-attribute-mapper.
        if (ppm.attributes && Object.keys(ppm.attributes).length > 0) {
          fields = { ...(fields ?? {}), attributesOverride: ppm.attributes };
        }
      }

      // Preço por anúncio nas 3 plataformas. O motor já existia por inteiro
      // (updateShopeeListingFields aplica via update_price;
      // updateMagaluListingFields via setPrice) — só o gate de plataforma
      // impedia Shopee e Magalu de usá-lo.
      const perProductPrice =
        req.platform === "MERCADO_LIVRE"
          ? ppm?.listingPrice
          : req.platform === "SHOPEE"
            ? ov?.shopee?.listingPrice
            : req.platform === "MAGALU"
              ? ov?.magalu?.listingPrice
              : undefined;
      if (typeof perProductPrice === "number" && perProductPrice > 0) {
        fields = { ...(fields ?? {}), priceOverride: perProductPrice };
      }

      if (fields) {
        const upd = await ListingUseCase.updateListingFields(
          listingId,
          userId,
          fields as ListingFullEditInput,
        );
        if (!upd.success) {
          console.warn(
            `[ListingDispatcher] override apply falhou (listing=${listingId}): ${upd.error}`,
          );
        }
      }
    } catch (overrideErr) {
      console.warn(
        "[ListingDispatcher] override apply lançou exceção:",
        overrideErr instanceof Error ? overrideErr.message : overrideErr,
      );
    }
  }

  /**
   * Resolve o percentual de aumento escalonado: usa o valor do cliente (clamp
   * 0..100) e cai para a preferência do usuário quando ausente/inválido.
   */
  static async resolveCrossAccountPercent(
    userId: string,
    clientPercent?: number,
  ): Promise<number> {
    let percent =
      typeof clientPercent === "number" && Number.isFinite(clientPercent)
        ? clientPercent
        : NaN;
    if (!Number.isFinite(percent)) {
      try {
        const u = await prisma.user.findUnique({
          where: { id: userId },
          select: { crossAccountPriceIncreasePercent: true },
        });
        percent = u?.crossAccountPriceIncreasePercent
          ? Number(u.crossAccountPriceIncreasePercent)
          : 0;
      } catch {
        percent = 0;
      }
    }
    return Math.min(100, Math.max(0, percent));
  }

  /**
   * Monta o overrideTemplate de aumento escalonado a partir da ordem das contas
   * em `requests` (1ª selecionada = índice 0 = preço base). Cada plataforma tem
   * escada 0-based PRÓPRIA, independente das demais (a penalização por anúncios
   * idênticos é intra-marketplace). Um mapa só é incluído quando a plataforma
   * tem 2+ contas (com 1 conta não há o que escalonar); os mapas Shopee/Magalu
   * exigem também o kill-switch desligado. Retorna null se o percentual for
   * <= 0 ou nenhuma plataforma tiver 2+ contas (sem efeito) — para requests
   * só-ML, comportamento idêntico ao anterior.
   */
  static buildCrossAccountOverride(
    requests: Array<{ platform: BulkListingPlatform; accountId?: string }>,
    percent: number,
  ): BulkOverrideTemplate | null {
    if (!(percent > 0)) return null;
    const mapFor = (
      platform: BulkListingPlatform,
    ): Record<string, number> | null => {
      const map: Record<string, number> = {};
      let idx = 0;
      for (const r of requests) {
        if (
          r.platform === platform &&
          r.accountId &&
          !Object.prototype.hasOwnProperty.call(map, r.accountId)
        ) {
          map[r.accountId] = idx++;
        }
      }
      return idx >= 2 ? map : null;
    };
    const ml = mapFor("MERCADO_LIVRE");
    const staggerOthers = !crossMarketplaceStaggerDisabled();
    const shopee = staggerOthers ? mapFor("SHOPEE") : null;
    const magalu = staggerOthers ? mapFor("MAGALU") : null;
    if (!ml && !shopee && !magalu) return null;
    return {
      crossAccountIncrease: {
        enabled: true,
        percent,
        ...(ml ? { indexByAccountId: ml } : {}),
        ...(shopee ? { shopeeIndexByAccountId: shopee } : {}),
        ...(magalu ? { magaluIndexByAccountId: magalu } : {}),
      },
    };
  }
}

async function onItemDoneSafe(
  cb: ((item: BulkListingItemResult) => void | Promise<void>) | undefined,
  item: BulkListingItemResult,
) {
  if (!cb) return;
  await cb(item);
}
