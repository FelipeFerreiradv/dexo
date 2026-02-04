// Tipos genéricos para marketplaces
export enum MarketplacePlatform {
  MERCADO_LIVRE = "MERCADO_LIVRE",
  SHOPEE = "SHOPEE",
}

export enum MarketplaceAccountStatus {
  ACTIVE = "ACTIVE",
  INACTIVE = "INACTIVE",
  ERROR = "ERROR",
}

export interface MarketplaceAccount {
  id: string;
  userId: string;
  platform: MarketplacePlatform;
  accountName: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  externalUserId?: string;
  status: MarketplaceAccountStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateMarketplaceAccountData {
  userId: string;
  platform: MarketplacePlatform;
  accountName: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  externalUserId?: string;
}

export interface UpdateMarketplaceAccountData {
  accountName?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: Date;
  status?: MarketplaceAccountStatus;
  externalUserId?: string;
}
