"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Search, Car, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Command,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { getApiBaseUrl } from "@/lib/api";
import { LOGISTICS_CONFIG, type LogisticsStatus } from "../lib/logistics";

interface SearchScrap {
  id: string;
  brand: string;
  model: string;
  year?: string;
  plate?: string;
  logisticsStatus: LogisticsStatus;
  productsCount?: number;
}

// Estilos do command palette (espelham o CommandDialog padrão do design system).
const COMMAND_CLASS =
  "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5";

export function ScrapSearch() {
  const router = useRouter();
  const { data: session } = useSession();
  const email = session?.user?.email;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchScrap[]>([]);
  const [loading, setLoading] = useState(false);

  // Atalho ⌘K / Ctrl+K
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Busca server-side com debounce. shouldFilter={false} no Command garante que
  // exibimos exatamente o que o backend retornou (sem re-filtrar no cliente).
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!email || q.length < 1) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const handle = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ search: q, limit: "8" });
        const res = await fetch(
          `${getApiBaseUrl()}/scraps?${params.toString()}`,
          { headers: { email } },
        );
        if (!res.ok) throw new Error("Erro na busca");
        const data = await res.json();
        setResults(data.scraps ?? []);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [query, open, email]);

  const handleSelect = (id: string) => {
    setOpen(false);
    setQuery("");
    router.push(`/sucatas/${id}`);
  };

  const trimmed = query.trim();

  return (
    <>
      <Button
        variant="outline"
        onClick={() => setOpen(true)}
        className="gap-2 text-muted-foreground"
      >
        <Search className="size-4" />
        Buscar lote...
        <kbd className="ml-1 hidden rounded border bg-muted px-1.5 py-0.5 text-[10px] font-medium sm:inline">
          ⌘K
        </kbd>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="overflow-hidden p-0">
          <DialogHeader className="sr-only">
            <DialogTitle>Buscar lote</DialogTitle>
            <DialogDescription>
              Busque sucatas por marca, modelo, placa, chassi ou lote.
            </DialogDescription>
          </DialogHeader>
          <Command shouldFilter={false} className={COMMAND_CLASS}>
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder="Buscar lote por marca, modelo, placa... (ex.: Gol, Onix)"
            />
            <CommandList>
              {loading ? (
                <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  Buscando...
                </div>
              ) : trimmed.length === 0 ? (
                <div className="py-6 text-center text-sm text-muted-foreground">
                  Digite para buscar um lote.
                </div>
              ) : results.length === 0 ? (
                <div className="py-6 text-center text-sm text-muted-foreground">
                  Nenhum lote encontrado para “{trimmed}”.
                </div>
              ) : (
                <CommandGroup heading="Lotes">
                  {results.map((s) => {
                    const conf = LOGISTICS_CONFIG[s.logisticsStatus];
                    const StageIcon = conf?.icon ?? Car;
                    return (
                      <CommandItem
                        key={s.id}
                        value={s.id}
                        onSelect={() => handleSelect(s.id)}
                        className="flex items-center justify-between gap-3"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <Car className="size-4 shrink-0" />
                          <div className="min-w-0">
                            <div className="truncate font-medium">
                              {s.brand} {s.model}
                              {s.year ? ` · ${s.year}` : ""}
                            </div>
                            <div className="truncate text-xs text-muted-foreground">
                              {s.plate ? `Placa ${s.plate} · ` : ""}
                              {s.productsCount ?? 0} peça(s)
                            </div>
                          </div>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1">
                          <Badge variant="outline" className={conf?.badgeClass}>
                            <StageIcon className="mr-1 size-3" />
                            {conf?.label ?? s.logisticsStatus}
                          </Badge>
                          <span
                            className={cn(
                              "text-[10px] font-medium",
                              conf?.available
                                ? "text-emerald-600 dark:text-emerald-400"
                                : "text-amber-600 dark:text-amber-400",
                            )}
                          >
                            {conf?.available
                              ? "Disponível p/ retirada"
                              : "Em trânsito"}
                          </span>
                        </div>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  );
}
