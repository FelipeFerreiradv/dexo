import { Role } from "@prisma/client";

export interface User {
  id: string;
  email: string;
  password: string;
  role: Role;
  name?: string | null;
  avatarUrl?: string | null;
  defaultProductDescription?: string | null;
  defaultCostPrice?: number | null;

  // Padrões de anúncio ML
  defaultListingType?: string | null;
  defaultHasWarranty?: boolean | null;
  defaultWarrantyUnit?: string | null;
  defaultWarrantyDuration?: number | null;
  defaultItemCondition?: string | null;
  defaultShippingMode?: string | null;
  defaultFreeShipping?: boolean | null;
  defaultLocalPickup?: boolean | null;
  defaultManufacturingTime?: number | null;

  createdAt: Date;
  updatedAt: Date;
}

export interface UserCreate {
  email: string;
  name?: string | null;
  password: string;
  avatarUrl?: string | null;
  defaultProductDescription?: string | null;
  defaultCostPrice?: number | null;
  role?: Role;
}

export interface UserUpdate {
  name?: string | null;
  password?: string;
  avatarUrl?: string | null;
  defaultProductDescription?: string | null;
  defaultCostPrice?: number | null;

  // Padrões de anúncio ML
  defaultListingType?: string | null;
  defaultHasWarranty?: boolean | null;
  defaultWarrantyUnit?: string | null;
  defaultWarrantyDuration?: number | null;
  defaultItemCondition?: string | null;
  defaultShippingMode?: string | null;
  defaultFreeShipping?: boolean | null;
  defaultLocalPickup?: boolean | null;
  defaultManufacturingTime?: number | null;

  role?: Role;
}

export interface UserRepository {
  create(data: UserCreate): Promise<User>;
  findByEmail(email: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
  update(id: string, data: UserUpdate): Promise<User>;
}
