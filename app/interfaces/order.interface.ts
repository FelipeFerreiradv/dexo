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
    imageUrl?: string | null;
    location?: string | null;
    productLocation?: {
      id: string;
      code: string;
      description?: string | null;
    } | null;
    // Fallback do "Ver anúncio" quando o item não tem listing vinculado:
    // o sheet resolve o anúncio preferido do produto.
    listings?: {
      id: string;
      externalListingId: string;
      permalink?: string | null;
      status?: string | null;
      platform?: string | null;
    }[];
  };
  listing?: {
    id: string;
    externalListingId: string;
    permalink?: string | null;
    // status + plataforma da conta → permitem o detalhe do pedido resolver o
    // link "Ver anúncio" pelo mesmo resolvedor do modal (URL correta/gating).
    status?: string | null;
    platform?: string | null;
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
  // Cliente do CRM vinculado (auto-cadastro best-effort no import; nulo nos
  // pedidos anteriores à feature).
  customerId?: string | null;
  createdAt: Date;
  updatedAt: Date;
  // Relações
  items?: OrderItem[];
  marketplaceAccount?: {
    id: string;
    platform: string;
    accountName: string;
  };
  // Resumo leve do 1º item para a vitrine de Pedidos (egress enxuto): a lista
  // NÃO traz `items`; só esta miniatura + a contagem. Preenchido por
  // `findAllForList`; ausente nas demais leituras (continua `undefined`).
  thumbnail?: {
    imageUrl: string | null;
    name: string;
    sku: string;
    location: string | null;
  };
  itemCount?: number;
}

// Interface para criar pedido
export interface OrderCreate {
  marketplaceAccountId: string;
  externalOrderId: string;
  status?: OrderStatus;
  totalAmount: number;
  customerName?: string;
  customerEmail?: string;
  /**
   * Data da venda no marketplace. Sem isto, `createdAt` (hora do import) era a
   * unica data do pedido — e e por ela que Dashboard e Financeiro filtram.
   */
  soldAt?: Date | null;
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
  platform?: string;
  status?: OrderStatus;
  search?: string;
  page?: number;
  limit?: number;
  dateFrom?: Date;
  dateTo?: Date;
  // Faixa de valor sobre Order.totalAmount (usada só pela listagem da vitrine).
  amountMin?: number;
  amountMax?: number;
  includeItems?: boolean;
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

  // Listar pedidos para a vitrine: miniatura leve do 1º item (sem trafegar o
  // grafo completo de itens) + contagem. Mesmos filtros do findAll + faixa de
  // valor.
  findAllForList(options?: OrderFindOptions): Promise<OrderFindResult>;

  // Listar pedidos de uma conta de marketplace
  findByMarketplaceAccount(marketplaceAccountId: string): Promise<Order[]>;

  // Atualizar status do pedido
  update(id: string, data: OrderUpdate): Promise<Order>;

  // Contar pedidos
  count(marketplaceAccountId?: string): Promise<number>;

  // Verificar se pedido já existe (por marketplaceAccountId + externalOrderId)
  exists(
    marketplaceAccountId: string,
    externalOrderId: string,
  ): Promise<boolean>;

  // Vincular um Customer do CRM a um pedido já criado (auto-cadastro no
  // import). Aditivo: o create() continua sem customerId.
  setCustomer(orderId: string, customerId: string): Promise<void>;
}
