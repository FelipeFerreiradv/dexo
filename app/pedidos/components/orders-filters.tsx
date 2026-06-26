"use client";

import { Filter, Search, Loader2 } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CurrencyInput } from "@/components/ui/currency-input";

import { ORDER_STATUS_LABELS } from "../lib/order-badges";
import type { OrderFiltersState } from "../lib/order-filters";

// Radix Select não aceita value "" — usamos um sentinel para "Todos".
const SELECT_ALL = "ALL";

interface OrdersFiltersProps {
  filters: OrderFiltersState;
  searchInput: string;
  onSearchInputChange: (value: string) => void;
  onUpdateFilter: <K extends keyof OrderFiltersState>(
    key: K,
    value: OrderFiltersState[K],
  ) => void;
  onClear: () => void;
  isFetching: boolean;
  activeCount: number;
}

export function OrdersFilters({
  filters,
  searchInput,
  onSearchInputChange,
  onUpdateFilter,
  onClear,
  isFetching,
  activeCount,
}: OrdersFiltersProps) {
  const canClear = activeCount > 0 || searchInput.trim().length > 0;

  return (
    <Card className="border border-border/60 bg-card/80 shadow-[0_18px_50px_-38px_rgba(0,0,0,0.45)] backdrop-blur">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2">
              <Filter className="h-5 w-5" />
              Filtros
              {activeCount > 0 ? (
                <Badge variant="secondary" className="ml-1 font-normal">
                  {activeCount} {activeCount === 1 ? "ativo" : "ativos"}
                </Badge>
              ) : null}
            </CardTitle>
            <CardDescription>
              Refine os pedidos por busca, status, canal, período e valor.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={onClear}
            disabled={!canClear}
          >
            Limpar filtros
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div className="space-y-2 xl:col-span-2">
            <label className="text-sm font-medium" htmlFor="orders-search">
              Buscar
            </label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="orders-search"
                placeholder="Cliente ou nº do pedido..."
                value={searchInput}
                onChange={(event) => onSearchInputChange(event.target.value)}
                className="h-10 rounded-full border border-border/70 bg-muted/20 pl-9"
                aria-label="Buscar pedidos"
              />
              {isFetching ? (
                <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
              ) : null}
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Status</label>
            <Select
              value={filters.status || SELECT_ALL}
              onValueChange={(value) =>
                onUpdateFilter(
                  "status",
                  value === SELECT_ALL
                    ? ""
                    : (value as OrderFiltersState["status"]),
                )
              }
            >
              <SelectTrigger aria-label="Status do pedido">
                <SelectValue placeholder="Todos" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SELECT_ALL}>Todos</SelectItem>
                {Object.entries(ORDER_STATUS_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Marketplace</label>
            <Select
              value={filters.marketplace || SELECT_ALL}
              onValueChange={(value) =>
                onUpdateFilter(
                  "marketplace",
                  value === SELECT_ALL
                    ? ""
                    : (value as OrderFiltersState["marketplace"]),
                )
              }
            >
              <SelectTrigger aria-label="Marketplace">
                <SelectValue placeholder="Todos" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SELECT_ALL}>Todos</SelectItem>
                <SelectItem value="MERCADO_LIVRE">Mercado Livre</SelectItem>
                <SelectItem value="SHOPEE">Shopee</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="orders-date-from">
              Data de
            </label>
            <Input
              id="orders-date-from"
              type="date"
              value={filters.createdFrom}
              onChange={(event) =>
                onUpdateFilter("createdFrom", event.target.value)
              }
              aria-label="Data inicial"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="orders-date-to">
              Data até
            </label>
            <Input
              id="orders-date-to"
              type="date"
              value={filters.createdTo}
              onChange={(event) =>
                onUpdateFilter("createdTo", event.target.value)
              }
              aria-label="Data final"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Preço mínimo</label>
            <CurrencyInput
              value={filters.priceMin ? Number(filters.priceMin) : null}
              onChange={(value) =>
                onUpdateFilter("priceMin", value == null ? "" : String(value))
              }
              aria-label="Preço mínimo"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Preço máximo</label>
            <CurrencyInput
              value={filters.priceMax ? Number(filters.priceMax) : null}
              onChange={(value) =>
                onUpdateFilter("priceMax", value == null ? "" : String(value))
              }
              aria-label="Preço máximo"
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
