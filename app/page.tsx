import { Activity, ChartLine, Link2, Package } from "lucide-react";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";

import { authOptions } from "./lib/auth";
import { getApiBaseUrl } from "@/lib/api";
import { MetricCard } from "@/components/dashboard/metric-card";
import { HeroAreaChart } from "@/components/dashboard/hero-area-chart";
import { OrdersHeatmap } from "@/components/dashboard/orders-heatmap";
import {
  CountryGrid,
  type AccountStat,
} from "@/components/dashboard/country-grid";
import {
  ProductRow,
  TopProductsTable,
} from "@/components/dashboard/top-products-table";

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

type HeatmapCell = { day: string; slot: "morning" | "afternoon" | "evening"; value: number };

async function getDashboardStats(
  userEmail: string,
): Promise<DashboardStats | null> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/dashboard/stats`, {
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
      `${getApiBaseUrl()}/dashboard/integrations`,
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

async function getOrdersOverTime(
  userEmail: string,
): Promise<OrderOverTimeItem[]> {
  try {
    const res = await fetch(
      `${getApiBaseUrl()}/dashboard/orders-over-time?days=180`,
      { cache: "no-store", headers: { email: userEmail } },
    );
    if (!res.ok) return [];
    return (await res.json()) as OrderOverTimeItem[];
  } catch {
    return [];
  }
}

async function getStockChanges(userEmail: string): Promise<StockChangeItem[]> {
  try {
    const res = await fetch(
      `${getApiBaseUrl()}/dashboard/stock-changes?days=30`,
      { cache: "no-store", headers: { email: userEmail } },
    );
    if (!res.ok) return [];
    return (await res.json()) as StockChangeItem[];
  } catch {
    return [];
  }
}

async function getProductMetrics(
  userEmail: string,
): Promise<
  {
    productId: string;
    listingId?: string | null;
    name: string;
    sku: string;
    stock: number;
    sales: number;
    revenue: number;
    growth: number | null;
    reviews: number;
    views: number;
    platform?: string | null;
    accountName?: string | null;
    lastDate: string | null;
  }[]
> {
  try {
    const res = await fetch(
      `${getApiBaseUrl()}/dashboard/product-metrics?days=30&limit=8`,
      { cache: "no-store", headers: { email: userEmail } },
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.items || [];
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

function formatCurrencyBRL(value: number) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("pt-BR").format(Math.round(value));
}

function computeDelta(
  series: OrderOverTimeItem[],
  key: "orders" | "totalAmount",
  window = 7,
): number | null {
  const sorted = [...series].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );
  const current = sorted.slice(-window);
  const previous = sorted.slice(-(window * 2), -window);

  if (!current.length || !previous.length) return null;

  const currentSum = current.reduce((sum, item) => sum + (item[key] ?? 0), 0);
  const previousSum = previous.reduce((sum, item) => sum + (item[key] ?? 0), 0);

  if (previousSum === 0) return null;

  return ((currentSum - previousSum) / previousSum) * 100;
}

export default async function Home() {
  const userSession = await getServerSession(authOptions);

  if (!userSession) {
    redirect("/login");
  }

  const [stats, integrations, ordersOverTime, stockChanges] = await Promise.all(
    [
      getDashboardStats(userSession.user?.email || ""),
      getMarketplaceIntegrations(userSession.user?.email || ""),
      getOrdersOverTime(userSession.user?.email || ""),
      getStockChanges(userSession.user?.email || ""),
      // product metrics fetch separately below to avoid breaking existing Promise.all shape
    ],
  );
  const productMetrics = await getProductMetrics(userSession.user?.email || "");

  const activeIntegrations = integrations.filter((i) => i.status === "ACTIVE");
  const sortedOrders = [...ordersOverTime].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );

  const totalRevenue = sortedOrders.reduce(
    (sum, item) => sum + (item.totalAmount ?? 0),
    0,
  );
  const totalOrders = sortedOrders.reduce(
    (sum, item) => sum + (item.orders ?? 0),
    0,
  );
  const averageOrders =
    sortedOrders.length > 0 ? totalOrders / sortedOrders.length : 0;

  const revenueDelta = computeDelta(sortedOrders, "totalAmount");
  const ordersDelta = computeDelta(sortedOrders, "orders");

  const netStockChange = stockChanges.reduce((sum, item) => {
    const last = item.changes?.[0];
    return sum + (last?.change ?? 0);
  }, 0);

  const stockDelta =
    stats?.totalStock && stats.totalStock !== 0
      ? (netStockChange / Math.max(stats.totalStock - netStockChange, 1)) * 100
      : null;

  const criticalProducts = stats?.lowStockProducts ?? [];

  const metricCards = [
    {
      title: "Receita total",
      value: formatCurrencyBRL(totalRevenue),
      caption: "Período corrente • abrangência global",
      delta: revenueDelta,
      deltaLabel: "",
      tone:
        revenueDelta !== null && revenueDelta < 0
          ? ("negative" as const)
          : ("positive" as const),
    },
    {
      title: "Total de pedidos",
      value: formatNumber(totalOrders),
      caption: `Média diária ${formatNumber(averageOrders)} • ${sortedOrders.length} dias de dados`,
      delta: ordersDelta,
      deltaLabel: "",
      tone: "neutral" as const,
    },
    {
      title: "Estoque disponível",
      value: formatNumber(stats?.totalStock ?? 0),
      caption: `${criticalProducts.length} produtos em nível crítico`,
      delta: stockDelta,
      deltaLabel: "",
      tone:
        stockDelta !== null && stockDelta < 0
          ? ("negative" as const)
          : ("positive" as const),
    },
    {
      title: "Integrações ativas",
      value: formatNumber(activeIntegrations.length),
      caption:
        activeIntegrations.length > 0
          ? `Última sync ${formatTimeAgo(activeIntegrations[0].updatedAt)}`
          : "Conecte um marketplace para sincronizar",
      delta: null,
      deltaLabel: "",
      tone: "neutral" as const,
    },
  ];

  const heatmapData = buildHeatmapData(sortedOrders);
  const accountStats = buildAccountSales(
    integrations,
    totalRevenue,
    totalOrders,
  );
  const topProducts = buildTopProducts(productMetrics);

  return (
    <div className="mx-auto flex w-full max-w-full flex-col gap-6 pb-10">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
            Painel executivo
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Visão de desempenho
          </h1>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="rounded-full border border-border/60 bg-muted/30 px-3 py-1 font-medium text-foreground">
            Dados em tempo real
          </span>
          <span className="hidden rounded-full border border-border/60 bg-muted/30 px-3 py-1 sm:inline">
            {activeIntegrations.length} integrações
          </span>
        </div>
      </header>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {metricCards.map((metric) => (
          <MetricCard key={metric.title} {...metric} />
        ))}
      </section>

      <section className="grid gap-4 xl:grid-cols-3">
        <div className="xl:col-span-1">
          <OrdersHeatmap data={heatmapData} />
        </div>
        <div className="xl:col-span-2">
          <HeroAreaChart data={sortedOrders} title="Performance mensal" />
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-3">
        <div className="xl:col-span-1">
          <CountryGrid
            items={accountStats}
            viewAllHref="/integracoes/mercado-livre"
          />
        </div>
        <div className="xl:col-span-2">
          <TopProductsTable rows={topProducts} />
        </div>
      </section>
    </div>
  );
}

function buildHeatmapData(points: OrderOverTimeItem[]): HeatmapCell[] {
  const dayOrder = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const slots: Array<HeatmapCell["slot"]> = ["morning", "afternoon", "evening"];

  // Agrupa pedidos reais por dia da semana
  const weekdayTotals = points.reduce<Record<string, number>>((acc, p) => {
    const jsDay = new Date(p.date).getDay(); // 0 domingo
    const day = dayOrder[(jsDay + 6) % 7]; // alinhar segunda
    acc[day] = (acc[day] ?? 0) + (p.orders ?? 0);
    return acc;
  }, {});

  // Distribui igualmente pelos períodos do dia (sem forçar dados fictícios de horário)
  const rows: HeatmapCell[] = [];
  dayOrder.forEach((day) => {
    const total = weekdayTotals[day] ?? 0;
    const perSlot = total / slots.length;
    slots.forEach((slot) => {
      rows.push({ day, slot, value: perSlot });
    });
  });

  return rows;
}

function getPlatformDisplay(platform: string): {
  name: string;
  abbrev: string;
} {
  switch (platform) {
    case "MERCADO_LIVRE":
      return { name: "Mercado Livre", abbrev: "ML" };
    case "SHOPEE":
      return { name: "Shopee", abbrev: "SP" };
    default:
      return { name: platform, abbrev: platform.slice(0, 2).toUpperCase() };
  }
}

function buildAccountSales(
  integrations: MarketplaceIntegration[],
  totalRevenue: number,
  totalOrders: number,
): AccountStat[] {
  if (!integrations?.length) {
    return [
      {
        id: "placeholder",
        code: "-",
        account: "Nenhuma conta conectada",
        platform: "Conecte um marketplace para ver vendas por conta",
        revenue: "-",
        orders: "-",
        status: "pending",
        accent: "muted",
      },
    ];
  }

  return integrations.slice(0, 6).map((integration) => {
    const display = getPlatformDisplay(integration.platform);
    const isActive = integration.status === "ACTIVE";
    return {
      id: integration.id,
      code: display.abbrev,
      account: integration.accountName ?? display.name,
      platform: display.name,
      revenue: "-", // ainda sem dado financeiro por conta
      orders: "-", // sem agregado por conta no endpoint atual
      status: isActive ? "active" : "pending",
      accent: isActive ? "primary" : "muted",
      lastSync: integration.updatedAt
        ? formatTimeAgo(integration.updatedAt)
        : undefined,
    };
  });
}

function buildTopProducts(
  metrics: {
    productId: string;
    listingId?: string | null;
    name: string;
    sku: string;
    stock: number;
    sales: number;
    revenue: number;
    growth: number | null;
    reviews: number;
    views: number;
    platform?: string | null;
    accountName?: string | null;
  }[],
): ProductRow[] {
  return (metrics ?? []).map((item) => {
    const direction =
      item.growth === null
        ? "flat"
        : item.growth > 0
          ? "up"
          : item.growth < 0
            ? "down"
            : "flat";

    const growthLabel =
      item.growth === null
        ? "—"
        : `${item.growth > 0 ? "+" : ""}${item.growth.toFixed(1)}%`;

    return {
      id: item.listingId ?? item.productId,
      name: item.name,
      sku: item.sku === "—" ? undefined : item.sku,
      stock: formatNumber(item.stock ?? 0),
      sales: formatNumber(item.sales ?? 0),
      growth: growthLabel,
      reviews: formatNumber(item.reviews ?? 0),
      views: formatNumber(item.views ?? 0),
      direction,
    };
  });
}
