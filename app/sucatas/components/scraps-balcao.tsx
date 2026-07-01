"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { Search, Loader2, PackageCheck, Truck, PackageX } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { getApiBaseUrl } from "@/lib/api";
import { LOGISTICS_CONFIG, type LogisticsStatus } from "../lib/logistics";

interface BalcaoSource {
  scrapId: string;
  brand: string;
  model: string;
  year?: string;
  plate?: string;
  logisticsStatus: LogisticsStatus;
}

interface BalcaoPart {
  id: string;
  name: string;
  sku: string;
  partNumber?: string;
  price: number;
  stock: number;
  source: BalcaoSource | null;
}

const priceFmt = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

export function ScrapsBalcao() {
  const { data: session } = useSession();
  const email = session?.user?.email;

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<BalcaoPart[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const term = query.trim();
    if (!email || term.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const ctrl = new AbortController();
    const handle = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: term, limit: "20" });
        const res = await fetch(
          `${getApiBaseUrl()}/scraps/balcao?${params.toString()}`,
          { headers: { email }, signal: ctrl.signal },
        );
        if (!res.ok) throw new Error("Erro na busca");
        const data = await res.json();
        setResults(data.results ?? []);
      } catch (err) {
        if ((err as { name?: string })?.name !== "AbortError") setResults([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => {
      ctrl.abort();
      clearTimeout(handle);
    };
  }, [query, email]);

  const term = query.trim();

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar peça por nome, SKU ou part number... (ex.: farol gol, fechadura palio)"
          className="h-11 pl-10 text-base"
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Buscando peças...
        </div>
      ) : term.length < 2 ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          Digite o nome de uma peça para ver se está disponível e em qual lote.
        </div>
      ) : results.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          Nenhuma peça encontrada para “{term}”.
        </div>
      ) : (
        <div className="grid gap-3">
          {results.map((p) => (
            <BalcaoCard key={p.id} part={p} />
          ))}
        </div>
      )}
    </div>
  );
}

function BalcaoCard({ part }: { part: BalcaoPart }) {
  const inStock = part.stock > 0;
  const src = part.source;
  const conf = src ? LOGISTICS_CONFIG[src.logisticsStatus] : undefined;
  const StageIcon = conf?.icon;

  let avail: { label: string; cls: string; Icon: typeof PackageCheck };
  if (!inStock) {
    avail = {
      label: "Esgotado",
      cls: "text-muted-foreground",
      Icon: PackageX,
    };
  } else if (src && conf && !conf.available) {
    avail = {
      label: "Carro em trânsito",
      cls: "text-amber-600 dark:text-amber-400",
      Icon: Truck,
    };
  } else {
    avail = {
      label: "Disponível agora",
      cls: "text-emerald-600 dark:text-emerald-400",
      Icon: PackageCheck,
    };
  }
  const AvailIcon = avail.Icon;

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          <div className="font-medium leading-tight">{part.name}</div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline" className="font-mono text-[11px]">
              {part.sku}
            </Badge>
            {part.partNumber ? (
              <span className="font-mono">PN {part.partNumber}</span>
            ) : null}
            <span className="font-mono font-semibold tabular-nums text-foreground">
              {priceFmt.format(part.price)}
            </span>
            <span>{inStock ? `${part.stock} em estoque` : "sem estoque"}</span>
          </div>
          {src ? (
            <Link
              href={`/sucatas/${src.scrapId}`}
              className="inline-flex flex-wrap items-center gap-2 text-xs text-muted-foreground hover:underline"
            >
              <span>
                Lote: {src.brand} {src.model}
                {src.year ? ` ${src.year}` : ""}
                {src.plate ? ` · ${src.plate}` : ""}
              </span>
              {conf ? (
                <Badge variant="outline" className={conf.badgeClass}>
                  {StageIcon ? <StageIcon className="mr-1 size-3" /> : null}
                  {conf.label}
                </Badge>
              ) : null}
            </Link>
          ) : (
            <div className="text-xs text-muted-foreground">
              Sem lote de origem vinculado.
            </div>
          )}
        </div>
        <div
          className={`flex shrink-0 items-center gap-1.5 text-sm font-semibold ${avail.cls}`}
        >
          <AvailIcon className="size-4" />
          {avail.label}
        </div>
      </CardContent>
    </Card>
  );
}
