/**
 * Interfaces para o domínio de Pedidos (Orders)
 * Segue o schema Prisma: Order, OrderItem, OrderStatus
 */

// Enum de status do pedido (espelha Prisma)
export type OrderStatus =
  | "PENDING"
  | "PAID"
  | "SHIPPED"
  | "DELIVERED"
  | "CANCELLED";

// Interface do item de pedido
export interface OrderItem {
  id: string;
  orderId: string;
  productId: string;
  listingId?: string | null;
  quantity: number;
  unitPrice: number;
  // Dados do produto (para exibição)
  product?: {
    id: string;
    name: string;
    sku: string;
    stock: number;
  };
  listing?: {
    id: string;
    externalListingId: string;
    permalink?: string | null;
  };
}

// Interface principal do pedido
export interface Order {
  id: string;
  marketplaceAccountId: string;
  externalOrderId: string;
  status: OrderStatus;
  totalAmount: number;
  customerName?: string | null;
  customerEmail?: string | null;
  createdAt: Date;
  updatedAt: Date;
  // Relações
  items?: OrderItem[];
  marketplaceAccount?: {
    id: string;
    platform: string;
    accountName: string;
  };
}

// Interface para criar pedido
export interface OrderCreate {
  marketplaceAccountId: string;
  externalOrderId: string;
  status?: OrderStatus;
  totalAmount: number;
  customerName?: string;
  customerEmail?: string;
  items: OrderItemCreate[];
}

// Interface para criar item de pedido
export interface OrderItemCreate {
  productId: string;
  listingId?: string | null;
  quantity: number;
  unitPrice: number;
}

// Interface para atualizar pedido
export interface OrderUpdate {
  status?: OrderStatus;
  customerName?: string;
  customerEmail?: string;
}

// Opções para buscar pedidos
export interface OrderFindOptions {
  marketplaceAccountId?: string;
  userId?: string;
  status?: OrderStatus;
  search?: string;
  page?: number;
  limit?: number;
  dateFrom?: Date;
  dateTo?: Date;
}

// Resultado paginado
export interface OrderFindResult {
  orders: Order[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// Interface do repositório de pedidos
export interface OrderRepository {
  // Criar pedido com itens
  create(data: OrderCreate): Promise<Order>;

  // Buscar por ID
  findById(id: string): Promise<Order | null>;

  // Buscar por ID externo (ML order ID)
  findByExternalOrderId(externalOrderId: string): Promise<Order | null>;

  // Listar pedidos com filtros
  findAll(options?: OrderFindOptions): Promise<OrderFindResult>;

  // Listar pedidos de uma conta de marketplace
  findByMarketplaceAccount(marketplaceAccountId: string): Promise<Order[]>;

  // Atualizar status do pedido
  update(id: string, data: OrderUpdate): Promise<Order>;

  // Contar pedidos
  count(marketplaceAccountId?: string): Promise<number>;

  // Verificar se pedido já existe (por externalOrderId)
  exists(externalOrderId: string): Promise<boolean>;
}
