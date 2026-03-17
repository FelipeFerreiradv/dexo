import {
  Package,
  Warehouse,
  AlertTriangle,
  Link2,
  Link2Off,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "./lib/auth";
import ProductsByCategory from "@/components/charts/products-by-category";
import OrdersOverTime from "@/components/charts/orders-over-time";
import StockDistribution from "@/components/charts/stock-distribution";
import StockChanges from "@/components/charts/stock-changes";

interface DashboardStats {
  totalProducts: number;
  totalStock: number;
  lowStockProducts: {
    id: string;
    name: string;
    sku: string | null;
    stock: number;
  }[];
}

interface MarketplaceIntegration {
  id: string;
  platform: string;
  accountName: string | null;
  status: string;
  updatedAt: string;
}

interface CategoryItem {
  category: string;
  count: number;
}

interface StockDistributionItem {
  range: string;
  count: number;
}

interface OrderOverTimeItem {
  date: string;
  orders: number;
  totalAmount: number;
}

interface StockChangeItem {
  productId: string;
  productName: string;
  productSku?: string | null;
  productImageUrl?: string | null;
  changes: {
    date: string;
    change: number;
    previousStock: number;
    newStock: number;
  }[];
}

async function getDashboardStats(
  userEmail: string,
): Promise<DashboardStats | null> {
  try {
    const response = await fetch("http://localhost:3333/dashboard/stats", {
      cache: "no-store",
      headers: { email: userEmail },
    });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

async function getMarketplaceIntegrations(
  userEmail: string,
): Promise<MarketplaceIntegration[]> {
  try {
    const response = await fetch(
      "http://localhost:3333/dashboard/integrations",
      {
        cache: "no-store",
        headers: {
          email: userEmail,
        },
      },
    );
    if (!response.ok) return [];
    const data = await response.json();
    return data.integrations || [];
  } catch {
    return [];
  }
}

function formatTimeAgo(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMinutes < 1) return "agora";
  if (diffMinutes < 60) return `há ${diffMinutes} min`;
  if (diffHours < 24) return `há ${diffHours}h`;
  return `há ${diffDays}d`;
}

function getPlatformDisplay(platform: string): {
  name: string;
  abbrev: string;
  bgClass: string;
  textClass: string;
} {
  switch (platform) {
    case "MERCADO_LIVRE":
      return {
        name: "Mercado Livre",
        abbrev: "ML",
        bgClass: "bg-primary/10",
        textClass: "text-primary",
      };
    case "SHOPEE":
      return {
        name: "Shopee",
        abbrev: "SP",
        bgClass: "bg-orange-500/10",
        textClass: "text-orange-500",
      };
    default:
      return {
        name: platform,
        abbrev: platform.slice(0, 2).toUpperCase(),
        bgClass: "bg-gray-500/10",
        textClass: "text-gray-500",
      };
  }
}

function getStockBadgeClass(stock: number): string {
  if (stock <= 3) {
    return "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400";
  }
  return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400";
}

export default async function Home() {
  const userSession = await getServerSession(authOptions);

  if (!userSession) {
    redirect("/login");
  }

  const [stats, integrations] = await Promise.all([
    getDashboardStats(userSession.user?.email || ""),
    getMarketplaceIntegrations(userSession.user?.email || ""),
  ]);

  // Buscar dados de gráficos
  const [productsByCategory, stockDistribution, ordersOverTime, stockChanges] =
    await Promise.all([
      (async () => {
        try {
          const res = await fetch(
            "http://localhost:3333/dashboard/products-by-category",
            { cache: "no-store", headers: { email: userSession.user?.email || "" } },
          );
          if (!res.ok) return [] as CategoryItem[];
          return (await res.json()) as CategoryItem[];
        } catch {
          return [] as CategoryItem[];
        }
      })(),
      (async () => {
        try {
          const res = await fetch(
            "http://localhost:3333/dashboard/stock-distribution",
            { cache: "no-store", headers: { email: userSession.user?.email || "" } },
          );
          if (!res.ok) return [] as StockDistributionItem[];
          return (await res.json()) as StockDistributionItem[];
        } catch {
          return [] as StockDistributionItem[];
        }
      })(),
      (async () => {
        try {
          const res = await fetch(
            "http://localhost:3333/dashboard/orders-over-time?days=30",
            { cache: "no-store", headers: { email: userSession.user?.email || "" } },
          );
          if (!res.ok) return [] as OrderOverTimeItem[];
          return (await res.json()) as OrderOverTimeItem[];
        } catch {
          return [] as OrderOverTimeItem[];
        }
      })(),
      (async () => {
        try {
          const res = await fetch(
            "http://localhost:3333/dashboard/stock-changes?days=7",
            { cache: "no-store", headers: { email: userSession.user?.email || "" } },
          );
          if (!res.ok) return [] as StockChangeItem[];
          return (await res.json()) as StockChangeItem[];
        } catch {
          return [] as StockChangeItem[];
        }
      })(),
    ]);

  const activeIntegrations = integrations.filter((i) => i.status === "ACTIVE");

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-foreground">
          Dashboard
        </h2>
        <p className="text-muted-foreground">
          Visão geral do seu estoque e integrações
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Total de Produtos
            </CardTitle>
            <Package className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {stats?.totalProducts.toLocaleString("pt-BR") ?? "—"}
            </div>
            <p className="text-xs text-muted-foreground">
              Produtos cadastrados
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Itens em Estoque
            </CardTitle>
            <Warehouse className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {stats?.totalStock.toLocaleString("pt-BR") ?? "—"}
            </div>
            <p className="text-xs text-muted-foreground">
              Unidades disponíveis
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Estoque Baixo</CardTitle>
            <AlertTriangle className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {stats?.lowStockProducts.length ?? "—"}
            </div>
            <p className="text-xs text-muted-foreground">
              Produtos com ≤10 unidades
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              Integrações Ativas
            </CardTitle>
            <Link2 className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {activeIntegrations.length}
            </div>
            <p className="text-xs text-muted-foreground">
              Marketplaces conectados
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Integrações Ativas</CardTitle>
            <CardDescription>
              Status das conexões com marketplaces
            </CardDescription>
          </CardHeader>
          <CardContent>
            {integrations.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-6 text-center">
                <Link2Off className="size-10 text-muted-foreground/50 mb-2" />
                <p className="text-sm text-muted-foreground">
                  Nenhuma integração configurada
                </p>
                <p className="text-xs text-muted-foreground">
                  Configure suas integrações em Configurações → Integrações
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {integrations.map((integration) => {
                  const platform = getPlatformDisplay(integration.platform);
                  const isActive = integration.status === "ACTIVE";
                  return (
                    <div
                      key={integration.id}
                      className="flex items-center justify-between"
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className={`flex size-10 items-center justify-center rounded-lg ${platform.bgClass}`}
                        >
                          <span
                            className={`text-sm font-semibold ${platform.textClass}`}
                          >
                            {platform.abbrev}
                          </span>
                        </div>
                        <div>
                          <p className="text-sm font-medium">{platform.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {integration.accountName ||
                              `Última sync: ${formatTimeAgo(integration.updatedAt)}`}
                          </p>
                        </div>
                      </div>
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-medium ${
                          isActive
                            ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                            : "bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-400"
                        }`}
                      >
                        {isActive ? "Conectado" : "Desconectado"}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Alertas de Estoque</CardTitle>
            <CardDescription>Produtos com estoque baixo (≤10)</CardDescription>
          </CardHeader>
          <CardContent>
            {!stats || stats.lowStockProducts.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-6 text-center">
                <Package className="size-10 text-muted-foreground/50 mb-2" />
                <p className="text-sm text-muted-foreground">
                  Nenhum produto com estoque baixo
                </p>
                <p className="text-xs text-muted-foreground">
                  Todos os produtos têm estoque adequado
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {stats.lowStockProducts.map((product) => (
                  <div
                    key={product.id}
                    className="flex items-center justify-between"
                  >
                    <div>
                      <p className="text-sm font-medium">{product.name}</p>
                      <p className="text-xs text-muted-foreground">
                        SKU: {product.sku || "—"}
                      </p>
                    </div>
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-medium ${getStockBadgeClass(product.stock)}`}
                    >
                      {product.stock}{" "}
                      {product.stock === 1 ? "unidade" : "unidades"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Produtos por Categoria</CardTitle>
            <CardDescription>Composição do catálogo</CardDescription>
          </CardHeader>
          <CardContent>
            <ProductsByCategory data={productsByCategory} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Pedidos (30 dias)</CardTitle>
            <CardDescription>Tendência de pedidos</CardDescription>
          </CardHeader>
          <CardContent>
            <OrdersOverTime data={ordersOverTime} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Distribuição de Estoque</CardTitle>
            <CardDescription>Contagem por faixa</CardDescription>
          </CardHeader>
          <CardContent>
            <StockDistribution data={stockDistribution} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Alterações de Estoque (7 dias)</CardTitle>
            <CardDescription>Produtos com mais alterações</CardDescription>
          </CardHeader>
          <CardContent>
            <StockChanges data={stockChanges} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
