"use client";

import React from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { Session } from "next-auth";
import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard,
  LineChart,
  Link2,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  ShoppingBag,
  Store,
  ChevronDown,
} from "lucide-react";

import { getApiBaseUrl } from "@/lib/api";

import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  useSidebar,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type NavItem = {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
  badge?: number;
};

type NavSection = {
  id: string;
  label?: string;
  items: NavItem[];
};

const NAV_SECTIONS: NavSection[] = [
  {
    id: "primary",
    label: "Principal",
    items: [
      { id: "dashboard", label: "Dashboard", href: "/", icon: LayoutDashboard },
      { id: "produtos", label: "Produtos", href: "/produtos", icon: Package },
      {
        id: "pedidos",
        label: "Pedidos",
        href: "/pedidos",
        icon: ShoppingBag,
      },
    ],
  },
  {
    id: "marketplaces",
    label: "Marketplaces",
    items: [
      {
        id: "mercado-livre",
        label: "Mercado Livre",
        href: "/integracoes/mercado-livre",
        icon: Store,
      },
      {
        id: "shopee",
        label: "Shopee",
        href: "/integracoes/shopee",
        icon: Link2,
      },
    ],
  },
  {
    id: "ops",
    label: "Operações",
    items: [
      {
        id: "logs",
        label: "Logs do Sistema",
        href: "/logs",
        icon: LineChart,
      },
    ],
  },
];

interface AppSidebarProps {
  session: Session | null;
}

export function AppSidebar({ session }: AppSidebarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { state, setOpen, open } = useSidebar();
  const collapsed = state === "collapsed";
  const [query, setQuery] = React.useState("");
  const searchRef = React.useRef<HTMLInputElement>(null);
  const [openSections, setOpenSections] = React.useState<
    Record<string, boolean>
  >(() =>
    NAV_SECTIONS.reduce(
      (acc, section) => {
        acc[section.id] = true;
        return acc;
      },
      {} as Record<string, boolean>,
    ),
  );
  const [searchResults, setSearchResults] = React.useState<{
    products: any[];
    orders: any[];
    listings: any[];
  }>({ products: [], orders: [], listings: [] });
  const [searchLoading, setSearchLoading] = React.useState(false);
  const [ordersCount, setOrdersCount] = React.useState<number | null>(null);

  React.useEffect(() => {
    if (!session) {
      router.push("/login");
    }
  }, [router, session]);

  React.useEffect(() => {
    const email = session?.user?.email;
    if (!email) return;

    const loadOrdersCount = async () => {
      try {
        const apiBase = getApiBaseUrl();
        const res = await fetch(`${apiBase}/orders/stats`, {
          headers: { email },
        });
        if (!res.ok) throw new Error("Erro ao buscar contagem de pedidos");
        const data = await res.json();
        const total =
          typeof data?.stats?.total === "number"
            ? data.stats.total
            : Number(data?.stats?.total ?? 0);
        setOrdersCount(Number.isFinite(total) ? total : 0);
      } catch (error) {
        console.error("Sidebar orders count error", error);
      }
    };

    loadOrdersCount();
  }, [session?.user?.email]);

  React.useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
        requestAnimationFrame(() => searchRef.current?.focus());
      }
    };

    if (typeof window !== "undefined") {
      window.addEventListener("keydown", handler);
      return () => window.removeEventListener("keydown", handler);
    }
  }, [setOpen]);

  const filteredSections = React.useMemo(() => {
    const term = query.trim().toLowerCase();
    const withDynamicBadges = NAV_SECTIONS.map((section) => ({
      ...section,
      items: section.items.map((item) =>
        item.id === "pedidos" && ordersCount !== null
          ? { ...item, badge: ordersCount }
          : item,
      ),
    }));
    if (!term) return withDynamicBadges;
    return withDynamicBadges
      .map((section) => ({
        ...section,
        items: section.items.filter((item) =>
          item.label.toLowerCase().includes(term),
        ),
      }))
      .filter((section) => section.items.length > 0);
  }, [ordersCount, query]);

  // Busca unificada
  React.useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setSearchResults({ products: [], orders: [], listings: [] });
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        setSearchLoading(true);
        const apiBase = getApiBaseUrl();
        const res = await fetch(
          `${apiBase}/dashboard/search?q=${encodeURIComponent(term)}&limit=5`,
          {
            headers: session?.user?.email
              ? { email: session.user.email }
              : undefined,
          },
        );
        if (!res.ok) throw new Error("Erro ao buscar");
        const data = await res.json();
        if (!cancelled) setSearchResults(data);
      } catch (error) {
        console.error("Unified search error", error);
        if (!cancelled)
          setSearchResults({ products: [], orders: [], listings: [] });
      } finally {
        if (!cancelled) setSearchLoading(false);
      }
    };
    const id = setTimeout(load, 250);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [query, session?.user?.email]);

  if (!session) return null;

  const handleCollapse = () => setOpen(!open);

  return (
    <Sidebar
      collapsible="icon"
      className="relative h-full border-r border-sidebar-border/70 bg-sidebar text-sidebar-foreground shadow-[0_28px_80px_-52px_rgba(0,0,0,0.8)] data-[state=collapsed]:w-[84px]"
    >
      {collapsed && <CollapseHandle open={open} onToggle={handleCollapse} />}
      <div className="flex h-full flex-col px-2">
        <SidebarHeader className="border-b border-sidebar-border/60 px-2 pb-4 pt-5">
          <BrandHeader collapsed={collapsed} onToggle={handleCollapse} />
        </SidebarHeader>

        <SidebarContent className="flex-1 overflow-hidden px-1 pt-3">
          <SidebarSearch
            collapsed={collapsed}
            query={query}
            onQueryChange={setQuery}
            inputRef={searchRef}
            onRequestFocus={() => {
              setOpen(true);
              requestAnimationFrame(() => searchRef.current?.focus());
            }}
            results={searchResults}
            loading={searchLoading}
            onNavigate={(href) => router.push(href)}
          />

          <nav
            aria-label="Menu principal"
            className="mt-4 flex-1 space-y-5 overflow-y-auto pb-4 pr-1"
          >
            {filteredSections.map((section) => (
              <SidebarNavSection
                key={section.id}
                label={section.label}
                collapsed={collapsed}
                isOpen={openSections[section.id] ?? true}
                onToggle={() =>
                  setOpenSections((prev) => ({
                    ...prev,
                    [section.id]: !prev[section.id],
                  }))
                }
              >
                {(openSections[section.id] ?? true) &&
                  section.items.map((item) => {
                    const active =
                      pathname === item.href ||
                      pathname.startsWith(`${item.href}/`);
                    return (
                      <SidebarNavItem
                        key={item.id}
                        item={item}
                        active={active}
                        collapsed={collapsed}
                      />
                    );
                  })}
              </SidebarNavSection>
            ))}
          </nav>
        </SidebarContent>
      </div>
    </Sidebar>
  );
}

function BrandHeader({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-3">
        <div className="grid h-10 w-10 place-items-center overflow-hidden rounded-2xl bg-sidebar-primary text-sidebar-primary-foreground shadow-[0_18px_45px_-26px_rgba(0,0,0,0.65)]">
          <Image src="/logo.jpg" alt="Logo" width={40} height={40} />
        </div>
        {!collapsed && (
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-semibold">Dexo</span>
            <span className="text-[11px] text-muted-foreground">
              Operações unificadas
            </span>
          </div>
        )}
      </div>

      {!collapsed && (
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggle}
          className="h-9 w-9 rounded-full border border-sidebar-border/70 bg-sidebar-accent/15 text-muted-foreground hover:border-sidebar-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          aria-label="Recolher sidebar"
        >
          <PanelLeftClose className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

function CollapseHandle({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="pointer-events-none fixed left-[30px] top-1/2 z-50 -translate-y-1/2">
      <Button
        variant="ghost"
        size="icon"
        className="pointer-events-auto h-10 w-10 rounded-full border border-sidebar-border/80 bg-sidebar-accent/25 text-muted-foreground shadow-[0_10px_30px_-20px_rgba(0,0,0,0.8)] hover:border-sidebar-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        aria-label={open ? "Recolher sidebar" : "Expandir sidebar"}
        onClick={onToggle}
      >
        {open ? (
          <PanelLeftClose className="h-4 w-4" />
        ) : (
          <PanelLeftOpen className="h-4 w-4" />
        )}
      </Button>
    </div>
  );
}

function SidebarSearch({
  collapsed,
  query,
  onQueryChange,
  inputRef,
  onRequestFocus,
  results,
  loading,
  onNavigate,
}: {
  collapsed: boolean;
  query: string;
  onQueryChange: (value: string) => void;
  inputRef: React.RefObject<HTMLInputElement>;
  onRequestFocus: () => void;
  results: {
    products: any[];
    orders: any[];
    listings: any[];
  };
  loading: boolean;
  onNavigate: (href: string) => void;
}) {
  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              onQueryChange("");
              onRequestFocus();
            }}
            className="hidden h-11 w-11 rounded-full border border-sidebar-border/70 bg-sidebar-accent/12 text-muted-foreground hover:border-sidebar-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            aria-label="Buscar"
          >
            <Search className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">Buscar (Ctrl/Cmd + K)</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div className="group relative">
      <div className="flex items-center gap-2 rounded-full border border-sidebar-border/70 bg-sidebar-accent/12 px-3 py-2 text-sm shadow-[0_12px_30px_-28px_rgba(0,0,0,0.6)] focus-within:border-sidebar-ring focus-within:ring-1 focus-within:ring-sidebar-ring">
        <Search className="h-4 w-4 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          type="search"
          placeholder="Buscar páginas ou ações..."
          className="h-7 flex-1 border-0 bg-transparent px-0 text-sm text-foreground placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:outline-none dark:bg-transparent"
        />
        <span className="rounded-md bg-transparent px-2 py-0.5 text-[11px] text-muted-foreground">
          Ctrl/Cmd + K
        </span>
      </div>

      {query.trim().length >= 2 && (
        <div className="absolute left-0 right-0 z-30 mt-2 rounded-2xl border border-sidebar-border/70 bg-sidebar p-2 shadow-lg">
          {loading ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              Buscando...
            </div>
          ) : results.products.length === 0 &&
            results.orders.length === 0 &&
            results.listings.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              Nenhum resultado
            </div>
          ) : (
            <div className="space-y-2 text-sm">
              {results.products.length > 0 && (
                <ResultGroup title="Produtos">
                  {results.products.map((p) => (
                    <ResultRow
                      key={p.id}
                      title={p.name}
                      subtitle={`SKU ${p.sku ?? "—"}`}
                      badge={`${p.stock ?? 0} unid`}
                      onClick={() =>
                        onNavigate(`/produtos?search=${p.sku ?? p.name}`)
                      }
                    />
                  ))}
                </ResultGroup>
              )}

              {results.orders.length > 0 && (
                <ResultGroup title="Pedidos">
                  {results.orders.map((o) => (
                    <ResultRow
                      key={o.id}
                      title={`Pedido ${o.externalOrderId}`}
                      subtitle={o.customerName || o.status}
                      badge={o.status}
                      onClick={() =>
                        onNavigate(`/pedidos?search=${o.externalOrderId}`)
                      }
                    />
                  ))}
                </ResultGroup>
              )}

              {results.listings.length > 0 && (
                <ResultGroup title="Anúncios">
                  {results.listings.map((l) => (
                    <ResultRow
                      key={l.id}
                      title={l.product?.name ?? l.externalListingId}
                      subtitle={l.permalink || l.externalListingId}
                      badge={l.marketplaceAccount?.platform}
                      onClick={() => {
                        if (l.permalink && typeof window !== "undefined") {
                          window.open(l.permalink, "_blank");
                        } else {
                          onNavigate(
                            `/produtos?search=${l.product?.sku ?? ""}`,
                          );
                        }
                      }}
                    />
                  ))}
                </ResultGroup>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SidebarNavSection({
  label,
  children,
  collapsed,
  isOpen,
  onToggle,
}: {
  label?: string;
  children: React.ReactNode;
  collapsed: boolean;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const header = (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isOpen}
      className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground hover:bg-sidebar-accent/12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
    >
      <span className={cn("flex-1 text-left", collapsed && "sr-only")}>
        {label}
      </span>
      <ChevronDown
        className={cn(
          "h-3.5 w-3.5 transition-transform",
          isOpen ? "rotate-0" : "-rotate-90",
          collapsed && "sr-only",
        )}
      />
    </button>
  );

  return (
    <div className="space-y-2">
      {label &&
        (collapsed ? (
          <Tooltip>
            <TooltipTrigger asChild>{header}</TooltipTrigger>
            <TooltipContent side="right">{label}</TooltipContent>
          </Tooltip>
        ) : (
          header
        ))}
      {isOpen && <div className="space-y-1">{children}</div>}
      <div className="px-3">
        <div className="h-px bg-sidebar-border/70" />
      </div>
    </div>
  );
}

function SidebarNavItem({
  item,
  active,
  collapsed,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
}) {
  const node = (
    <Link
      href={item.href}
      className={cn(
        "group/nav relative flex items-center gap-3 rounded-full px-3 py-2.5 text-sm transition-all duration-150",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-0",
        active
          ? "border border-sidebar-border/70 bg-sidebar-accent/70 text-sidebar-accent-foreground shadow-[0_18px_45px_-32px_rgba(0,0,0,0.75)]"
          : "text-sidebar-foreground/90 hover:bg-sidebar-accent/14 hover:text-foreground",
      )}
      aria-current={active ? "page" : undefined}
    >
      <item.icon className="h-4 w-4" />
      {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
      {item.badge !== undefined &&
        (collapsed ? (
          <span className="ml-auto h-2.5 w-2.5 rounded-full bg-primary" />
        ) : (
          <span className="ml-auto inline-flex min-w-[26px] items-center justify-center rounded-full bg-primary px-2 text-[11px] font-semibold text-primary-foreground">
            {item.badge}
          </span>
        ))}
    </Link>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{node}</TooltipTrigger>
        <TooltipContent side="right">{item.label}</TooltipContent>
      </Tooltip>
    );
  }

  return node;
}

function ResultGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="px-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {title}
      </div>
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}

function ResultRow({
  title,
  subtitle,
  badge,
  onClick,
}: {
  title: string;
  subtitle?: string | null;
  badge?: string | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left transition hover:bg-sidebar-accent/12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
    >
      <div className="flex-1">
        <div className="text-sm font-medium text-foreground">{title}</div>
        {subtitle && (
          <div className="text-[12px] text-muted-foreground truncate">
            {subtitle}
          </div>
        )}
      </div>
      {badge && (
        <span className="rounded-full bg-sidebar-accent/20 px-2 py-0.5 text-[11px] font-semibold text-foreground">
          {badge}
        </span>
      )}
    </button>
  );
}
