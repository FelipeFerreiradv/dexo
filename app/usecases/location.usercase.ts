import {
  Location,
  LocationCreate,
  LocationUpdate,
  LocationWithOccupancy,
} from "../interfaces/location.interface";
import { LocationRepositoryPrisma } from "../repositories/location.repository";

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

      // Build full path for the text field
      const buildPath = async (loc: Location): Promise<string> => {
        if (loc.parentId) {
          const parent = await this.locationRepository.findById(
            loc.parentId,
            userId,
          );
          if (parent) return `${await buildPath(parent)} > ${loc.code}`;
        }
        return loc.code;
      };
      const fullPath = await buildPath(target);

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
    // Get all locations for this user
    const allLocations = await this.locationRepository.findAll(
      { limit: 1000 },
      userId,
    );

    const result: Array<{
      id: string;
      code: string;
      description?: string;
      fullPath: string;
      maxCapacity: number;
      productsCount: number;
      isFull: boolean;
    }> = [];

    // Build a map for path resolution
    const locMap = new Map<string, Location>();
    // Flatten all locations (roots + children)
    const flattenAll = (locations: Location[]) => {
      for (const loc of locations) {
        locMap.set(loc.id, loc);
        if (loc.children) flattenAll(loc.children);
      }
    };
    flattenAll(allLocations.locations);

    // Build full path for each location
    const buildPath = (loc: Location): string => {
      if (loc.parentId && locMap.has(loc.parentId)) {
        return `${buildPath(locMap.get(loc.parentId)!)} > ${loc.code}`;
      }
      return loc.code;
    };

    for (const [, loc] of locMap) {
      const productsCount = loc.productsCount ?? 0;
      result.push({
        id: loc.id,
        code: loc.code,
        description: loc.description,
        fullPath: buildPath(loc),
        maxCapacity: loc.maxCapacity,
        productsCount,
        isFull: loc.maxCapacity > 0 && productsCount >= loc.maxCapacity,
      });
    }

    // Sort by fullPath for a nice hierarchy
    result.sort((a, b) => a.fullPath.localeCompare(b.fullPath));

    return result;
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
