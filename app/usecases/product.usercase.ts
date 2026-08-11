import {
  ProductFilterOptions,
  Product,
  ProductCreate,
  ProductListFilters,
  ProductUpdate,
  ProductUpdateResult,
  ProductRepository,
} from "../interfaces/product.interface";
import { ProductRepositoryPrisma } from "../repositories/product.repository";
import { SyncUseCase } from "../marketplaces/usecases/sync.usercase";
import { ListingUseCase } from "../marketplaces/usecases/listing.usercase";
import { SystemLogService } from "../services/system-log.service";
import { Platform } from "@prisma/client";
import {
  UserRepository,
  UserRepositoryPrisma,
} from "../repositories/user.repository";
import { User } from "../interfaces/user.interface";
import prisma from "../lib/prisma";
import { parseTitleToFields } from "../lib/product-parser";
import { getVehicleBrands } from "../lib/vehicle-catalog";
import { maskCorruptVehicleCategoriesInProducts } from "../marketplaces/services/category-resolution.service";
import { AccountSemaphore } from "../marketplaces/services/account-semaphore";

export const BULK_DELETE_MAX_IDS = 50;

export interface BulkDeleteListingResult {
  listingId: string;
  externalListingId: string;
  platform: Platform | null;
  closed: boolean;
  error?: string;
  retryable?: boolean;
}

export interface BulkDeleteProductResult {
  productId: string;
  deleted: boolean;
  message: string;
  listingResults: BulkDeleteListingResult[];
}

export interface BulkDeleteResponse {
  results: BulkDeleteProductResult[];
  summary: {
    total: number;
    deleted: number;
    failed: number;
  };
}

export class ProductUseCase {
  private productRepository: ProductRepository;
  private userRepository: UserRepository;
  // Dono pré-resolvido (opcional): a importação em lote resolve o dono UMA vez e
  // injeta aqui via construtor para evitar um findById por produto criado.
  // undefined = resolver sob demanda em create()/createWithAutoSku (hoje).
  private readonly preloadedOwner?: User | null;
  constructor(preloadedOwner?: User | null) {
    this.productRepository = new ProductRepositoryPrisma();
    this.userRepository = new UserRepositoryPrisma();
    this.preloadedOwner = preloadedOwner;
  }

  /**
   * @param tx Client transacional OPCIONAL (Bloco F). Ausente => comportamento
   * byte-idêntico ao de hoje. Presente => o INSERT do produto participa da
   * transação do chamador (ex.: o pagamento de uma venda de balcão), para que
   * um rollback não deixe produto órfão no catálogo.
   *
   * Fora da transação, de propósito: a reserva do SKU sequencial
   * (`reserveNextSkuSequential`) é um `UPDATE ... RETURNING` atômico por si só,
   * e um rollback do chamador apenas "queima" um número — exatamente o que já
   * acontece hoje quando o pre-check pula um SKU ou uma colisão P2002 força
   * outra tentativa. Prendê-la à transação longa do pagamento só aumentaria a
   * janela de lock na linha do User.
   */
  async create(
    productData: ProductCreate,
    tx?: any,
  ): Promise<Product> {
    // Opt-in: atribuição atômica do SKU no servidor (ver createWithAutoSku).
    // O corpo legado abaixo só roda quando autoSku é falso — comportamento
    // de hoje preservado integralmente (sku explícito, importações, balcão).
    if (productData.autoSku) {
      return this.createWithAutoSku(productData, tx);
    }

    if (!productData.userId) {
      throw new Error("Usuário não encontrado");
    }

    // Parallel: resolve user + check SKU uniqueness.
    // - this.preloadedOwner (importação em lote resolve o dono UMA vez) evita um
    //   findById por produto criado; sem ele (undefined), busca como hoje.
    // - existsBySku puxa só o id — o retorno so e usado como booleano.
    const [user, skuExists] = await Promise.all([
      this.preloadedOwner !== undefined
        ? Promise.resolve(this.preloadedOwner)
        : this.userRepository.findById(productData.userId),
      this.productRepository.existsBySku(productData.sku, productData.userId),
    ]);

    if (!user) {
      throw new Error("Usuário não encontrado");
    }

    if (skuExists) {
      throw new Error("Produto com esse sku já existe");
    }

    this.applyUserDefaults(productData, user);

    // Persistência transacional única: o repositório grava produto + compatibilidades
    // no mesmo prisma.product.create (nested write). Não duplicar aqui.
    // Sem tx, chama com UM argumento — a assinatura da chamada continua
    // byte-idêntica à de sempre (passar `undefined` explicitamente já mudaria
    // a aridade observável para quem espia este método).
    const created = tx
      ? await this.productRepository.create(productData, tx)
      : await this.productRepository.create(productData);

    // Mantém o contador de sequência humana atualizado. Produtos de marketplace
    // (auto-detecção de anúncios) chegam aqui com createdFromMarketplace=true e
    // NÃO tocam o contador — assim o SKU custom do vendedor (ex.: "13340") não
    // contamina a sugestão de próximo SKU da sequência humana.
    if (!productData.createdFromMarketplace) {
      await this.tryBumpSkuCounter(productData.userId, productData.sku);
    }

    return created;
  }

  // Enriquecimento aplicado a ambos os caminhos (custom e auto). Move 1:1 da
  // lógica que antes era inline no create() — mesmas mutações, mesma ordem.
  private applyUserDefaults(productData: ProductCreate, user: User): void {
    // Se descrição não foi fornecida, usar a padrão do usuário
    if (!productData.description && user.defaultProductDescription) {
      productData.description = user.defaultProductDescription;
    }

    // Fallback: se campos de marca/modelo/ano/categoria estão ausentes, tentar extrair do nome do produto
    try {
      const detected = parseTitleToFields(productData.name);
      if (!productData.brand && detected.brand)
        productData.brand = detected.brand;
      if (!productData.model && detected.model)
        productData.model = detected.model;
      if (!productData.year && detected.year) productData.year = detected.year;
      if (!productData.category && detected.category)
        productData.category = detected.category;
    } catch (err) {
      // Não falhar a criação por causa da heurística
      console.error("Erro ao extrair campos do título:", err);
    }
  }

  // Caminho AUTO: o servidor decide o SKU sequencial atomicamente na hora de
  // salvar, com retry em caso de colisão. Resolve a corrida de dois
  // colaboradores do mesmo dataOwnerId recebendo o mesmo número.
  private async createWithAutoSku(
    productData: ProductCreate,
    // Bloco F: só o INSERT do produto entra na transação do chamador. A
    // reserva do SKU segue fora — ver a nota em `create`.
    tx?: any,
  ): Promise<Product> {
    if (!productData.userId) {
      throw new Error("Usuário não encontrado");
    }

    // this.preloadedOwner (importação em lote) evita um findById por produto;
    // sem ele (undefined), busca como hoje. Ver create().
    const user =
      this.preloadedOwner !== undefined
        ? this.preloadedOwner
        : await this.userRepository.findById(productData.userId);
    if (!user) {
      throw new Error("Usuário não encontrado");
    }

    this.applyUserDefaults(productData, user);

    // Seed sob demanda: se o contador é null mas já existem produtos, inicializa
    // pelo maior SKU numérico existente — senão a reserva começaria em 1 e o
    // loop teria que varrer milhares de números já tomados por importação
    // (ex.: JOTABÊ com SKUs até 32762) antes de achar um livre.
    const last = await this.userRepository.getLastSkuSequential(
      productData.userId,
    );
    if (last == null) {
      const seed = await this.productRepository.getMaxSkuNumber(
        productData.userId,
      );
      if (seed > 0) {
        // bumpLastSkuSequential é idempotente e nunca regride: um seed
        // concorrente do mesmo valor é benigno (segundo no-op).
        await this.userRepository.bumpLastSkuSequential(
          productData.userId,
          seed,
        );
      }
    }

    const MAX_ATTEMPTS = 25;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const n = await this.userRepository.reserveNextSkuSequential(
        productData.userId,
      );
      const candidate = n.toString().padStart(3, "0");

      // Pula números já ocupados por importação dentro da janela sequencial
      // sem gastar um insert que falharia.
      const taken = await this.productRepository.existsBySku(
        candidate,
        productData.userId,
      );
      if (taken) continue;

      try {
        const payload = { ...productData, sku: candidate };
        // Idem: aridade preservada quando não há transação.
        return tx
          ? await this.productRepository.create(payload, tx)
          : await this.productRepository.create(payload);
      } catch (err) {
        // Perdeu uma corrida entre o pre-check e o insert: reserva o próximo.
        if (this.isSkuTaken(err)) continue;
        throw err;
      }
    }

    throw new Error(
      "Não foi possível gerar SKU automático após várias tentativas",
    );
  }

  private isSkuTaken(err: unknown): boolean {
    // Detecção OBRIGATÓRIA por mensagem: productRepository.create captura o
    // P2002 do Prisma e relança um Error simples, descartando .code/.meta.
    return (
      err instanceof Error && err.message === "Produto com esse sku já existe"
    );
  }

  private async tryBumpSkuCounter(userId: string, sku: string): Promise<void> {
    // Só conta SKUs numéricos puros até 6 dígitos — o formato que o
    // getNextSku gera (`padStart(3, "0")`). SKUs legados `PROD-XXX` não
    // atualizam o counter. O call-site já filtra produtos de marketplace
    // (createdFromMarketplace), então SKUs de anúncio não chegam aqui.
    const match = sku.match(/^(\d{1,6})$/);
    if (!match) return;
    const n = parseInt(match[1], 10);
    if (!Number.isSafeInteger(n) || n <= 0) return;
    try {
      await this.userRepository.bumpLastSkuSequential(userId, n);
    } catch (err) {
      // Não bloqueia o create: o produto já foi persistido. Log para
      // diagnóstico — se o counter ficar atrás, a próxima sugestão de
      // SKU vai colidir e o safety-loop do getNextSku resolve.
      console.error("[SKU_BUMP] falhou ao atualizar lastSkuSequential:", err);
    }
  }

  async getDetail(id: string, userId: string) {
    const repo = this.productRepository as ProductRepositoryPrisma;
    const result = await repo.findByIdDetailed(id, userId);
    if (result) {
      await maskCorruptVehicleCategoriesInProducts([result as any]);
      // findByIdDetailed retorna { product, productLocation, ... } — o locationId
      // está em result.product, então enriquecemos esse objeto (não o wrapper).
      if ((result as any).product) {
        await this.enrichLocationFullPaths([(result as any).product], userId);
      }
    }
    return result;
  }

  async listProducts(
    options: ProductListFilters & { userId: string },
  ): Promise<{ products: Product[]; total: number; totalPages: number }> {
    const { userId, ...rest } = options;
    const data = await this.productRepository.findAll(rest, userId);
    await maskCorruptVehicleCategoriesInProducts(data.products as any);
    await this.enrichLocationFullPaths(data.products, userId);
    return {
      ...data,
      totalPages: Math.ceil(data.total / (options?.limit || 10)),
    };
  }

  /**
   * Anexa `locationPath` (campo SOMENTE-LEITURA de exibição) com o CAMINHO
   * COMPLETO da localização ("Galpão 1 > Andar 1 > Caixa 212"), caminhando a
   * cadeia de `parentId`. NÃO toca em `Product.location` (campo escalar que os
   * formulários de edição/criação leem e gravam — mexer ali causaria regressão).
   *
   * Motivo: a query de produtos não traz os ancestrais e o endpoint
   * /locations/select só retorna raízes + 1 nível (não os leaves profundos onde
   * os produtos ficam). Aqui carregamos as localizações do user uma vez
   * (id, code, parentId) e montamos o path — funciona para qualquer profundidade.
   */
  private async enrichLocationFullPaths(
    products: Product[],
    userId: string,
  ): Promise<void> {
    const hasLocation = products.some((p) => (p as any).locationId);
    if (!hasLocation) return;

    const locs = await prisma.location.findMany({
      where: { userId },
      select: { id: true, code: true, parentId: true },
    });
    if (locs.length === 0) return;

    const byId = new Map(locs.map((l) => [l.id, l]));
    const pathCache = new Map<string, string>();
    const buildPath = (id: string): string => {
      const cached = pathCache.get(id);
      if (cached !== undefined) return cached;
      const parts: string[] = [];
      let cur: string | null = id;
      let guard = 0;
      while (cur && guard++ < 25) {
        const node = byId.get(cur);
        if (!node) break;
        parts.unshift(node.code);
        cur = node.parentId;
      }
      const path = parts.join(" > ");
      pathCache.set(id, path);
      return path;
    };

    for (const p of products) {
      const locId = (p as any).locationId as string | null | undefined;
      if (!locId) continue;
      const fullPath = buildPath(locId);
      // campo de EXIBIÇÃO separado; nunca sobrescreve o escalar editável `location`
      if (fullPath) (p as any).locationPath = fullPath;
    }
  }

  async getFilterOptions(userId: string): Promise<ProductFilterOptions> {
    const publishedCategories =
      await this.productRepository.findPublishedCategories(userId);

    return {
      brands: getVehicleBrands(),
      publishedCategories,
    };
  }

  /**
   * Deleta um produto e seus anúncios em marketplaces.
   *
   * Política estrita: o produto local SÓ é deletado se todos os anúncios
   * forem confirmados encerrados nos respectivos marketplaces (ou se já
   * estavam fechados / não existem mais — idempotência).
   *
   * Se algum listing falhar de forma permanente (4xx do marketplace) ou
   * recuperável (após retries esgotados), retorna `success: false` com o
   * relatório por listing — o produto continua no banco e o usuário pode
   * reintentar. Cada falha é registrada em SystemLog para auditoria.
   *
   * `closed` no resultado significa "encerrado no marketplace" (true também
   * para idempotência); listings sem externalListingId ou em PENDING_ ficam
   * com `closed: false` mas não bloqueiam a deleção do produto.
   */
  async delete(
    id: string,
    userId?: string,
  ): Promise<{
    success: boolean;
    message: string;
    listingResults?: Array<{
      listingId: string;
      externalListingId: string;
      platform: Platform | null;
      closed: boolean;
      error?: string;
      retryable?: boolean;
    }>;
  }> {
    try {
      const listings = await this.getProductListings(id);

      const listingResults = await Promise.all(
        listings.map(async (listing) => {
          const result = await ListingUseCase.removeListing(listing.id);
          return {
            listingId: listing.id,
            externalListingId: listing.externalListingId,
            platform: listing.marketplaceAccount?.platform ?? null,
            closed: result.closedOnMarketplace,
            success: result.success,
            error: result.error,
            retryable: result.retryable,
          };
        }),
      );

      const failures = listingResults.filter((r) => !r.success);

      if (failures.length > 0) {
        // Registra cada falha em SystemLog para auditoria/suporte.
        for (const f of failures) {
          void SystemLogService.logListingDeleteFailed(userId, f.listingId, {
            productId: id,
            externalListingId: f.externalListingId,
            platform: f.platform ?? undefined,
            error: f.error,
            retryable: f.retryable,
          });
        }

        return {
          success: false,
          message: `Produto não foi excluído: ${failures.length} anúncio(s) não puderam ser encerrados no marketplace.`,
          listingResults: listingResults.map(
            ({ success: _success, ...rest }) => rest,
          ),
        };
      }

      await this.productRepository.delete(id, userId);

      return {
        success: true,
        message: "Produto e anúncios associados excluídos com sucesso",
        listingResults: listingResults.map(
          ({ success: _success, ...rest }) => rest,
        ),
      };
    } catch (error) {
      return {
        success: false,
        message:
          error instanceof Error ? error.message : "Erro ao excluir produto",
      };
    }
  }

  /**
   * Deleta múltiplos produtos em uma única chamada, respeitando rate limit
   * dos marketplaces.
   *
   * Estratégia:
   *  - Cada produto é processado em paralelo no nível superior.
   *  - Dentro de cada produto, os listings são fechados em paralelo, mas
   *    chamadas para a MESMA `marketplaceAccountId` são serializadas via
   *    AccountSemaphore (evita estourar rate limit ML ~10 req/s).
   *  - Política estrita (igual ao delete individual): só deleta local se
   *    todos os listings forem confirmadamente encerrados / idempotentes.
   *  - Falhas são persistidas em SystemLog com action DELETE_LISTING_FAILED.
   *
   * O limite de IDs é validado: arrays com mais de BULK_DELETE_MAX_IDS
   * disparam exceção (o endpoint converte para 400). IDs duplicados são
   * deduplicados silenciosamente — chamar com ["a","a","b"] equivale a
   * ["a","b"].
   */
  async bulkDelete(
    rawIds: string[],
    userId?: string,
  ): Promise<BulkDeleteResponse> {
    const ids = Array.from(new Set(rawIds.filter((id) => typeof id === "string" && id.length > 0)));

    if (ids.length === 0) {
      return { results: [], summary: { total: 0, deleted: 0, failed: 0 } };
    }

    if (ids.length > BULK_DELETE_MAX_IDS) {
      throw new Error(
        `Limite de ${BULK_DELETE_MAX_IDS} produtos por chamada excedido (${ids.length} recebidos). Divida a operação em lotes menores.`,
      );
    }

    const semaphore = new AccountSemaphore();

    const results = await Promise.all(
      ids.map(async (productId) => this.bulkDeleteOne(productId, userId, semaphore)),
    );

    const deleted = results.filter((r) => r.deleted).length;
    const failed = results.length - deleted;

    return {
      results,
      summary: {
        total: results.length,
        deleted,
        failed,
      },
    };
  }

  /**
   * Processa a deleção de UM produto dentro do contexto do bulk: usa o
   * semáforo compartilhado para serializar chamadas por marketplaceAccountId
   * e devolve o resultado consolidado para o caller agregar no summary.
   */
  private async bulkDeleteOne(
    productId: string,
    userId: string | undefined,
    semaphore: AccountSemaphore,
  ): Promise<BulkDeleteProductResult> {
    try {
      const listings = await this.getProductListings(productId);

      const listingResults = await Promise.all(
        listings.map(async (listing) => {
          const accountKey = listing.marketplaceAccountId ?? `listing:${listing.id}`;
          const result = await semaphore.runExclusive(accountKey, () =>
            ListingUseCase.removeListing(listing.id),
          );
          return {
            listingId: listing.id,
            externalListingId: listing.externalListingId,
            platform: listing.marketplaceAccount?.platform ?? null,
            closed: result.closedOnMarketplace,
            success: result.success,
            error: result.error,
            retryable: result.retryable,
          };
        }),
      );

      const failures = listingResults.filter((r) => !r.success);

      if (failures.length > 0) {
        for (const f of failures) {
          void SystemLogService.logListingDeleteFailed(userId, f.listingId, {
            productId,
            externalListingId: f.externalListingId,
            platform: f.platform ?? undefined,
            error: f.error,
            retryable: f.retryable,
          });
        }
        return {
          productId,
          deleted: false,
          message: `${failures.length} anúncio(s) não puderam ser encerrados no marketplace.`,
          listingResults: listingResults.map(
            ({ success: _success, ...rest }) => rest,
          ),
        };
      }

      await this.productRepository.delete(productId, userId);

      return {
        productId,
        deleted: true,
        message: "Produto e anúncios associados excluídos com sucesso.",
        listingResults: listingResults.map(
          ({ success: _success, ...rest }) => rest,
        ),
      };
    } catch (error) {
      return {
        productId,
        deleted: false,
        message:
          error instanceof Error ? error.message : "Erro ao excluir produto",
        listingResults: [],
      };
    }
  }

  /**
   * Pausa ou reativa todos os anúncios publicados de um produto em paralelo.
   * Espelha o fluxo de `delete()`: busca os listings, itera com Promise.all
   * chamando `ListingUseCase.updateListingStatus`, e agrega os resultados.
   * NÃO toca o ProductRepository — só os anúncios.
   *
   * Listings PENDING_ (ainda em publicação) e sem externalListingId são
   * filtrados antes do round-trip — o updateListingStatus tambem rejeita,
   * mas evitamos N chamadas desnecessárias.
   *
   * Idempotência herdada de updateListingStatus: anúncios já no estado
   * desejado são contados em `alreadyInState` sem hit em ML/Shopee.
   */
  async pauseListings(
    productId: string,
    userId: string,
    status: "active" | "paused",
    // Opcional (default = comportamento atual): forceRemote força a chamada
    // à API mesmo quando o status local já é o desejado — usado pelo
    // cancelamento de pedido marketplace (status local pode estar stale).
    opts?: { forceRemote?: boolean },
  ): Promise<{
    success: boolean;
    message: string;
    listingResults: Array<{
      externalListingId: string;
      platform: Platform | null;
      paused: boolean;
      alreadyInState: boolean;
      error?: string;
    }>;
  }> {
    try {
      const product = await this.productRepository.findById(productId, userId);
      if (!product) {
        return {
          success: false,
          message: "Produto não encontrado",
          listingResults: [],
        };
      }

      const listings = await this.getProductListings(productId);
      const publishable = listings.filter(
        (l) =>
          l.externalListingId && !l.externalListingId.startsWith("PENDING_"),
      );

      if (publishable.length === 0) {
        return {
          success: true,
          message: "Nenhum anúncio publicado para alterar.",
          listingResults: [],
        };
      }

      const listingResults = await Promise.all(
        publishable.map(async (listing) => {
          // Aridade condicional: sem forceRemote, chamada byte-idêntica à
          // atual (3 args).
          const result = opts?.forceRemote
            ? await ListingUseCase.updateListingStatus(
                listing.id,
                userId,
                status,
                { forceRemote: true },
              )
            : await ListingUseCase.updateListingStatus(
                listing.id,
                userId,
                status,
              );
          return {
            externalListingId: listing.externalListingId,
            platform: listing.marketplaceAccount?.platform ?? null,
            paused: result.success,
            alreadyInState: result.alreadyInState ?? false,
            error: result.error,
          };
        }),
      );

      const changed = listingResults.filter(
        (r) => r.paused && !r.alreadyInState,
      ).length;
      const noop = listingResults.filter((r) => r.alreadyInState).length;
      const failed = listingResults.filter((r) => !r.paused);

      const verbPast = status === "paused" ? "pausado(s)" : "reativado(s)";
      let message: string;
      if (failed.length === 0 && noop === 0) {
        message = `${changed} anúncio(s) ${verbPast}.`;
      } else if (failed.length === 0) {
        message = `${changed} ${verbPast}, ${noop} já estava(m) no estado desejado.`;
      } else if (changed === 0 && noop === 0) {
        message = `Nenhum anúncio foi alterado: ${failed.length} falha(s).`;
      } else {
        message = `${changed} alterado(s), ${noop} já estava(m), ${failed.length} falha(s).`;
      }

      return {
        success: failed.length < listingResults.length,
        message,
        listingResults,
      };
    } catch (error) {
      return {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Erro ao alterar status dos anúncios",
        listingResults: [],
      };
    }
  }

  /**
   * Religa um produto JÁ existente à sua sucata de origem (`Product.scrapId`).
   * Caminho validado para o vínculo por SKU da importação de dados legados —
   * antes desta extensão, `scrapId` só era aceito na criação do produto.
   *
   * Vai DIRETO ao repositório (que valida a posse da sucata pelo tenant, a
   * mesma guarda do create) e NÃO passa por `update()` de propósito:
   * `scrapId` não afeta anúncio/estoque, então não deve disparar limpeza de
   * overrides, stock log nem sync de marketplace. `scrapId = null` desvincula.
   */
  async linkScrap(
    productId: string,
    scrapId: string | null,
    userId: string,
  ): Promise<Product> {
    if (!userId) throw new Error("Usuário não encontrado");
    if (!productId) throw new Error("Produto não informado");
    return this.productRepository.update(productId, { scrapId }, userId);
  }

  /**
   * Vincula VÁRIOS produtos a uma sucata num único `updateMany` — versão em
   * lote de `linkScrap` para a importação (products.csv do WebDesmonte tem
   * ~13,7k linhas; 1 update por produto seriam 13k round-trips). Espelha o
   * desenho de `LocationUseCase.attachProducts`: guarda de tenant da sucata
   * + cap de 200 por chamada + escopo `userId` no updateMany (produto de
   * outro tenant é simplesmente não afetado).
   */
  async linkScrapMany(
    scrapId: string,
    productIds: string[],
    userId: string,
  ): Promise<{ count: number }> {
    if (!userId) throw new Error("Usuário não encontrado");
    if (!scrapId) throw new Error("Sucata não informada");
    if (!productIds.length) throw new Error("Nenhum produto selecionado");
    if (productIds.length > 200) {
      throw new Error("Limite de 200 produtos por batch");
    }
    const ownsScrap = await prisma.scrap.findFirst({
      where: { id: scrapId, userId },
      select: { id: true },
    });
    if (!ownsScrap) {
      throw new Error(
        "Vínculo de sucata inválido: sucata não encontrada para este usuário",
      );
    }
    const unique = Array.from(new Set(productIds));
    const res = await prisma.product.updateMany({
      where: { id: { in: unique }, userId },
      data: { scrapId },
    });
    return { count: res.count };
  }

  /**
   * Grava as imagens de VÁRIOS produtos de uma vez, para a importação de
   * fotos do sistema legado.
   *
   * `update` NÃO serve aqui: ele dispara `syncProductListings`, então uma
   * importação de 13,6k peças viraria dezenas de milhares de chamadas ao
   * ML/Shopee e ALTERARIA anúncios ao vivo que ninguém pediu para mexer.
   * Importar é povoar o catálogo — publicar é outro ato, explícito.
   *
   * Pelo mesmo motivo NÃO limpa `imageUrlsOverride` dos anúncios (o que
   * `update` faz): quem tiver override no anúncio continua com ele até
   * decidir republicar.
   *
   * Espelha `linkScrapMany`: cap de 200 por chamada e `updateMany` escopado
   * por `userId` — produto de outro tenant simplesmente não é afetado.
   */
  async setImageUrlsMany(
    items: Array<{ productId: string; imageUrl: string; imageUrls: string[] }>,
    userId: string,
  ): Promise<{ count: number }> {
    if (!userId) throw new Error("Usuário não encontrado");
    if (!items.length) throw new Error("Nenhum produto selecionado");
    if (items.length > 200) {
      throw new Error("Limite de 200 produtos por batch");
    }
    const results = await prisma.$transaction(
      items.map((i) =>
        prisma.product.updateMany({
          where: { id: i.productId, userId },
          data: { imageUrl: i.imageUrl, imageUrls: i.imageUrls },
        }),
      ),
    );
    return { count: results.reduce((acc, r) => acc + r.count, 0) };
  }

  async update(
    id: string,
    data: ProductUpdate,
    userId?: string,
  ): Promise<ProductUpdateResult> {
    const product = await this.productRepository.findById(id, userId);
    if (!product) {
      throw new Error("Produto não encontrado");
    }

    const updated = await this.productRepository.update(id, data, userId);

    // Limpa overrides dos anúncios para os campos que o usuário editou no
    // produto. Sem isso, anúncios com priceOverride (criados via "Editar
    // anúncio individual") ignorariam a nova edição porque o re-sync
    // aplica override antes de enviar pro ML/Shopee.
    // Estratégia: edição no produto = "produto vira fonte da verdade" para
    // o campo editado. Outros campos com override permanecem intactos.
    await this.clearOverridesForEditedFields(id, product, data);

    // Run stock log + marketplace sync in parallel (both are independent)
    const stockLogPromise = (async () => {
      try {
        if (data.stock !== undefined && data.stock !== product.stock) {
          await prisma.stockLog.create({
            data: {
              productId: id,
              change: data.stock - product.stock,
              reason: "Manual update",
              previousStock: product.stock,
              newStock: data.stock,
            },
          });
        }
      } catch (error) {
        console.error("Erro ao registrar stock log no update manual:", error);
      }
    })();

    const syncPromise = (async () => {
      try {
        const results = await this.syncProductListings(updated);
        if (results && results.length > 0) {
          return {
            totalListings: results.length,
            successful: results.filter((r) => r.success).length,
            failed: results.filter((r) => !r.success).length,
            results,
          };
        }
        return undefined;
      } catch (error) {
        console.error("Erro ao sincronizar anúncios do produto:", error);
        // ⚠️ SEM `marketplace` NO LOG, e isso é o conserto — não um esquecimento.
        //
        // Este catch está ACIMA do laço por anúncio: `syncProductListings`
        // captura a falha de cada anúncio e a devolve como resultado, então o
        // que chega aqui é a etapa de sincronização inteira quebrando, para
        // TODOS os canais do produto de uma vez. Não existe um marketplace a
        // nomear.
        //
        // Antes ficava `"MercadoLivre"` fixo. Uma falha de OLX, Shopee ou
        // Magalu era registrada como falha do Mercado Livre — e quem fosse
        // investigar um incidente de canal começaria pelo canal errado.
        //
        // Trocar por `productId` não mexe em relatório nenhum: a produtividade
        // da equipe lê `details->>'marketplace'` só de CREATE_PRODUCT e
        // CREATE_LISTING com `level = INFO` (team-productivity.query.ts:23-38),
        // e esta linha é SYNC_STOCK com level ERROR.
        await SystemLogService.logError(
          "SYNC_STOCK",
          `Erro na sincronização: PRODUCT_UPDATE_SYNC — produto ${id}`,
          {
            resource: "Sync",
            resourceId: id,
            details: {
              syncType: "PRODUCT_UPDATE_SYNC",
              productId: id,
              error: error instanceof Error ? error.message : error,
            },
          },
        );
        return undefined;
      }
    })();

    const [, syncResults] = await Promise.all([stockLogPromise, syncPromise]);

    return {
      product: updated,
      syncResults,
    };
  }

  /**
   * Limpa overrides dos ProductListings vinculados a este produto APENAS
   * para os campos que o usuário editou neste update. Mantém overrides dos
   * outros campos para preservar customizações que ele não tocou.
   *
   * Decisão de design: edição no produto vira fonte da verdade para o
   * campo editado. Sem isso, anúncios com priceOverride (criados via
   * "Editar anúncio individual") ignoram a nova edição.
   *
   * Não faz round-trip ao ML/Shopee — a propagação real acontece em
   * `syncProductListings` chamado logo depois.
   */
  private async clearOverridesForEditedFields(
    productId: string,
    oldProduct: Product,
    data: ProductUpdate,
  ): Promise<void> {
    const clearOverrides: Record<string, null> = {};

    const stringChanged = (
      newVal: string | null | undefined,
      oldVal: string | null | undefined,
    ) =>
      newVal !== undefined &&
      (newVal ?? null) !== ((oldVal ?? null) as string | null);

    const numChanged = (
      newVal: number | null | undefined,
      oldVal: unknown,
    ) => {
      if (newVal === undefined) return false;
      const oldNum =
        typeof oldVal === "number"
          ? oldVal
          : oldVal && typeof oldVal === "object" && "toNumber" in (oldVal as object)
            ? (oldVal as { toNumber(): number }).toNumber()
            : oldVal == null
              ? null
              : Number(oldVal);
      return Number(newVal) !== oldNum;
    };

    const jsonChanged = (newVal: unknown, oldVal: unknown) => {
      if (newVal === undefined) return false;
      try {
        return JSON.stringify(newVal ?? null) !== JSON.stringify(oldVal ?? null);
      } catch {
        return true;
      }
    };

    if (stringChanged(data.name, oldProduct.name))
      clearOverrides.titleOverride = null;
    if (stringChanged(data.description, oldProduct.description))
      clearOverrides.descriptionOverride = null;
    if (numChanged(data.price, (oldProduct as { price?: unknown }).price))
      clearOverrides.priceOverride = null;
    if (stringChanged(data.brand, oldProduct.brand))
      clearOverrides.brandOverride = null;
    if (stringChanged(data.model, oldProduct.model))
      clearOverrides.modelOverride = null;
    if (stringChanged(data.year, oldProduct.year))
      clearOverrides.yearOverride = null;
    if (stringChanged(data.version, oldProduct.version))
      clearOverrides.versionOverride = null;
    if (stringChanged(data.category, oldProduct.category))
      clearOverrides.categoryOverride = null;
    const newMlCategory = data.mlCategoryId ?? data.mlCategory;
    const oldMlCategory =
      (oldProduct as { mlCategoryId?: string | null }).mlCategoryId ??
      (oldProduct as { mlCategory?: string | null }).mlCategory;
    if (stringChanged(newMlCategory, oldMlCategory))
      clearOverrides.mlCategoryOverride = null;
    if (
      stringChanged(
        data.shopeeCategoryId,
        (oldProduct as { shopeeCategoryId?: string | null }).shopeeCategoryId,
      )
    )
      clearOverrides.shopeeCategoryOverride = null;
    if (stringChanged(data.partNumber, oldProduct.partNumber))
      clearOverrides.partNumberOverride = null;
    if (stringChanged(data.quality, oldProduct.quality))
      clearOverrides.qualityOverride = null;
    if (numChanged(data.heightCm, oldProduct.heightCm))
      clearOverrides.heightCmOverride = null;
    if (numChanged(data.widthCm, oldProduct.widthCm))
      clearOverrides.widthCmOverride = null;
    if (numChanged(data.lengthCm, oldProduct.lengthCm))
      clearOverrides.lengthCmOverride = null;
    if (numChanged(data.weightKg, oldProduct.weightKg))
      clearOverrides.weightKgOverride = null;
    if (
      jsonChanged(
        data.imageUrls,
        (oldProduct as { imageUrls?: unknown }).imageUrls,
      )
    )
      clearOverrides.imageUrlsOverride = null;
    if (jsonChanged(data.attributes, oldProduct.attributes))
      clearOverrides.attributesOverride = null;
    if (stringChanged(data.sourceVehicle, oldProduct.sourceVehicle))
      clearOverrides.sourceVehicleOverride = null;

    if (Object.keys(clearOverrides).length === 0) return;

    try {
      const result = await prisma.productListing.updateMany({
        where: { productId },
        data: clearOverrides as Record<string, null>,
      });
      if (result.count > 0) {
        console.log(
          `[ProductUseCase] Cleared ${Object.keys(clearOverrides).join(",")} override(s) on ${result.count} listing(s) of product ${productId}`,
        );
      }
    } catch (error) {
      console.error(
        `[ProductUseCase] Failed to clear overrides for product ${productId}:`,
        error,
      );
      // Não bloqueia o update do produto — overrides desatualizados são
      // só uma inconsistência cosmética; o re-sync vai usar effectiveProduct
      // baseado nesses overrides até a próxima edição.
    }
  }

  /**
   * Gera o próximo SKU disponível
   * Formato: 001, 002, etc. Lê o contador `User.lastSkuSequential` (só produtos
   * de origem humana o incrementam — imports de marketplace são pulados no
   * `create()`). Migrações que atribuem SKUs numéricos externos (ex.: código do
   * sistema de origem) podem exigir um reset explícito do contador via
   * `scripts/backfill-last-sku-sequential.ts --value`.
   */
  async getNextSku(userId: string): Promise<string> {
    let n = (await this.userRepository.getLastSkuSequential(userId)) ?? 0;
    n += 1;
    // Pula SKUs já tomados — uma importação anterior pode ter usado um
    // valor dentro da janela sequencial (ex.: "032763"). Sem isso, o
    // create estouraria o índice único (userId, sku).
    for (let i = 0; i < 1000; i++) {
      const candidate = n.toString().padStart(3, "0");
      const existing = await this.productRepository.existsBySku(candidate, userId);
      if (!existing) return candidate;
      n++;
    }
    throw new Error("Não foi possível gerar próximo SKU disponível");
  }

  /**
   * Sincroniza anúncios relacionados após atualização do produto
   * Atualiza preço, estoque e outros campos nos marketplaces
   */
  private async syncProductListings(product: Product): Promise<
    Array<{
      success: boolean;
      productId: string;
      externalListingId: string;
      previousStock?: number;
      newStock?: number;
      previousPrice?: number;
      newPrice?: number;
      error?: string;
    }>
  > {
    try {
      console.log(
        `[SYNC] Iniciando sincronização para produto ${product.id} (${product.name})`,
      );

      // Buscar todos os anúncios vinculados a este produto
      const listings = await this.getProductListings(product.id);

      console.log(`[SYNC] Encontrados ${listings.length} anúncios vinculados`);

      if (listings.length === 0) {
        console.log(`[SYNC] Nenhum anúncio para sincronizar`);
        return []; // Nenhum anúncio para sincronizar
      }

      // Sincronizar cada anúncio em paralelo
      const results = await Promise.all(
        listings.map(async (listing) => {
          try {
            console.log(
              `[SYNC] Sincronizando anúncio ${listing.externalListingId} da conta ${listing.marketplaceAccountId}`,
            );
            return await SyncUseCase.syncProductData(
              product.id,
              listing.externalListingId,
              listing.marketplaceAccountId,
            );
          } catch (error) {
            console.error(
              `Erro ao sincronizar anúncio ${listing.externalListingId}:`,
              error,
            );
            return {
              success: false,
              productId: product.id,
              externalListingId: listing.externalListingId,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }),
      );

      return results;
    } catch (error) {
      console.error("Erro ao buscar anúncios do produto:", error);
      throw error;
    }
  }

  /**
   * Busca todos os anúncios vinculados a um produto
   * Only selects fields needed for sync operations
   */
  private async getProductListings(productId: string) {
    try {
      return await prisma.productListing.findMany({
        where: { productId },
        select: {
          id: true,
          externalListingId: true,
          marketplaceAccountId: true,
          marketplaceAccount: {
            select: {
              id: true,
              platform: true,
              accessToken: true,
              refreshToken: true,
              expiresAt: true,
              externalUserId: true,
              userId: true,
            },
          },
        },
      });
    } catch (error) {
      console.error("Erro ao buscar anúncios do produto:", error);
      throw error;
    }
  }
}
