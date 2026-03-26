import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import type { Metadata } from "next";

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
  ListingsOverview,
  type ListingStats,
} from "@/components/dashboard/listings-overview";

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

interface ListingStatsResponse extends ListingStats {}

type HeatmapCell = {
  day: string;
  slot: "morning" | "afternoon" | "evening";
  value: number;
};

export const metadata: Metadata = {
  title: "Dashboard",
  description:
    "Painel de controle com métricas de estoque, vendas e integrações dos seus marketplaces.",
};

async function getMarketplaceIntegrations(
  userEmail: string,
): Promise<MarketplaceIntegration[]> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/dashboard/integrations`, {
      cache: "no-store",
      headers: {
        email: userEmail,
      },
    });
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

async function getListingStats(
  userEmail: string,
): Promise<ListingStatsResponse | null> {
  try {
    const res = await fetch(
      `${getApiBaseUrl()}/dashboard/listing-stats?days=180`,
      { cache: "no-store", headers: { email: userEmail } },
    );
    if (!res.ok) return null;
    return (await res.json()) as ListingStatsResponse;
  } catch {
    return null;
  }
}

async function getAccountStats(
  userEmail: string,
): Promise<Record<string, { revenue: number; orders: number }>> {
  try {
    const res = await fetch(`${getApiBaseUrl()}/dashboard/account-stats`, {
      cache: "no-store",
      headers: { email: userEmail },
    });
    if (!res.ok) return {};
    const data = await res.json();
    return data.accountStats || {};
  } catch {
    return {};
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

  const [
    integrations,
    ordersOverTime,
    listingStats,
    accountStats,
  ] = await Promise.all([
    getMarketplaceIntegrations(userSession.user?.email || ""),
    getOrdersOverTime(userSession.user?.email || ""),
    getListingStats(userSession.user?.email || ""),
    getAccountStats(userSession.user?.email || ""),
  ]);

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
      title: "Total de anúncios",
      value: formatNumber(listingStats?.totalListings ?? 0),
      caption: `${formatNumber(
        listingStats?.totalListingsActive ?? 0,
      )} em contas ativas`,
      delta: null,
      deltaLabel: "",
      tone: "neutral" as const,
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
  const accountSales = buildAccountSales(
    integrations,
    totalRevenue,
    totalOrders,
    accountStats,
  );

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
            items={accountSales}
            viewAllHref="/integracoes/mercado-livre"
          />
        </div>
        <div className="xl:col-span-2">
          <ListingsOverview stats={listingStats} />
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
  perAccountStats: Record<string, { revenue: number; orders: number }>,
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
    const stats = perAccountStats[integration.id];
    return {
      id: integration.id,
      code: display.abbrev,
      account: integration.accountName ?? display.name,
      platform: display.name,
      revenue: stats ? formatCurrencyBRL(stats.revenue) : "-",
      orders: stats ? formatNumber(stats.orders) : "-",
      status: isActive ? "active" : "pending",
      accent: isActive ? "primary" : "muted",
      lastSync: integration.updatedAt
        ? formatTimeAgo(integration.updatedAt)
        : undefined,
    };
  });
}
