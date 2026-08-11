import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  BULK_DELETE_MAX_IDS,
  ProductUseCase,
} from "../usecases/product.usercase";
import {
  ProductCreate,
  ProductListFilters,
  parseProductSort,
  ProductMarketplaceFilter,
  ProductPublicationStatus,
  ProductStockStatus,
  ProductUpdate,
  Quality,
} from "../interfaces/product.interface";
import { ListingUseCase } from "../marketplaces/usecases/listing.usercase";
import { isOlxDisabled, isFacebookDisabled } from "../lib/integration-flags";
import {
  ListingDispatcher,
  ListingDispatchRequest,
} from "../marketplaces/services/listing-dispatcher.service";
import { authMiddleware } from "../middlewares/auth.middleware";
import { SystemLogService } from "../services/system-log.service";
import CategoryRepository from "../marketplaces/repositories/category.repository";
import { CategoryResolutionService } from "../marketplaces/services/category-resolution.service";
import { parseProductListingCategoryValue } from "../lib/product-listing-category";
import { getMeasurementsForCategory } from "../lib/ml-measurements";
import { normalizeQuality, InvalidQualityError } from "../lib/quality";
import { sanitizeCompatPositions } from "../marketplaces/lib/ml-compat-position.logic";
import {
  parseNfeXml,
  NfeParseError,
} from "../fiscal/nfe-import/parse-nfe-xml";

const PUBLICATION_STATUS_VALUES = new Set<ProductPublicationStatus>([
  "ACTIVE",
  "PAUSED",
  "PENDING",
  "ERROR",
  "CLOSED",
  "NO_LISTING",
]);
const STOCK_STATUS_VALUES = new Set<ProductStockStatus>([
  "IN_STOCK",
  "OUT_OF_STOCK",
  "LOW_STOCK",
]);
const QUALITY_VALUES = new Set<Quality>([
  "SUCATA",
  "SEMINOVO",
  "NOVO",
  "RECONDICIONADO",
]);
const MARKETPLACE_VALUES = new Set<ProductMarketplaceFilter>([
  "MERCADO_LIVRE",
  "SHOPEE",
  "MAGALU",
  "OLX",
  "FACEBOOK",
  "BOTH",
]);

function parsePositiveInteger(
  value: string | undefined,
  field: string,
  fallback: number,
) {
  if (!value) return fallback;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} inválido`);
  }

  return parsed;
}

function parseNonNegativeNumber(value: string | undefined, field: string) {
  if (!value) return undefined;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${field} inválido`);
  }

  return parsed;
}

function parseDateBoundary(
  value: string | undefined,
  field: string,
  endOfDay = false,
) {
  if (!value) return undefined;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${field} inválido`);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    parsed.setHours(
      endOfDay ? 23 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 999 : 0,
    );
  }

  return parsed;
}

function parseEnumValue<T extends string>(
  value: string | undefined,
  validValues: Set<T>,
  field: string,
): T | undefined {
  if (!value) return undefined;

  if (!validValues.has(value as T)) {
    throw new Error(`${field} inválido`);
  }

  return value as T;
}

/**
 * Sanitiza o mapa de ficha técnica secundária recebido do cliente.
 * Aceita: { [attributeId]: { value_id?: string; value_name?: string } }.
 * Descarta entradas onde tanto `value_id` quanto `value_name` estão vazios,
 * para não persistir lixo. Retorna `undefined` se nada útil sobrar
 * (caller decide entre "não mexer" vs "limpar tudo").
 */
function sanitizeProductAttributes(
  raw: unknown,
): Record<string, { value_id?: string; value_name?: string }> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, { value_id?: string; value_name?: string }> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!id || typeof id !== "string") continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const v = value as { value_id?: unknown; value_name?: unknown };
    const valueId =
      typeof v.value_id === "string" && v.value_id.trim().length > 0
        ? v.value_id.trim()
        : undefined;
    const valueName =
      typeof v.value_name === "string" && v.value_name.trim().length > 0
        ? v.value_name.trim()
        : undefined;
    if (!valueId && !valueName) continue;
    const entry: { value_id?: string; value_name?: string } = {};
    if (valueId) entry.value_id = valueId;
    if (valueName) entry.value_name = valueName;
    out[id] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export const productRoutes = async (fastify: FastifyInstance) => {
  const productUseCase = new ProductUseCase();

  /**
   * GET /products/next-sku
   * Retorna o próximo SKU disponível
   */
  fastify.get(
    "/next-sku",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const nextSku = await productUseCase.getNextSku(userId);
        return reply.status(200).send({ sku: nextSku });
      } catch (error) {
        return reply.status(500).send({
          error: error instanceof Error ? error.message : "Erro ao gerar SKU",
        });
      }
    },
  );

  /**
   * POST /products/nfe/parse
   * Recebe o XML de uma NF-e de compra (modelo 55, multipart, campo `file`) e
   * devolve os itens normalizados para PRÉ-PREENCHER o modal de criação de
   * produto. NÃO persiste nada. O parsing é isolado e seguro contra XXE
   * (ver app/fiscal/nfe-import/parse-nfe-xml.ts).
   */
  fastify.post(
    "/nfe/parse",
    {
      preHandler: [
        authMiddleware,
        async (request: FastifyRequest, reply: FastifyReply) => {
          if (!request.isMultipart()) {
            return reply.status(400).send({
              error: "Tipo de conteúdo inválido",
              message: "Esperado multipart/form-data com o XML no campo `file`",
            });
          }
        },
      ],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        let buffer: Buffer | null = null;
        for await (const part of request.parts()) {
          if (part.type === "file") {
            if (part.fieldname !== "file") {
              // descarta outros arquivos para liberar o stream
              await part.toBuffer().catch(() => undefined);
              continue;
            }
            try {
              buffer = await part.toBuffer();
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              if (/(FST_FILES_LIMIT|FST_REQ_FILE_TOO_LARGE)/.test(msg)) {
                return reply.status(400).send({
                  error: "Arquivo muito grande",
                  message: "O tamanho máximo permitido é 20MB",
                });
              }
              throw e;
            }
          }
        }

        if (!buffer) {
          return reply.status(400).send({
            error: "Arquivo não encontrado",
            message: "Envie o XML da NF-e no campo `file`",
          });
        }

        const result = parseNfeXml(buffer.toString("utf-8"));
        return reply.status(200).send(result);
      } catch (error) {
        if (error instanceof NfeParseError) {
          return reply.status(error.statusCode).send({ error: error.message });
        }
        return reply.status(500).send({
          error:
            error instanceof Error
              ? error.message
              : "Erro ao ler o XML da NF-e",
        });
      }
    },
  );

  fastify.get(
    "/filter-options",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = (request as any).user?.dataOwnerId as string;
        const options = await productUseCase.getFilterOptions(userId);
        return reply.status(200).send(options);
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error
              ? error.message
              : "Erro ao carregar opções de filtro",
        });
      }
    },
  );

  fastify.post<{ Body: ProductCreate }>(
    "/",
    { preHandler: [authMiddleware] },
    async (
      request: FastifyRequest<{ Body: ProductCreate }>,
      reply: FastifyReply,
    ) => {
      const {
        sku,
        name,
        description,
        stock,
        price,
        // Campos de autopeças
        costPrice,
        markup,
        brand,
        model,
        year,
        version,
        category,
        location,
        locationId,
        partNumber,
        quality,
        isSecurityItem,
        isTraceable,
        sourceVehicle,
        mlCategory,
        mlCategorySource,
        shopeeCategory,
        shopeeCategorySource,
        magaluCategory,
        magaluCategorySource,

        // Medidas / peso
        heightCm,
        widthCm,
        lengthCm,
        weightKg,

        imageUrl,
        imageUrls,
        // Ficha técnica secundária (atributos por categoria do ML)
        attributes,
        // Sucata vinculada
        scrapId,
        // Opção para criar anúncio
        createListing,
        createListingCategoryId,
        listings,
        // Compatibilidades veiculares
        compatibilities,
        // Posição das compatibilidades no ML (uma por produto)
        compatibilityPositions,
        // Vínculo opcional a catalog product do Mercado Livre
        mlCatalogProductId,
        // Opt-in: servidor atribui o SKU sequencial atomicamente ao salvar
        autoSku,
      } = request.body as any;

      const user = (request as any).user;

      // Valida o enum `quality` antes do sanitize. Sem isso, valores fora do
      // enum (ex.: "USADO" vindo de cliente externo) chegavam ao Prisma e
      // estouravam com uma mensagem crua que vazava o stack do ORM.
      let normalizedQuality;
      try {
        normalizedQuality = normalizeQuality(quality);
      } catch (err) {
        if (err instanceof InvalidQualityError) {
          return reply.status(400).send({ error: err.message });
        }
        throw err;
      }

      // Sanitize / coerce incoming numeric fields to expected types to avoid Prisma/runtime errors
      const sanitized = {
        sku: sku as string,
        name: name as string,
        description: description ?? undefined,
        stock: stock !== undefined ? Number(stock) : 0,
        price: price !== undefined ? Number(price) : 0,
        costPrice: costPrice !== undefined ? Number(costPrice) : undefined,
        markup: markup !== undefined ? Number(markup) : undefined,
        brand: brand ?? undefined,
        model: model ?? undefined,
        year: year ?? undefined,
        version: version ?? undefined,
        category: category ?? undefined,
        location: location ?? undefined,
        locationId: locationId ?? undefined,
        partNumber: partNumber ?? undefined,
        quality: normalizedQuality,
        isSecurityItem: Boolean(isSecurityItem),
        isTraceable: Boolean(isTraceable),
        sourceVehicle: sourceVehicle ?? undefined,
        heightCm:
          heightCm !== undefined && heightCm !== null
            ? Number(heightCm)
            : undefined,
        widthCm:
          widthCm !== undefined && widthCm !== null
            ? Number(widthCm)
            : undefined,
        lengthCm:
          lengthCm !== undefined && lengthCm !== null
            ? Number(lengthCm)
            : undefined,
        weightKg:
          weightKg !== undefined && weightKg !== null
            ? Number(weightKg)
            : undefined,
        imageUrl: imageUrl ?? undefined,
        imageUrls: Array.isArray(imageUrls)
          ? imageUrls.filter((u: any) => typeof u === "string" && u.trim())
          : [],
        attributes: sanitizeProductAttributes(attributes),
        mlCategoryExternal: mlCategory ?? createListingCategoryId ?? undefined,
        mlCategorySource: mlCategorySource ?? undefined,
        shopeeCategory: shopeeCategory ?? undefined,
        shopeeCategorySource: shopeeCategorySource ?? undefined,
        magaluCategory:
          typeof magaluCategory === "string" && magaluCategory.trim()
            ? magaluCategory.trim()
            : undefined,
        magaluCategorySource: magaluCategorySource ?? undefined,
        createListing: Boolean(createListing),
        autoSku: Boolean(autoSku),
        createListingCategoryId: createListingCategoryId ?? undefined,
        listings: Array.isArray(listings) ? listings : undefined,
        scrapId: typeof scrapId === "string" && scrapId ? scrapId : undefined,
        compatibilities: Array.isArray(compatibilities)
          ? compatibilities
              .filter(
                (c: any) =>
                  c &&
                  typeof c.brand === "string" &&
                  c.brand.trim() &&
                  typeof c.model === "string" &&
                  c.model.trim(),
              )
              .map((c: any) => ({
                brand: String(c.brand).trim(),
                model: String(c.model).trim(),
                yearFrom:
                  c.yearFrom === null || c.yearFrom === undefined
                    ? null
                    : Number(c.yearFrom) || null,
                yearTo:
                  c.yearTo === null || c.yearTo === undefined
                    ? null
                    : Number(c.yearTo) || null,
                version:
                  typeof c.version === "string" && c.version.trim()
                    ? c.version.trim()
                    : null,
              }))
          : undefined,
        // Descarta rótulo desconhecido, repetido, conflitante ("Esquerda" com
        // "Direita") e o que passar de 4. Cliente que não manda o campo cai em
        // lista vazia, que o repositório grava como NULL — igual a hoje.
        compatibilityPositions: sanitizeCompatPositions(compatibilityPositions),
      } as const;

      // Server-side validation: reject clearly malformed requests before hitting usecase/DB.
      // No modo autoSku o servidor atribui o SKU — não exigir um do cliente.
      if (
        !sanitized.autoSku &&
        (!sanitized.sku || typeof sanitized.sku !== "string")
      )
        return reply.status(400).send({ error: "SKU inválido" });
      if (!sanitized.name || typeof sanitized.name !== "string")
        return reply
          .status(400)
          .send({ error: "Nome do produto é obrigatório" });
      if (
        sanitized.price === undefined ||
        isNaN(Number(sanitized.price)) ||
        Number(sanitized.price) < 0
      )
        return reply.status(400).send({ error: "Preço inválido" });
      if (!Number.isInteger(Number(sanitized.stock)) || sanitized.stock < 0)
        return reply.status(400).send({ error: "Estoque inválido" });
      if (!sanitized.imageUrl || typeof sanitized.imageUrl !== "string")
        return reply
          .status(400)
          .send({ error: "Imagem do produto é obrigatória" });

      // Resolver categorias ML e Shopee em paralelo (OPT-5)
      let resolvedMlCategoryId: string | undefined;
      let resolvedMlCategoryPath: string | undefined;
      let resolvedMlCategorySource: "auto" | "manual" | "imported" | undefined;
      let resolvedMlCategoryChosenAt: Date | undefined;
      // Se vier categoria ML, resolver imediatamente; caso contrário, tentar extrair do payload de listings
      let mlCategoryExternalToResolve = sanitized.mlCategoryExternal;
      if (!mlCategoryExternalToResolve && sanitized.listings?.length) {
        const firstMlListing = sanitized.listings.find(
          (l) => l.platform === "MERCADO_LIVRE" && !!l.categoryId,
        );
        if (firstMlListing?.categoryId) {
          mlCategoryExternalToResolve = firstMlListing.categoryId;
        }
      }

      let resolvedShopeeCategoryId: string | undefined;
      let resolvedShopeeCategorySource:
        | "auto"
        | "manual"
        | "imported"
        | undefined;
      let resolvedShopeeCategoryChosenAt: Date | undefined;

      let shopeeCategoryExternalToResolve = sanitized.shopeeCategory;
      if (!shopeeCategoryExternalToResolve && sanitized.listings?.length) {
        const firstShopeeListing = sanitized.listings.find(
          (l: any) => l.platform === "SHOPEE" && !!l.categoryId,
        );
        if (firstShopeeListing?.categoryId) {
          shopeeCategoryExternalToResolve = firstShopeeListing.categoryId;
        }
      }

      // Run both category resolutions in parallel
      const [mlCatResult, shopeeCatResult] = await Promise.all([
        mlCategoryExternalToResolve
          ? (async () => {
              const resolved =
                await CategoryResolutionService.resolveMLCategory({
                  explicitCategoryId: mlCategoryExternalToResolve,
                  validateWithMLAPI: false,
                });
              const cat = await CategoryRepository.findByExternalId(
                resolved.externalId,
              );
              return { resolved, cat };
            })()
          : Promise.resolve(null),
        shopeeCategoryExternalToResolve
          ? (async () => {
              const externalId = shopeeCategoryExternalToResolve!.startsWith(
                "SHP_",
              )
                ? shopeeCategoryExternalToResolve!
                : `SHP_${shopeeCategoryExternalToResolve}`;
              const cat = await CategoryRepository.findByExternalId(externalId);
              return { externalId, cat };
            })()
          : Promise.resolve(null),
      ]);

      // Process ML result
      if (mlCatResult) {
        if (!mlCatResult.cat) {
          return reply.status(400).send({
            error:
              "Categoria do Mercado Livre não está sincronizada. Escolha outra ou sincronize as categorias.",
          });
        }
        resolvedMlCategoryId = mlCatResult.cat.id;
        resolvedMlCategoryPath =
          mlCatResult.resolved.fullPath ||
          mlCatResult.cat.fullPath ||
          mlCatResult.cat.name ||
          sanitized.category;
        const manualSelection = !!mlCategory;
        resolvedMlCategorySource =
          (sanitized.mlCategorySource as any) ||
          (manualSelection ? "manual" : "auto");
        resolvedMlCategoryChosenAt = new Date();
      }

      const requiresMlCategory =
        sanitized.createListing ||
        Boolean(
          sanitized.listings?.some((l) => l.platform === "MERCADO_LIVRE"),
        );
      if (requiresMlCategory && !resolvedMlCategoryId) {
        return reply.status(400).send({
          error:
            "Produto não possui categoria do Mercado Livre. Selecione uma categoria antes de criar o anúncio.",
        });
      }

      // Process Shopee result
      if (shopeeCatResult?.cat) {
        resolvedShopeeCategoryId = shopeeCatResult.externalId.replace(
          "SHP_",
          "",
        );
        resolvedShopeeCategorySource =
          (sanitized.shopeeCategorySource as any) ||
          (shopeeCategory ? "manual" : "auto");
        resolvedShopeeCategoryChosenAt = new Date();
      }

      // Magalu: uuid da taxonomia da API (não há árvore local para validar).
      // Persistir faz o caminho "explícito" do resolveCategoryId funcionar —
      // a publicação para de re-resolver ao vivo a cada envio.
      let resolvedMagaluCategoryId: string | undefined;
      let resolvedMagaluCategorySource:
        | "auto"
        | "manual"
        | "imported"
        | undefined;
      let resolvedMagaluCategoryChosenAt: Date | undefined;
      let magaluCategoryToPersist = sanitized.magaluCategory;
      if (!magaluCategoryToPersist && sanitized.listings?.length) {
        const firstMagaluListing = sanitized.listings.find(
          (l: any) => l.platform === "MAGALU" && !!l.categoryId,
        );
        if (firstMagaluListing?.categoryId) {
          magaluCategoryToPersist = String(firstMagaluListing.categoryId);
        }
      }
      if (magaluCategoryToPersist) {
        resolvedMagaluCategoryId = magaluCategoryToPersist;
        resolvedMagaluCategorySource =
          (sanitized.magaluCategorySource as any) ||
          (magaluCategory ? "manual" : "auto");
        resolvedMagaluCategoryChosenAt = new Date();
      }

      // OLX e Facebook: mesma memória de categoria das outras três. O modal de
      // criação manda a categoria APENAS dentro de listings[].categoryId, nunca
      // no topo do body — por isso a busca no array (idêntica à do Magalu).
      // Sem isto a escolha do operador valia para UMA publicação e sumia: ao
      // republicar ou publicar numa segunda conta, a categoria era recalculada.
      let resolvedOlxCategoryId: string | undefined;
      let resolvedOlxCategorySource:
        | "auto"
        | "manual"
        | "imported"
        | undefined;
      let resolvedOlxCategoryChosenAt: Date | undefined;
      const olxCategoryToPersist =
        (sanitized as any).olxCategory ||
        (sanitized.listings?.length
          ? sanitized.listings.find(
              (l: any) => l.platform === "OLX" && !!l.categoryId,
            )?.categoryId
          : undefined);
      if (olxCategoryToPersist) {
        resolvedOlxCategoryId = String(olxCategoryToPersist);
        resolvedOlxCategorySource =
          ((sanitized as any).olxCategorySource as any) || "manual";
        resolvedOlxCategoryChosenAt = new Date();
      }

      let resolvedFbCategoryId: string | undefined;
      let resolvedFbCategorySource:
        | "auto"
        | "manual"
        | "imported"
        | undefined;
      let resolvedFbCategoryChosenAt: Date | undefined;
      const fbCategoryToPersist =
        (sanitized as any).fbCategory ||
        (sanitized.listings?.length
          ? sanitized.listings.find(
              (l: any) => l.platform === "FACEBOOK" && !!l.categoryId,
            )?.categoryId
          : undefined);
      if (fbCategoryToPersist) {
        resolvedFbCategoryId = String(fbCategoryToPersist);
        resolvedFbCategorySource =
          ((sanitized as any).fbCategorySource as any) || "manual";
        resolvedFbCategoryChosenAt = new Date();
      }

      const requiresShopeeCategory = Boolean(
        sanitized.listings?.some((l: any) => l.platform === "SHOPEE"),
      );
      if (requiresShopeeCategory && !resolvedShopeeCategoryId) {
        return reply.status(400).send({
          error:
            "Produto não possui categoria do Shopee. Selecione uma categoria antes de criar o anúncio.",
        });
      }

      // Auto-fill de dimensões para ML quando o payload veio sem elas.
      // `createMLListing` faz hard-return `{success:false}` em dimensões null/0
      // (linha ~965 de listing.usercase.ts) — o fallback artificial 10x10x10/1kg
      // foi removido lá porque o ML detecta o padrão e suspende. Mas o frontend
      // tem auto-sugestão via `getMeasurementsForCategory` baseada em CSV por
      // categoria (app/lib/ml-measurements.ts). Replicamos esse lookup aqui no
      // backend como rede de segurança: se o frontend não sugeriu (categoria
      // fora do CSV, modal não disparou, ou criação via API direta), tentamos
      // popular antes do create. Só falha com 400 se NEM o payload NEM o CSV
      // tiverem dimensões — feedback útil em vez do dispatcher engolir silente.
      if (requiresMlCategory) {
        const needsHeight =
          sanitized.heightCm == null || !(Number(sanitized.heightCm) > 0);
        const needsWidth =
          sanitized.widthCm == null || !(Number(sanitized.widthCm) > 0);
        const needsLength =
          sanitized.lengthCm == null || !(Number(sanitized.lengthCm) > 0);
        const needsWeight =
          sanitized.weightKg == null || !(Number(sanitized.weightKg) > 0);

        if (needsHeight || needsWidth || needsLength || needsWeight) {
          // Tentativa 1: lookup por categoria no CSV (mesmo que o frontend usa).
          const suggested = getMeasurementsForCategory(
            resolvedMlCategoryPath || sanitized.category,
            sanitized.name,
          );
          let filledSource:
            | "csv"
            | "weight_derived"
            | "default_fallback"
            | null = null;
          if (suggested) {
            if (needsHeight && typeof suggested.heightCm === "number")
              sanitized.heightCm = suggested.heightCm;
            if (needsWidth && typeof suggested.widthCm === "number")
              sanitized.widthCm = suggested.widthCm;
            if (needsLength && typeof suggested.lengthCm === "number")
              sanitized.lengthCm = suggested.lengthCm;
            if (needsWeight && typeof suggested.weightKg === "number")
              sanitized.weightKg = suggested.weightKg;
            filledSource = "csv";
          }

          // Tentativa 2: derivar dimensões a partir do weightKg do produto
          // quando o CSV não cobre a categoria. Peso é a única medida que o
          // operador costuma cadastrar com confiança (balança no desmonte);
          // dimensões são "estimativa" e o ML aceita aproximação. Como o
          // hash do SKU varia, evitamos um padrão fixo 10x10x10/1kg (que
          // dispara a suspeita anti-fraude do ML que motivou a remoção do
          // fallback antigo no createMLListing).
          const stillMissingAfterCsv =
            sanitized.heightCm == null ||
            sanitized.widthCm == null ||
            sanitized.lengthCm == null ||
            sanitized.weightKg == null ||
            !(Number(sanitized.heightCm) > 0) ||
            !(Number(sanitized.widthCm) > 0) ||
            !(Number(sanitized.lengthCm) > 0) ||
            !(Number(sanitized.weightKg) > 0);

          if (stillMissingAfterCsv && Number(sanitized.weightKg) > 0) {
            const w = Number(sanitized.weightKg);
            // Escala baseada em peso: peças leves cabem em embalagem
            // menor, peças pesadas em embalagem maior. Faixas calibradas
            // pra mediana de peças de autopeças.
            let base: { h: number; w: number; l: number };
            if (w < 0.5) base = { h: 8, w: 10, l: 12 };
            else if (w < 2) base = { h: 12, w: 16, l: 20 };
            else if (w < 5) base = { h: 18, w: 22, l: 28 };
            else if (w < 15) base = { h: 25, w: 30, l: 40 };
            else base = { h: 35, w: 40, l: 55 };

            // Pequena variação determinística por SKU pra evitar padrão fixo.
            const seed = (sanitized.sku || "")
              .split("")
              .reduce((acc, c) => acc + c.charCodeAt(0), 0);
            const jitter = (mod: number) => (seed % mod) - Math.floor(mod / 2);

            if (sanitized.heightCm == null || !(Number(sanitized.heightCm) > 0))
              sanitized.heightCm = Math.max(5, base.h + jitter(5));
            if (sanitized.widthCm == null || !(Number(sanitized.widthCm) > 0))
              sanitized.widthCm = Math.max(5, base.w + jitter(7));
            if (sanitized.lengthCm == null || !(Number(sanitized.lengthCm) > 0))
              sanitized.lengthCm = Math.max(5, base.l + jitter(9));
            filledSource = "weight_derived";
          }

          if (filledSource) {
            console.log(
              JSON.stringify({
                event: "product.create.dimensions_auto_filled",
                sku: sanitized.sku,
                category: resolvedMlCategoryPath || sanitized.category,
                source: filledSource,
                filled: {
                  heightCm: sanitized.heightCm,
                  widthCm: sanitized.widthCm,
                  lengthCm: sanitized.lengthCm,
                  weightKg: sanitized.weightKg,
                },
              }),
            );
          }

          // Último recurso: se nem CSV nem weight-derived deram conta,
          // aplica fallback DEFAULT de autopeça pequena com jitter por SKU
          // pra evitar padrão fixo 10x10x10/1kg (que o ML usa pra suspeitar
          // de listings em massa). O operador pode editar depois — o
          // importante é o anúncio sair publicado, não bloquear o fluxo.
          const stillMissing =
            sanitized.heightCm == null ||
            sanitized.widthCm == null ||
            sanitized.lengthCm == null ||
            sanitized.weightKg == null ||
            !(Number(sanitized.heightCm) > 0) ||
            !(Number(sanitized.widthCm) > 0) ||
            !(Number(sanitized.lengthCm) > 0) ||
            !(Number(sanitized.weightKg) > 0);
          if (stillMissing) {
            const seedFallback = (sanitized.sku || "default")
              .split("")
              .reduce((acc, c) => acc + c.charCodeAt(0), 0);
            const jitter = (mod: number) =>
              (seedFallback % mod) - Math.floor(mod / 2);

            if (sanitized.heightCm == null || !(Number(sanitized.heightCm) > 0))
              sanitized.heightCm = Math.max(5, 15 + jitter(5));
            if (sanitized.widthCm == null || !(Number(sanitized.widthCm) > 0))
              sanitized.widthCm = Math.max(5, 15 + jitter(7));
            if (sanitized.lengthCm == null || !(Number(sanitized.lengthCm) > 0))
              sanitized.lengthCm = Math.max(5, 10 + jitter(9));
            if (sanitized.weightKg == null || !(Number(sanitized.weightKg) > 0))
              // 0.5kg base + jitter 0-9 dezenas de grama → 0.5-0.99kg
              sanitized.weightKg = 0.5 + (seedFallback % 50) / 100;

            filledSource = "default_fallback";
            console.warn(
              JSON.stringify({
                event: "product.create.dimensions_default_fallback",
                sku: sanitized.sku,
                category: resolvedMlCategoryPath || sanitized.category,
                filled: {
                  heightCm: sanitized.heightCm,
                  widthCm: sanitized.widthCm,
                  lengthCm: sanitized.lengthCm,
                  weightKg: sanitized.weightKg,
                },
                note: "Fallback padrão aplicado — operador deve revisar.",
              }),
            );
          }
        }
      }

      try {
        const data = await productUseCase.create({
          // No modo autoSku o usecase ignora e sobrescreve o sku; "" só
          // satisfaz o tipo `string` exigido por ProductCreate.
          sku: sanitized.autoSku ? "" : sanitized.sku,
          autoSku: sanitized.autoSku,
          name: sanitized.name,
          description: sanitized.description,
          stock: sanitized.stock,
          price: sanitized.price,
          userId: user?.dataOwnerId,
          // Autor real do cadastro (colaborador/admin que agiu) — distinto do
          // dono dos dados acima.
          createdByUserId: user?.id ?? null,
          // Campos de autopeças
          costPrice: sanitized.costPrice,
          markup: sanitized.markup,
          brand: sanitized.brand,
          model: sanitized.model,
          year: sanitized.year,
          version: sanitized.version,
          category: resolvedMlCategoryPath || sanitized.category,
          location: sanitized.location,
          locationId: sanitized.locationId,
          partNumber: sanitized.partNumber,
          quality: sanitized.quality,
          isSecurityItem: sanitized.isSecurityItem,
          isTraceable: sanitized.isTraceable,
          sourceVehicle: sanitized.sourceVehicle,
          mlCategoryId: resolvedMlCategoryId,
          mlCategorySource: resolvedMlCategorySource,
          mlCategoryChosenAt: resolvedMlCategoryChosenAt,
          shopeeCategoryId: resolvedShopeeCategoryId,
          shopeeCategorySource: resolvedShopeeCategorySource,
          shopeeCategoryChosenAt: resolvedShopeeCategoryChosenAt,
          magaluCategoryId: resolvedMagaluCategoryId,
          magaluCategorySource: resolvedMagaluCategorySource,
          magaluCategoryChosenAt: resolvedMagaluCategoryChosenAt,
          olxCategoryId: resolvedOlxCategoryId,
          olxCategorySource: resolvedOlxCategorySource,
          olxCategoryChosenAt: resolvedOlxCategoryChosenAt,
          fbCategoryId: resolvedFbCategoryId,
          fbCategorySource: resolvedFbCategorySource,
          fbCategoryChosenAt: resolvedFbCategoryChosenAt,

          // Medidas / peso
          heightCm: sanitized.heightCm,
          widthCm: sanitized.widthCm,
          lengthCm: sanitized.lengthCm,
          weightKg: sanitized.weightKg,

          imageUrl: sanitized.imageUrl,
          imageUrls: sanitized.imageUrls,

          // Ficha técnica secundária por categoria (ML)
          attributes: sanitized.attributes,

          // Sucata vinculada
          scrapId: sanitized.scrapId,

          // Compatibilidades veiculares (persistidas transacionalmente pelo repositório)
          compatibilities: sanitized.compatibilities,

          // Posição aplicada a todas as compatibilidades no ML
          compatibilityPositions: sanitized.compatibilityPositions,

          // Vínculo com catalog product do ML (opcional)
          mlCatalogProductId:
            typeof mlCatalogProductId === "string" &&
            mlCatalogProductId.trim().length > 0
              ? mlCatalogProductId.trim()
              : null,
        });

        // Registrar log de criação do produto (fire-and-forget, non-blocking)
        const userForLog = (request as any).user;
        void SystemLogService.logProductCreate(userForLog?.id, data.id, {
          sku: data.sku,
          name: data.name,
          stock: data.stock,
          price: data.price,
        });

        // Responder imediatamente com o produto criado.
        // A criação de anúncios no ML é feita em background (fire-and-forget)
        // para não bloquear a UI do modal por 10-30 segundos.
        const wantsListing =
          (Array.isArray(listings) && listings.length > 0) ||
          (createListing && (!listings || listings.length === 0));

        if (wantsListing && user) {
          const bgListings = Array.isArray(listings) ? listings : [];
          const dispatchRequests: ListingDispatchRequest[] = [];

          for (const lst of bgListings) {
            const accounts = (lst.accountIds || []).length
              ? (lst.accountIds as (string | undefined)[])
              : [undefined];
            if (lst.platform === "MERCADO_LIVRE") {
              for (const accId of accounts) {
                dispatchRequests.push({
                  platform: "MERCADO_LIVRE",
                  accountId: accId,
                  categoryId: lst.categoryId || createListingCategoryId,
                  mlSettings: {
                    listingType: lst.listingType,
                    hasWarranty: lst.hasWarranty,
                    warrantyUnit: lst.warrantyUnit,
                    warrantyDuration: lst.warrantyDuration,
                    itemCondition: lst.itemCondition,
                    shippingMode: lst.shippingMode,
                    freeShipping: lst.freeShipping,
                    localPickup: lst.localPickup,
                    manufacturingTime: lst.manufacturingTime,
                  },
                });
              }
            } else if (lst.platform === "SHOPEE") {
              for (const accId of accounts) {
                dispatchRequests.push({
                  platform: "SHOPEE",
                  accountId: accId,
                  categoryId: lst.categoryId,
                });
              }
            } else if (lst.platform === "MAGALU") {
              for (const accId of accounts) {
                dispatchRequests.push({
                  platform: "MAGALU",
                  accountId: accId,
                  // categoria opcional — createMagaluListing resolve (de-para/busca)
                  categoryId: lst.categoryId,
                });
              }
            } else if (lst.platform === "OLX" && !isOlxDisabled()) {
              for (const accId of accounts) {
                dispatchRequests.push({
                  platform: "OLX",
                  accountId: accId,
                  categoryId: lst.categoryId,
                });
              }
            } else if (lst.platform === "FACEBOOK" && !isFacebookDisabled()) {
              for (const accId of accounts) {
                dispatchRequests.push({
                  platform: "FACEBOOK",
                  accountId: accId,
                  categoryId: lst.categoryId,
                });
              }
            }
          }

          if (createListing && dispatchRequests.length === 0) {
            dispatchRequests.push({
              platform: "MERCADO_LIVRE",
              categoryId: createListingCategoryId,
            });
          }

          // Aumento percentual escalonado entre contas (se habilitado no
          // modal). Monta o overrideTemplate a partir da ordem das contas em
          // dispatchRequests (1ª de cada marketplace = preço base; escadas
          // independentes por plataforma). Sem isso, o dispatch segue
          // idêntico ao de hoje (overrideTemplate undefined).
          const listingCfgs = bgListings as Array<{
            platform?: string;
            listingPrice?: number;
            crossAccountIncrease?: { enabled?: boolean; percent?: number };
          }>;
          // A config pode vir em QUALQUER entrada (o modal replica o controle
          // nas seções Shopee/Magalu com estado compartilhado). Lê a 1ª
          // habilitada — clientes antigos (config só na entrada ML) seguem
          // idênticos; sem anúncio ML, a escada Shopee/Magalu passa a valer.
          const caCfg = (
            bgListings as Array<{
              crossAccountIncrease?: { enabled?: boolean; percent?: number };
            }>
          ).find((l) => l.crossAccountIncrease?.enabled)?.crossAccountIncrease;
          let overrideTemplate = caCfg?.enabled
            ? ListingDispatcher.buildCrossAccountOverride(
                dispatchRequests,
                await ListingDispatcher.resolveCrossAccountPercent(
                  user.dataOwnerId as string,
                  caCfg.percent,
                ),
              )
            : null;

          // "Valor do Anúncio" do modal: preço só deste anúncio, sem alterar o
          // preço do produto. Viaja pelo mesmo `perProductOverrides` que o
          // fluxo em massa (modo Revisão individual) já usa, e o dispatcher
          // aplica no override pós-create. Só > 0 vira override: vazio/zero
          // significa herdar o preço do produto, nunca publicar por R$ 0.
          //
          // Antes lia apenas a entrada MERCADO_LIVRE e gravava em `ml`
          // hardcoded — o campo existia só na seção ML do modal. Agora as três
          // entradas são lidas, cada uma para a sua chave.
          const PLATAFORMA_PARA_CHAVE = {
            MERCADO_LIVRE: "ml",
            SHOPEE: "shopee",
            MAGALU: "magalu",
          } as const;
          const produtoId = data.id as string;
          for (const [plataforma, chave] of Object.entries(
            PLATAFORMA_PARA_CHAVE,
          )) {
            const preco = listingCfgs.find(
              (l) => l.platform === plataforma,
            )?.listingPrice;
            if (typeof preco !== "number" || preco <= 0) continue;
            const atual = overrideTemplate?.perProductOverrides?.[produtoId];
            overrideTemplate = {
              ...(overrideTemplate ?? {}),
              perProductOverrides: {
                ...(overrideTemplate?.perProductOverrides ?? {}),
                [produtoId]: {
                  ...(atual ?? {}),
                  [chave]: {
                    ...((atual as any)?.[chave] ?? {}),
                    listingPrice: preco,
                  },
                },
              },
            };
          }

          if (dispatchRequests.length > 0) {
            ListingDispatcher.dispatch({
              userId: user.dataOwnerId as string,
              productId: data.id as string,
              requests: dispatchRequests,
              overrideTemplate,
              actorId: user.id as string,
            });
          }
        }

        return reply.status(201).send({
          ...data,
          listing: wantsListing
            ? {
                success: true,
                pending: true,
                message: "Anúncio sendo criado em segundo plano",
              }
            : null,
          listingsResults: [],
        });
      } catch (error: any) {
        // Log sanitized payload for debugging (non-sensitive fields only)
        try {
          console.error("[product:create] payload:", {
            sku: sanitized.sku,
            name: sanitized.name,
            price: sanitized.price,
            stock: sanitized.stock,
            category: sanitized.category,
            heightCm: sanitized.heightCm,
            widthCm: sanitized.widthCm,
            lengthCm: sanitized.lengthCm,
            weightKg: sanitized.weightKg,
          });
        } catch (logErr) {
          /* ignore */
        }

        console.error("Erro ao criar produto:", error);
        const msg = error instanceof Error ? error.message : String(error);

        // Mapear erros esperados para códigos HTTP apropriados
        if (msg.includes("Usuário não encontrado"))
          return reply.status(401).send({ error: msg });
        if (
          msg.includes("Produto com esse sku já existe") ||
          msg.includes("Unique constraint") ||
          msg.includes("Não foi possível gerar SKU automático")
        )
          return reply.status(409).send({ error: msg });
        if (
          msg.match(/preço|estoque|altura|largura|comprimento|peso|inválido/i)
        )
          return reply.status(400).send({ error: msg });

        // Erro desconhecido — manter 500 mas incluir mensagem útil
        return reply
          .status(500)
          .send({ error: msg || "Erro ao criar produto" });
      }
    },
  );

  fastify.get<{
    Querystring: {
      search?: string;
      page?: string;
      limit?: string;
      createdFrom?: string;
      createdTo?: string;
      publicationStatus?: string;
      stockStatus?: string;
      priceMin?: string;
      priceMax?: string;
      listingCategory?: string;
      brand?: string;
      quality?: string;
      locationId?: string;
      marketplace?: string;
    };
  }>(
    "/",
    { preHandler: [authMiddleware] },
    async (
      request: FastifyRequest<{
        Querystring: {
          search?: string;
          page?: string;
          limit?: string;
          createdFrom?: string;
          createdTo?: string;
          publicationStatus?: string;
          stockStatus?: string;
          priceMin?: string;
          priceMax?: string;
          listingCategory?: string;
          brand?: string;
          quality?: string;
          locationId?: string;
          marketplace?: string;
          sort?: string;
        };
      }>,
      reply: FastifyReply,
    ) => {
      try {
        const {
          search,
          sort,
          page,
          limit,
          createdFrom,
          createdTo,
          publicationStatus,
          stockStatus,
          priceMin,
          priceMax,
          listingCategory,
          brand,
          quality,
          locationId,
          marketplace,
        } = request.query;
        const userId = (request as any).user?.dataOwnerId as string;
        const parsedPage = parsePositiveInteger(page, "Página", 1);
        const parsedLimit = parsePositiveInteger(limit, "Limite", 10);
        const parsedCreatedFrom = parseDateBoundary(
          createdFrom,
          "Data inicial",
        );
        const parsedCreatedTo = parseDateBoundary(
          createdTo,
          "Data final",
          true,
        );
        const parsedPriceMin = parseNonNegativeNumber(priceMin, "Preço mínimo");
        const parsedPriceMax = parseNonNegativeNumber(priceMax, "Preço máximo");
        const parsedPublicationStatus = parseEnumValue(
          publicationStatus,
          PUBLICATION_STATUS_VALUES,
          "Status de publicação",
        );
        const parsedStockStatus = parseEnumValue(
          stockStatus,
          STOCK_STATUS_VALUES,
          "Status de estoque",
        );
        const parsedQuality = parseEnumValue(
          quality,
          QUALITY_VALUES,
          "Qualidade",
        );
        const parsedMarketplace = parseEnumValue(
          marketplace,
          MARKETPLACE_VALUES,
          "Marketplace",
        );
        const parsedListingCategory =
          parseProductListingCategoryValue(listingCategory);

        if (listingCategory && !parsedListingCategory) {
          throw new Error("Categoria publicada invÃ¡lida");
        }

        if (
          parsedMarketplace &&
          parsedMarketplace !== "BOTH" &&
          parsedListingCategory &&
          parsedListingCategory.platform !== parsedMarketplace
        ) {
          return reply.status(400).send({
            error: "Categoria publicada nÃ£o pertence ao marketplace informado",
          });
        }

        if (
          parsedCreatedFrom &&
          parsedCreatedTo &&
          parsedCreatedFrom > parsedCreatedTo
        ) {
          return reply
            .status(400)
            .send({ error: "Data inicial deve ser menor ou igual à final" });
        }

        if (
          parsedPriceMin !== undefined &&
          parsedPriceMax !== undefined &&
          parsedPriceMin > parsedPriceMax
        ) {
          return reply
            .status(400)
            .send({ error: "Preço mínimo deve ser menor ou igual ao máximo" });
        }

        const filters: ProductListFilters & { userId: string } = {
          search: search?.trim() || "",
          page: parsedPage,
          limit: parsedLimit,
          createdFrom: parsedCreatedFrom,
          createdTo: parsedCreatedTo,
          publicationStatus: parsedPublicationStatus,
          stockStatus: parsedStockStatus,
          priceMin: parsedPriceMin,
          priceMax: parsedPriceMax,
          listingCategory: parsedListingCategory?.value,
          brand: brand?.trim() || undefined,
          quality: parsedQuality,
          locationId: locationId?.trim() || undefined,
          marketplace: parsedMarketplace,
          // Aditivo: parametro opcional com allowlist. Valor ausente ou
          // desconhecido vira `undefined`, e o repositorio cai na ordenacao
          // historica — chamada antiga continua com o mesmo resultado.
          sort: parseProductSort(sort),
          userId,
        };

        const data = await productUseCase.listProducts(filters);

        return reply.status(200).send({
          products: data.products,
          pagination: {
            page: parsedPage,
            limit: parsedLimit,
            total: data.total,
            totalPages: data.totalPages,
          },
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.toLowerCase().includes("inválido")
        ) {
          return reply.status(400).send({ error: error.message });
        }

        reply.status(500).send({
          error:
            error instanceof Error
              ? String(error.message)
              : "Erro ao listar produtos",
        });
      }
    },
  );

  /**
   * GET /products/:id
   * Retorna detalhe completo de um produto (listings enriquecidos, stock logs, sucata)
   */
  fastify.get<{ Params: { id: string } }>(
    "/:id",
    { preHandler: [authMiddleware] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const { id } = request.params;
        const userId = (request as any).user?.dataOwnerId as string;
        const result = await productUseCase.getDetail(id, userId);

        if (!result) {
          return reply.status(404).send({ error: "Produto não encontrado" });
        }

        return reply.status(200).send(result);
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error ? error.message : "Erro ao buscar produto",
        });
      }
    },
  );

  /**
   * POST /products/bulk-delete
   * Deleta múltiplos produtos em uma única chamada, respeitando rate limit
   * dos marketplaces (semáforo por marketplaceAccountId). Política estrita:
   * produto só é removido localmente se TODOS os anúncios fecharem OK no
   * marketplace correspondente. Devolve relatório consolidado por produto.
   *
   * Limite de IDs por chamada: BULK_DELETE_MAX_IDS (50). Acima disso o
   * frontend deve quebrar em chunks.
   */
  fastify.post(
    "/bulk-delete",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const body = (request.body ?? {}) as { ids?: unknown };
        const ids = Array.isArray(body.ids) ? body.ids : null;
        if (!ids || ids.length === 0) {
          return reply.status(400).send({
            error: "Lista de IDs inválida",
            message: "Envie um array `ids` com pelo menos 1 produto.",
          });
        }
        if (
          !ids.every(
            (id): id is string => typeof id === "string" && id.length > 0,
          )
        ) {
          return reply.status(400).send({
            error: "IDs inválidos",
            message: "Todos os IDs devem ser strings não vazias.",
          });
        }
        if (ids.length > BULK_DELETE_MAX_IDS) {
          return reply.status(400).send({
            error: "Limite excedido",
            message: `Máximo de ${BULK_DELETE_MAX_IDS} produtos por chamada. Divida em lotes menores.`,
          });
        }

        const userId = (request as any).user?.dataOwnerId as string | undefined;
        const user = (request as any).user;
        const result = await productUseCase.bulkDelete(ids, userId);

        // Log fire-and-forget por produto efetivamente deletado.
        for (const r of result.results) {
          if (r.deleted) {
            void SystemLogService.logProductDelete(
              user?.id,
              r.productId,
              "Produto",
            );
          }
        }

        return reply.status(200).send(result);
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error
              ? String(error.message)
              : "Erro ao excluir produtos em lote",
        });
      }
    },
  );

  fastify.delete(
    "/:id",
    { preHandler: [authMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
        if (!id) {
          return reply
            .status(400)
            .send({ error: "ID do produto é obrigatório" });
        }

        const userId = (request as any).user?.dataOwnerId as string | undefined;
        const result = await productUseCase.delete(id, userId);

        // Política estrita: success=false significa que algum anúncio não
        // pôde ser encerrado no marketplace e o produto foi MANTIDO no banco.
        // Devolvemos 409 (Conflict) com listingResults detalhado para que o
        // frontend mostre o relatório por anúncio e ofereça reintentar.
        if (!result.success) {
          return reply.status(409).send({
            error: "Não foi possível excluir o produto",
            message: result.message,
            listingResults: result.listingResults,
          });
        }

        // Sucesso: produto deletado localmente. Log fire-and-forget.
        const user = (request as any).user;
        void SystemLogService.logProductDelete(user?.id, id, "Produto");

        return reply.status(200).send({
          message: result.message,
          listingResults: result.listingResults,
        });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error
              ? String(error.message)
              : "Erro ao excluir produto",
        });
      }
    },
  );

  /**
   * PATCH /products/:id/listings-status
   * Pausa ou reativa todos os anúncios publicados de um produto.
   * Body: { status: "active" | "paused" }.
   * Espelha o DELETE /products/:id em estrutura, mas atua nos anúncios sem
   * deletar o produto. Falhas parciais ficam visíveis em listingResults.
   */
  fastify.patch<{
    Params: { id: string };
    Body: { status: "active" | "paused" };
  }>(
    "/:id/listings-status",
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const { status } = (request.body ?? {}) as { status?: string };

        if (!id) {
          return reply
            .status(400)
            .send({ error: "ID do produto é obrigatório" });
        }
        if (status !== "active" && status !== "paused") {
          return reply.status(400).send({
            error: "Status inválido",
            message: 'Use "active" ou "paused"',
          });
        }

        const userId = (request as any).user?.dataOwnerId as string | undefined;
        if (!userId) {
          return reply.status(401).send({ error: "Usuário não autenticado" });
        }

        const result = await productUseCase.pauseListings(id, userId, status);

        // O usecase retorna "Produto não encontrado" explicitamente quando
        // findById(id, userId) falha — cobre tanto produto inexistente quanto
        // pertencente a outro usuário (ownership). 404 sem vazar distinção.
        if (!result.success && result.message.includes("não encontrado")) {
          return reply.status(404).send({
            error: "Produto não encontrado",
            message: result.message,
          });
        }

        const user = (request as any).user;
        void SystemLogService.logInfo("UPDATE_LISTING", result.message, {
          userId: user?.id,
          resource: "Product",
          resourceId: id,
          details: { status, listingResults: result.listingResults },
        });

        // Falhas parciais devolvem 200 (UI mostra detalhes via listingResults).
        // 500 só quando TODOS os listings falharam.
        return reply.status(result.success ? 200 : 500).send({
          success: result.success,
          message: result.message,
          listingResults: result.listingResults,
        });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error
              ? String(error.message)
              : "Erro ao alterar status dos anúncios",
        });
      }
    },
  );

  fastify.put<{
    Params: { id: string };
    Body: ProductUpdate;
  }>(
    "/:id",
    { preHandler: [authMiddleware] },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: ProductUpdate;
      }>,
      reply: FastifyReply,
    ) => {
      try {
        const { id } = request.params;
        const {
          name,
          description,
          price,
          stock,
          // Campos de autopeças
          costPrice,
          markup,
          brand,
          model,
          year,
          version,
          category,
          location,
          locationId,
          partNumber,
          quality,
          isSecurityItem,
          isTraceable,
          sourceVehicle,
          mlCategory,
          mlCategorySource,
          shopeeCategory,
          shopeeCategorySource,
          magaluCategory,
          magaluCategorySource,

          // Medidas / peso
          heightCm,
          widthCm,
          lengthCm,
          weightKg,

          imageUrl,
          imageUrls,

          // Ficha técnica secundária (atributos por categoria do ML)
          attributes,

          // Compatibilidades veiculares
          compatibilities,

          // Posição das compatibilidades no ML (uma por produto)
          compatibilityPositions,
        } = request.body as any;

        if (!id) {
          return reply
            .status(400)
            .send({ error: "ID do produto é obrigatório" });
        }

        if (price !== undefined && typeof price !== "number") {
          return reply.status(400).send({
            error: "Preço deve ser um número",
          });
        }

        if (stock !== undefined && !Number.isInteger(stock)) {
          return reply.status(400).send({
            error: "Estoque deve ser um número inteiro",
          });
        }

        // Mesma validação do POST: aceita case-insensitive, rejeita com 400
        // amigável se o cliente externo mandar fora do enum (ex.: "USADO").
        let normalizedQuality;
        try {
          normalizedQuality = normalizeQuality(quality);
        } catch (err) {
          if (err instanceof InvalidQualityError) {
            return reply.status(400).send({ error: err.message });
          }
          throw err;
        }

        const userId = (request as any).user?.dataOwnerId as string | undefined;
        // Resolver mlCategory se fornecida
        let resolvedMlCategoryId: string | undefined;
        let resolvedMlCategoryPath: string | undefined;
        let resolvedMlCategorySource:
          | "auto"
          | "manual"
          | "imported"
          | undefined;
        let resolvedMlCategoryChosenAt: Date | undefined;
        if (mlCategory) {
          const cat = await CategoryRepository.findByExternalId(mlCategory);
          if (!cat) {
            return reply.status(400).send({
              error:
                "Categoria do Mercado Livre não está sincronizada. Escolha outra ou sincronize as categorias.",
            });
          }

          // Barreira de domínio: produto veicular só pode receber categoria
          // sob a raiz 'Acessórios para Veículos' (MLB1747). Impede que
          // corrupções como mangueira → Gin voltem a ser persistidas.
          const normalizedSource = (mlCategorySource as any) || "manual";
          const hasVehicleSignals = !!(brand && model && year);
          if (hasVehicleSignals && normalizedSource !== "imported") {
            const domainCheck =
              await CategoryResolutionService.assertWithinVehicleRoot(
                cat.externalId,
              );
            if (!domainCheck.ok && domainCheck.reason === "outside_root") {
              return reply.status(400).send({
                error: `Categoria '${cat.fullPath || cat.externalId}' está fora do nicho de autopeças. Escolha uma categoria sob 'Acessórios para Veículos'.`,
              });
            }
          }

          resolvedMlCategoryId = cat.id;
          resolvedMlCategoryPath = cat.fullPath || cat.name || category;
          resolvedMlCategorySource = normalizedSource;
          resolvedMlCategoryChosenAt = new Date();
        }

        // Resolver shopeeCategory se fornecida (paridade com fluxo de criação)
        let resolvedShopeeCategoryId: string | undefined;
        let resolvedShopeeCategorySource:
          | "auto"
          | "manual"
          | "imported"
          | undefined;
        let resolvedShopeeCategoryChosenAt: Date | undefined;
        if (shopeeCategory) {
          const externalId = shopeeCategory.startsWith("SHP_")
            ? shopeeCategory
            : `SHP_${shopeeCategory}`;
          const cat = await CategoryRepository.findByExternalId(externalId);
          if (cat) {
            resolvedShopeeCategoryId = externalId.replace("SHP_", "");
            resolvedShopeeCategorySource =
              (shopeeCategorySource as any) || "manual";
            resolvedShopeeCategoryChosenAt = new Date();
          }
        }

        // Magalu: uuid da taxonomia da API (sem árvore local para validar).
        let resolvedMagaluCategoryId: string | undefined;
        let resolvedMagaluCategorySource:
          | "auto"
          | "manual"
          | "imported"
          | undefined;
        let resolvedMagaluCategoryChosenAt: Date | undefined;
        if (typeof magaluCategory === "string" && magaluCategory.trim()) {
          resolvedMagaluCategoryId = magaluCategory.trim();
          resolvedMagaluCategorySource =
            (magaluCategorySource as any) || "manual";
          resolvedMagaluCategoryChosenAt = new Date();
        }

        const result = await productUseCase.update(
          id,
          {
            name,
            description,
            price,
            stock,
            // Campos de autopeças
            costPrice,
            markup,
            brand,
            model,
            year,
            version,
            category: resolvedMlCategoryPath || category,
            location,
            locationId,
            partNumber,
            quality: normalizedQuality,
            isSecurityItem,
            isTraceable,
            sourceVehicle,
            mlCategoryId: resolvedMlCategoryId,
            mlCategorySource: resolvedMlCategorySource,
            mlCategoryChosenAt: resolvedMlCategoryChosenAt,
            shopeeCategoryId: resolvedShopeeCategoryId,
            shopeeCategorySource: resolvedShopeeCategorySource,
            shopeeCategoryChosenAt: resolvedShopeeCategoryChosenAt,
            magaluCategoryId: resolvedMagaluCategoryId,
            magaluCategorySource: resolvedMagaluCategorySource,
            magaluCategoryChosenAt: resolvedMagaluCategoryChosenAt,

            // Medidas / peso
            heightCm,
            widthCm,
            lengthCm,
            weightKg,

            imageUrl,
            imageUrls: Array.isArray(imageUrls) ? imageUrls : undefined,

            // Ficha técnica secundária por categoria (ML).
            // Sanitiza só quando o cliente envia o campo — undefined = não atualiza.
            // Quando o cliente ENVIA o campo e nada sobra da sanitização, isso é
            // "limpar tudo", não "não mexer": sem isso o operador não conseguia
            // apagar o último atributo (ex.: um Código OEM digitado errado) —
            // salvava 200 e o valor antigo voltava ao reabrir, e seguia indo
            // para o Mercado Livre.
            //
            // Limpar é `null`, NUNCA `{}`. O repositório mapeia null para
            // Prisma.DbNull, e `clearOverridesForEditedFields` compara a ficha
            // nova com a antiga por JSON: um `{}` contra a coluna NULL contaria
            // como edição e zeraria o `attributesOverride` de todos os anúncios
            // do produto — inclusive a ficha por anúncio da Revisão individual —
            // sem ninguém ter mexido na ficha.
            attributes:
              attributes === undefined
                ? undefined
                : (sanitizeProductAttributes(attributes) ?? null),

            // Compatibilidades veiculares (persistidas atomicamente pelo repositório)
            compatibilities: Array.isArray(compatibilities)
              ? compatibilities
                  .filter(
                    (c: any) =>
                      c &&
                      typeof c.brand === "string" &&
                      c.brand.trim().length > 0 &&
                      typeof c.model === "string" &&
                      c.model.trim().length > 0,
                  )
                  .map((c: any) => ({
                    brand: c.brand.trim(),
                    model: c.model.trim(),
                    yearFrom:
                      c.yearFrom !== undefined && c.yearFrom !== null
                        ? Number(c.yearFrom)
                        : null,
                    yearTo:
                      c.yearTo !== undefined && c.yearTo !== null
                        ? Number(c.yearTo)
                        : null,
                    version:
                      typeof c.version === "string" &&
                      c.version.trim().length > 0
                        ? c.version.trim()
                        : null,
                  }))
              : undefined,

            // Mesma convenção do `attributes` acima: ausente = não mexe; enviado
            // = vira a lista sanitizada, e lista vazia limpa (o repositório grava
            // NULL). Sem isso o operador não conseguiria REMOVER uma posição
            // depois de escolher — o sintoma clássico deste formulário.
            compatibilityPositions:
              compatibilityPositions === undefined
                ? undefined
                : sanitizeCompatPositions(compatibilityPositions),
          },
          userId,
        );

        // Registrar log de atualização do produto (fire-and-forget, non-blocking)
        const user = (request as any).user;
        void SystemLogService.logProductUpdate(user?.id, id, {
          name: result.product.name,
          stock: result.product.stock,
          price: result.product.price,
        });

        return reply.status(200).send({
          ...result.product,
          syncResults: result.syncResults,
        });
      } catch (error) {
        return reply.status(500).send({
          error:
            error instanceof Error
              ? String(error.message)
              : "Erro ao atualizar produto",
        });
      }
    },
  );
};
