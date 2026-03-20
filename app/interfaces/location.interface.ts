export interface Location {
  id: string;
  userId: string;
  code: string;
  description?: string;
  maxCapacity: number;
  parentId?: string;
  createdAt: Date;
  updatedAt: Date;
  parent?: Location;
  children?: Location[];
  productsCount?: number;
}

export interface LocationCreate {
  userId: string;
  code: string;
  description?: string;
  maxCapacity: number;
  parentId?: string;
}

export interface LocationUpdate {
  code?: string;
  description?: string;
  maxCapacity?: number;
  parentId?: string | null;
}

export interface LocationWithOccupancy extends Location {
  occupancy: number; // porcentagem de ocupação (0-100)
  productsCount: number;
  childrenCount: number;
}

export interface LocationRepository {
  create(data: LocationCreate): Promise<Location>;
  findById(id: string, userId?: string): Promise<Location | null>;
  findAll(
    options?: {
      search?: string;
      parentId?: string | null;
      page?: number;
      limit?: number;
    },
    userId?: string,
  ): Promise<{ locations: Location[]; total: number }>;
  findByCode(code: string, userId: string): Promise<Location | null>;
  update(id: string, data: LocationUpdate, userId?: string): Promise<Location>;
  delete(id: string, userId?: string): Promise<void>;
  getChildrenCount(id: string): Promise<number>;
  getProductsCount(id: string): Promise<number>;
  getDescendantProductsCount(id: string): Promise<number>;
  getProductsByLocationId(
    locationId: string,
    userId: string,
    options?: { search?: string; page?: number; limit?: number },
  ): Promise<{
    products: Array<{
      id: string;
      sku: string;
      name: string;
      imageUrl?: string;
      stock: number;
      price: number;
      location?: string;
    }>;
    total: number;
  }>;
  moveProducts(
    productIds: string[],
    targetLocationId: string | null,
    userId: string,
    locationText?: string | null,
  ): Promise<number>;
}
