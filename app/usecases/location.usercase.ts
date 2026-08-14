import {
  AttachProductsResult,
  CapacityExceededDetail,
  Location,
  LocationCreate,
  LocationFlat,
  LocationUpdate,
  LocationWithOccupancy,
} from "../interfaces/location.interface";
import prisma from "../lib/prisma";
import { LocationRepositoryPrisma } from "../repositories/location.repository";

export class CapacityExceededError extends Error {
  detail: CapacityExceededDetail;
  constructor(message: string, detail: CapacityExceededDetail) {
    super(message);
    this.name = "CapacityExceededError";
    this.detail = detail;
  }
}

export class LocationUseCase {
  private locationRepository: LocationRepositoryPrisma;

  constructor() {
    this.locationRepository = new LocationRepositoryPrisma();
  }

  async create(data: LocationCreate): Promise<Location> {
    if (!data.userId) throw new Error("Usuário não encontrado");
    if (!data.code || typeof data.code !== "string") {
      throw new Error("Sigla é obrigatória");
    }
    if (data.maxCapacity < 0) {
      throw new Error("Capacidade máxima não pode ser negativa");
    }

    // Check for duplicate code within same user
    const existing = await this.locationRepository.findByCode(
      data.code,
      data.userId,
    );
    if (existing) {
      throw new Error(`Já existe uma localização com a sigla "${data.code}"`);
    }

    // Validate parent exists and belongs to user
    if (data.parentId) {
      const parent = await this.locationRepository.findById(
        data.parentId,
        data.userId,
      );
      if (!parent) {
        throw new Error("Localização pai não encontrada");
      }
    }

    return this.locationRepository.create(data);
  }

  /**
   * Variante ENXUTA de `create` para fluxos em LOTE (importação de dados
   * legados): MESMAS validações e mesmo efeito, com projeções mínimas.
   * O `create` original valida o pai via `findById`, que carrega o pai com
   * TODOS os filhos (+_count) — numa árvore importada pais-antes-de-filhos
   * isso vira O(n²) de egress (cada filho refaz o fetch do pai com os
   * irmãos já criados). Regra de egress enxuto (keen-lederberg): projeção
   * mínima. Aditivo — `create` e todos os chamadores atuais intocados.
   */
  async createLean(
    data: LocationCreate,
  ): Promise<{ id: string; code: string }> {
    if (!data.userId) throw new Error("Usuário não encontrado");
    if (!data.code || typeof data.code !== "string") {
      throw new Error("Sigla é obrigatória");
    }
    if (data.maxCapacity < 0) {
      throw new Error("Capacidade máxima não pode ser negativa");
    }
    const existing = await prisma.location.findFirst({
      where: { code: data.code, userId: data.userId },
      select: { id: true },
    });
    if (existing) {
      throw new Error(`Já existe uma localização com a sigla "${data.code}"`);
    }
    if (data.parentId) {
      const parent = await prisma.location.findFirst({
        where: { id: data.parentId, userId: data.userId },
        select: { id: true },
      });
      if (!parent) {
        throw new Error("Localização pai não encontrada");
      }
    }
    return prisma.location.create({
      data: {
        userId: data.userId,
        code: data.code,
        description: data.description ?? null,
        maxCapacity: data.maxCapacity,
        parentId: data.parentId ?? null,
      },
      select: { id: true, code: true },
    });
  }

  /**
   * Criação EM LOTE a partir de faixas já expandidas e normalizadas
   * (`app/localizacoes/lib/bulk-locations.ts`). Aditivo: `create`, `createLean`
   * e o executor de importação seguem intocados.
   *
   * São 3 queries independentemente de N (um loop de `createLean` faria até 3
   * por item): pais em uma consulta, códigos existentes em outra e um único
   * `createManyAndReturn`. O `skipDuplicates` traduz para `ON CONFLICT DO
   * NOTHING`, então o `@@unique([userId, code])` resolve sozinho a corrida que
   * o pré-check não cobre — sem isso, um P2002 viraria 500 (o domínio de
   * Location não trata esse código em lugar nenhum).
   *
   * Sem `$transaction`: a regra do módulo é não colocar trabalho pesado em
   * transação, e o INSERT com ON CONFLICT já é atômico. Em contrapartida ele é
   * tudo-ou-nada: se o INSERT falhar (ex.: pai removido entre a validação e a
   * escrita), nada é criado e o erro sobe — preferível a um lote pela metade.
   */
  async createBulk(input: {
    userId: string;
    items: Array<{
      code: string;
      parentId?: string | null;
      maxCapacity?: number;
      description?: string | null;
    }>;
  }): Promise<{
    created: Array<{ id: string; code: string }>;
    skipped: Array<{ code: string; reason: "ja_existe" | "duplicada_no_lote" }>;
    failed: Array<{ code: string; error: string }>;
  }> {
    if (!input.userId) throw new Error("Usuário não encontrado");

    const created: Array<{ id: string; code: string }> = [];
    const skipped: Array<{
      code: string;
      reason: "ja_existe" | "duplicada_no_lote";
    }> = [];
    const failed: Array<{ code: string; error: string }> = [];

    // 1) Deduplica dentro do próprio lote (mantém a primeira ocorrência).
    const seen = new Set<string>();
    const unique: typeof input.items = [];
    for (const item of input.items) {
      if (seen.has(item.code)) {
        skipped.push({ code: item.code, reason: "duplicada_no_lote" });
        continue;
      }
      seen.add(item.code);
      unique.push(item);
    }
    if (unique.length === 0) return { created, skipped, failed };

    // 2) Valida os pais do tenant numa consulta só (mesma semântica de erro do
    //    `createLean`; pai de outro tenant simplesmente não aparece aqui).
    const parentIds = Array.from(
      new Set(
        unique
          .map((i) => i.parentId)
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      ),
    );
    let validParents = new Set<string>();
    if (parentIds.length > 0) {
      const parents = await prisma.location.findMany({
        where: { userId: input.userId, id: { in: parentIds } },
        select: { id: true },
      });
      validParents = new Set(parents.map((p) => p.id));
    }

    // `|| null` normaliza string vazia para raiz (o `??` a preservaria e o
    // banco receberia uma FK vazia, derrubando o lote inteiro).
    const withParentOk = unique.map((item) => ({
      ...item,
      parentId: item.parentId || null,
    })).filter((item) => {
      if (item.parentId && !validParents.has(item.parentId)) {
        failed.push({ code: item.code, error: "Localização pai não encontrada" });
        return false;
      }
      return true;
    });
    if (withParentOk.length === 0) return { created, skipped, failed };

    // 3) Pré-checa os códigos já usados pelo tenant.
    const existing = await prisma.location.findMany({
      where: {
        userId: input.userId,
        code: { in: withParentOk.map((i) => i.code) },
      },
      select: { code: true },
    });
    const existingCodes = new Set(existing.map((e) => e.code));
    const toCreate = withParentOk.filter((item) => {
      if (existingCodes.has(item.code)) {
        skipped.push({ code: item.code, reason: "ja_existe" });
        return false;
      }
      return true;
    });
    if (toCreate.length === 0) return { created, skipped, failed };

    // 4) Um único INSERT. O RETURNING diz exatamente o que entrou; o que foi
    //    pedido e não voltou perdeu a corrida para outra sessão.
    const inserted = await prisma.location.createManyAndReturn({
      data: toCreate.map((item) => ({
        userId: input.userId,
        code: item.code,
        description: item.description ?? null,
        maxCapacity: item.maxCapacity ?? 0,
        parentId: item.parentId || null,
      })),
      skipDuplicates: true,
      select: { id: true, code: true },
    });
    created.push(...inserted);

    const insertedCodes = new Set(inserted.map((i) => i.code));
    for (const item of toCreate) {
      if (!insertedCodes.has(item.code)) {
        skipped.push({ code: item.code, reason: "ja_existe" });
      }
    }

    return { created, skipped, failed };
  }

  async findById(
    id: string,
    userId?: string,
  ): Promise<LocationWithOccupancy | null> {
    const location = await this.locationRepository.findById(id, userId);
    if (!location) return null;
    return this.enrichWithOccupancy(location);
  }

  async listLocations(options: {
    search?: string;
    parentId?: string | null;
    page?: number;
    limit?: number;
    userId: string;
  }): Promise<{
    locations: LocationWithOccupancy[];
    total: number;
    totalPages: number;
  }> {
    const { userId, ...rest } = options;
    const data = await this.locationRepository.findAll(rest, userId);

    const enriched = await Promise.all(
      data.locations.map((loc) => this.enrichWithOccupancy(loc)),
    );

    return {
      locations: enriched,
      total: data.total,
      totalPages: Math.ceil(data.total / (options?.limit || 50)),
    };
  }

  /**
   * Lista TODAS as localizações do usuário (qualquer profundidade) achatadas,
   * já enriquecidas com `occupancy`/`childrenCount`. O cliente monta a árvore
   * por `parentId`. `childrenCount` vem do `_count` (via `findAllFlat`), NÃO de
   * `children.length` — por isso não reaproveita `enrichWithOccupancy`.
   */
  async listAllFlat(
    userId: string,
  ): Promise<{ locations: LocationWithOccupancy[]; total: number }> {
    const rows: LocationFlat[] =
      await this.locationRepository.findAllFlat(userId);

    const locations: LocationWithOccupancy[] = rows.map((loc) => {
      const productsCount = loc.productsCount ?? 0;
      const childrenCount = loc.childrenCount ?? 0;
      const occupancy =
        loc.maxCapacity > 0
          ? Math.min(100, Math.round((productsCount / loc.maxCapacity) * 100))
          : 0;
      return { ...loc, productsCount, childrenCount, occupancy };
    });

    return { locations, total: locations.length };
  }

  async update(
    id: string,
    data: LocationUpdate,
    userId?: string,
  ): Promise<LocationWithOccupancy> {
    const existing = await this.locationRepository.findById(id, userId);
    if (!existing) throw new Error("Localização não encontrada");

    // If updating code, check for duplicates
    if (data.code && data.code !== existing.code && userId) {
      const duplicate = await this.locationRepository.findByCode(
        data.code,
        userId,
      );
      if (duplicate && duplicate.id !== id) {
        throw new Error(`Já existe uma localização com a sigla "${data.code}"`);
      }
    }

    // If changing parentId, validate no circular reference
    if (data.parentId !== undefined) {
      if (data.parentId === id) {
        throw new Error("Uma localização não pode ser pai de si mesma");
      }
      if (data.parentId !== null) {
        // Validate parent exists and belongs to user
        const parent = await this.locationRepository.findById(
          data.parentId,
          userId,
        );
        if (!parent) {
          throw new Error("Localização pai não encontrada");
        }
        // Check for circular reference: walk up from parent to root
        let current = parent;
        while (current.parentId) {
          if (current.parentId === id) {
            throw new Error(
              "Mover para este local criaria uma referência circular",
            );
          }
          const next = await this.locationRepository.findById(
            current.parentId,
            userId,
          );
          if (!next) break;
          current = next;
        }
      }
    }

    // If reducing maxCapacity, validate it won't be below current usage
    if (data.maxCapacity !== undefined && data.maxCapacity > 0) {
      const currentProducts = existing.productsCount ?? 0;
      if (data.maxCapacity < currentProducts) {
        throw new Error(
          `Capacidade não pode ser menor que a ocupação atual (${currentProducts} produtos)`,
        );
      }
    }

    const updated = await this.locationRepository.update(id, data, userId);
    return this.enrichWithOccupancy(updated);
  }

  async delete(id: string, userId?: string): Promise<void> {
    const existing = await this.locationRepository.findById(id, userId);
    if (!existing) throw new Error("Localização não encontrada");

    await this.locationRepository.delete(id, userId);
  }

  async getLocationProducts(
    locationId: string,
    userId: string,
    options?: { search?: string; page?: number; limit?: number },
  ) {
    const existing = await this.locationRepository.findById(locationId, userId);
    if (!existing) throw new Error("Localização não encontrada");

    return this.locationRepository.getProductsByLocationId(
      locationId,
      userId,
      options,
    );
  }

  async moveProducts(
    productIds: string[],
    targetLocationId: string | null,
    userId: string,
  ): Promise<{ count: number; targetLocation?: string }> {
    if (!productIds.length) throw new Error("Nenhum produto selecionado");

    // If moving to a location, validate it exists and check capacity
    if (targetLocationId) {
      const target = await this.locationRepository.findById(
        targetLocationId,
        userId,
      );
      if (!target) throw new Error("Localização de destino não encontrada");

      if (target.maxCapacity > 0) {
        const currentCount = target.productsCount ?? 0;
        const newTotal = currentCount + productIds.length;
        if (newTotal > target.maxCapacity) {
          throw new Error(
            `Localização "${target.code}" não tem capacidade suficiente (${currentCount}/${target.maxCapacity}, tentando adicionar ${productIds.length})`,
          );
        }
      }

      const fullPath = await this.buildFullPath(target, userId);

      const count = await this.locationRepository.moveProducts(
        productIds,
        targetLocationId,
        userId,
        fullPath,
      );
      return { count, targetLocation: target.code };
    }

    // Unbinding (set to null)
    const count = await this.locationRepository.moveProducts(
      productIds,
      null,
      userId,
      null,
    );
    return { count };
  }

  /**
   * Returns a flat list of all locations for dropdown/select use.
   * Includes full path for readability.
   */
  async listForSelect(userId: string): Promise<
    Array<{
      id: string;
      code: string;
      description?: string;
      fullPath: string;
      maxCapacity: number;
      productsCount: number;
      isFull: boolean;
    }>
  > {
    // Carrega TODAS as localizações do usuário (qualquer profundidade) de uma
    // vez. `findAllFlat` traz parentId/code/description/maxCapacity e
    // productsCount (via _count.products) — diferente de `findAll`, que sem
    // parentId/search devolve só raízes + 1 nível e por isso truncava o caminho
    // e omitia as folhas profundas.
    const flat = await this.locationRepository.findAllFlat(userId);

    const locMap = new Map<string, Location>(flat.map((loc) => [loc.id, loc]));

    // Monta o caminho completo subindo a cadeia de parentId até a raiz.
    // Iterativo + guard anti-ciclo para nunca estourar a pilha em dados
    // eventualmente corrompidos. Separador " > " (igual ao detalhe do produto).
    const buildPath = (start: Location): string => {
      const parts: string[] = [];
      let cur: Location | undefined = start;
      let guard = 0;
      while (cur && guard++ < 50) {
        parts.unshift(cur.code);
        cur = cur.parentId ? locMap.get(cur.parentId) : undefined;
      }
      return parts.join(" > ");
    };

    const result = flat.map((loc) => {
      const productsCount = loc.productsCount ?? 0;
      return {
        id: loc.id,
        code: loc.code,
        description: loc.description,
        fullPath: buildPath(loc),
        maxCapacity: loc.maxCapacity,
        productsCount,
        isFull: loc.maxCapacity > 0 && productsCount >= loc.maxCapacity,
      };
    });

    // Sort by fullPath for a nice hierarchy
    result.sort((a, b) => a.fullPath.localeCompare(b.fullPath));

    return result;
  }

  /**
   * Constrói o fullPath textual da localização (ex: "A > B > C").
   * Usado para sincronizar o campo legado `Product.location` quando
   * produtos são movidos/vinculados.
   */
  private async buildFullPath(
    loc: Location,
    userId: string,
  ): Promise<string> {
    if (loc.parentId) {
      const parent = await this.locationRepository.findById(
        loc.parentId,
        userId,
      );
      if (parent) {
        return `${await this.buildFullPath(parent, userId)} > ${loc.code}`;
      }
    }
    return loc.code;
  }

  /**
   * Versão enxuta de `buildFullPath` para o fluxo de scan: sobe a cadeia de
   * pais lendo só `{ code, parentId }` por nível — em vez do `findById` pesado
   * (que traz `parent` + todos os `children` com `_count`). Reduz egress no
   * attach, que é chamado a cada produto escaneado. Roda FORA de qualquer
   * transação. Retorna `null` quando a própria localização não existe ou não é
   * do tenant (dobra como checagem de existência). Guard anti-ciclo (< 50)
   * igual ao de `listForSelect`. Escopado por `userId` em todos os níveis
   * (nunca sobe para o pai de outro tenant).
   */
  private async buildFullPathLean(
    locationId: string,
    userId: string,
  ): Promise<string | null> {
    const parts: string[] = [];
    let currentId: string | null = locationId;
    let guard = 0;
    while (currentId && guard++ < 50) {
      const node: { code: string; parentId: string | null } | null =
        await prisma.location.findFirst({
          where: { id: currentId, userId },
          select: { code: true, parentId: true },
        });
      if (!node) break;
      parts.unshift(node.code);
      currentId = node.parentId;
    }
    return parts.length > 0 ? parts.join(" > ") : null;
  }

  /**
   * Garante que cabe MAIS UMA peça na localização, ou lança
   * `CapacityExceededError`. É a versão de uma peça só do check que
   * `attachProducts` já fazia — existe porque criar/editar produto pela tela
   * gravava `locationId` sem passar por nenhuma validação de capacidade
   * (issue #273), deixando o bloqueio "Lotado" do combobox como única trava,
   * e ela é client-side.
   *
   * Regras deliberadas:
   * - `maxCapacity === 0` significa SEM limite → nunca bloqueia.
   * - Localização inexistente ou de outro tenant → não é problema deste
   *   método; segue em silêncio e deixa a FK/rota decidir (não vaza
   *   existência de dado alheio).
   * - `movingProductId` (edição) faz DUAS coisas, e as duas importam:
   *   1. se a peça JÁ está nesta localização, não houve movimento — retorna
   *      sem validar. Sem isso, reeditar qualquer peça de uma localização que
   *      hoje está ACIMA do limite seria rejeitado, deixando presas justamente
   *      as peças que precisam ser corrigidas;
   *   2. tira a própria peça da contagem, para ela não disputar vaga consigo
   *      mesma.
   *
   * Leituras enxutas de propósito (`select` explícito, `count` no banco), na
   * linha das regras de egress da entrega de Segurança e Otimização.
   */
  async assertHasRoomForOne(
    locationId: string,
    userId: string,
    movingProductId?: string,
  ): Promise<void> {
    if (movingProductId) {
      const atual = await prisma.product.findFirst({
        where: { id: movingProductId, userId },
        select: { locationId: true },
      });
      // Já está aqui: não é entrada nova, nada a validar.
      if (atual?.locationId === locationId) return;
    }

    const location = await prisma.location.findFirst({
      where: { id: locationId, userId },
      select: { code: true, maxCapacity: true },
    });
    // Sem limite definido, ou localização que não é deste tenant: nada a fazer.
    if (!location || location.maxCapacity <= 0) return;

    const currentCount = await prisma.product.count({
      where: {
        locationId,
        ...(movingProductId ? { id: { not: movingProductId } } : {}),
      },
    });
    if (currentCount + 1 <= location.maxCapacity) return;

    throw new CapacityExceededError(
      `Localização "${location.code}" está lotada (${currentCount}/${location.maxCapacity})`,
      {
        currentCount,
        maxCapacity: location.maxCapacity,
        attempting: 1,
        wouldExceedBy: currentCount + 1 - location.maxCapacity,
        acceptedIds: [],
        excededIds: movingProductId ? [movingProductId] : [],
      },
    );
  }

  /**
   * Vincula produtos a uma localização via batch. Aborta o batch inteiro
   * com `CapacityExceededError` se exceder `maxCapacity`.
   *
   * - Produtos já vinculados à localização retornam em `alreadyAttached`
   *   (idempotente).
   * - Produtos de outro tenant retornam silenciosamente em `skipped` com
   *   reason `not_found` (não vaza existência).
   * - Usa `prisma.$transaction` para reduzir a janela de race condition
   *   no check de capacidade (consistente com o padrão do codebase).
   */
  async attachProducts(
    locationId: string,
    productIds: string[],
    userId: string,
  ): Promise<AttachProductsResult> {
    if (!productIds.length) throw new Error("Nenhum produto selecionado");
    if (productIds.length > 200) {
      throw new Error("Limite de 200 produtos por batch");
    }

    const uniqueIds = Array.from(new Set(productIds));

    // fullPath é derivado de hierarquia imutável e antes era montado DENTRO da
    // `$transaction` — o walk de ancestrais segurava a conexão aberta e
    // estourava o timeout padrão de 5s. Calculamos ANTES de abrir a transação,
    // deixando a tx trivial (1 read + 1 updateMany). `buildFullPathLean` sobe a
    // cadeia lendo só { code, parentId } por nível (regra de egress enxuto, em
    // vez do findById que traz parent + todos os filhos + counts) e já valida a
    // existência no tenant. O `{ timeout, maxWait }` é só rede de segurança para
    // contenção do pool (connection_limit=15).
    const fullPath = await this.buildFullPathLean(locationId, userId);
    if (fullPath === null) throw new Error("Localização não encontrada");

    return prisma.$transaction(
      async (tx) => {
        const location = await tx.location.findFirst({
          where: { id: locationId, userId },
          include: { _count: { select: { products: true } } },
        });
        if (!location) throw new Error("Localização não encontrada");

        const currentCount = location._count?.products ?? 0;

        const found = await tx.product.findMany({
          where: { id: { in: uniqueIds }, userId },
          select: { id: true, sku: true, name: true, locationId: true },
        });

        const foundMap = new Map(found.map((p) => [p.id, p]));
        const skipped = uniqueIds
          .filter((id) => !foundMap.has(id))
          .map((id) => ({ productId: id, reason: "not_found" as const }));

        const alreadyAttached = found
          .filter((p) => p.locationId === locationId)
          .map((p) => ({ id: p.id, sku: p.sku, name: p.name }));

        const toAttachFull = found.filter((p) => p.locationId !== locationId);

        if (location.maxCapacity > 0) {
          const newTotal = currentCount + toAttachFull.length;
          if (newTotal > location.maxCapacity) {
            const acceptedIds: string[] = [];
            const excededIds: string[] = [];
            let slots = location.maxCapacity - currentCount;
            for (const p of toAttachFull) {
              if (slots > 0) {
                acceptedIds.push(p.id);
                slots--;
              } else {
                excededIds.push(p.id);
              }
            }
            throw new CapacityExceededError(
              `Localização "${location.code}" não tem capacidade suficiente (${currentCount}/${location.maxCapacity}, tentando adicionar ${toAttachFull.length})`,
              {
                currentCount,
                maxCapacity: location.maxCapacity,
                attempting: toAttachFull.length,
                wouldExceedBy: newTotal - location.maxCapacity,
                acceptedIds,
                excededIds,
              },
            );
          }
        }

        let attached: { id: string; sku: string; name: string }[] = [];
        let newProductsCount = currentCount;

        if (toAttachFull.length > 0) {
          const toAttachIds = toAttachFull.map((p) => p.id);
          await tx.product.updateMany({
            where: { id: { in: toAttachIds }, userId },
            data: { locationId, location: fullPath },
          });
          attached = toAttachFull.map((p) => ({
            id: p.id,
            sku: p.sku,
            name: p.name,
          }));
          newProductsCount = currentCount + toAttachFull.length;
        }

        return {
          attached,
          alreadyAttached,
          skipped,
          location: {
            id: location.id,
            code: location.code,
            productsCount: newProductsCount,
            maxCapacity: location.maxCapacity,
          },
        };
      },
      { timeout: 20_000, maxWait: 10_000 },
    );
  }

  private async enrichWithOccupancy(
    location: Location,
  ): Promise<LocationWithOccupancy> {
    const productsCount = location.productsCount ?? 0;
    const childrenCount = location.children?.length ?? 0;
    const occupancy =
      location.maxCapacity > 0
        ? Math.min(
            100,
            Math.round((productsCount / location.maxCapacity) * 100),
          )
        : 0;

    // Also enrich children if present
    const enrichedChildren = location.children
      ? await Promise.all(
          location.children.map((child) => this.enrichWithOccupancy(child)),
        )
      : undefined;

    return {
      ...location,
      children: enrichedChildren,
      productsCount,
      childrenCount,
      occupancy,
    };
  }
}
