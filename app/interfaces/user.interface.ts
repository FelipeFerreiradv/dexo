import { Role } from "@prisma/client";

export interface User {
  id: string;
  email: string;
  password: string;
  role: Role;
  parentUserId?: string | null;
  name?: string | null;
  avatarUrl?: string | null;
  defaultProductDescription?: string | null;
  defaultCostPrice?: number | null;
  defaultStock?: number | null;

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

  // Aumento percentual escalonado entre contas ML (default 0 = desativado)
  crossAccountPriceIncreasePercent?: number | null;

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
  parentUserId?: string | null;
}

export interface UserUpdate {
  name?: string | null;
  password?: string;
  avatarUrl?: string | null;
  defaultProductDescription?: string | null;
  defaultCostPrice?: number | null;
  defaultStock?: number | null;

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

  // Aumento percentual escalonado entre contas ML (default 0 = desativado)
  crossAccountPriceIncreasePercent?: number | null;

  role?: Role;
}

export interface UserRepository {
  create(data: UserCreate): Promise<User>;
  findByEmail(email: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
  findChildren(parentUserId: string): Promise<User[]>;
  update(id: string, data: UserUpdate): Promise<User>;
  getLastSkuSequential(id: string): Promise<number | null>;
  bumpLastSkuSequential(id: string, candidate: number): Promise<void>;
  reserveNextSkuSequential(id: string): Promise<number>;
}
