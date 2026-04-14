"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { Check, ChevronsUpDown, Loader2, Search } from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getApiBaseUrl } from "@/lib/api";
import { maskCpf } from "@/app/lib/masks";
import { cn } from "@/lib/utils";

export interface CustomerOption {
  id: string;
  name: string;
  cpf: string | null;
}

interface Props {
  value: string | null;
  selectedLabel?: string | null;
  onChange: (customer: CustomerOption) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function CustomerCombobox({
  value,
  selectedLabel,
  onChange,
  disabled,
  placeholder = "Selecione um cliente",
}: Props) {
  const { data: session } = useSession();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [loading, setLoading] = useState(false);
  const [options, setOptions] = useState<CustomerOption[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const search = useCallback(async () => {
    const email = session?.user?.email;
    if (!email) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    try {
      const url = debounced
        ? `${getApiBaseUrl()}/customers/search?q=${encodeURIComponent(debounced)}`
        : `${getApiBaseUrl()}/customers?limit=20`;
      const res = await fetch(url, {
        headers: { email },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error("search failed");
      const data = await res.json();
      setOptions(data.customers || []);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setOptions([]);
    } finally {
      setLoading(false);
    }
  }, [session?.user?.email, debounced]);

  useEffect(() => {
    if (open) search();
  }, [open, search]);

  const handleSelect = (opt: CustomerOption) => {
    onChange(opt);
    setOpen(false);
    setQuery("");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          disabled={disabled}
          className="w-full justify-between font-normal"
        >
          <span className="truncate">
            {value ? selectedLabel || "Cliente selecionado" : placeholder}
          </span>
          <ChevronsUpDown className="h-4 w-4 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-(--radix-popover-trigger-width) p-0"
      >
        <div className="relative border-b border-border/60 p-2">
          <Search className="absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar por nome ou CPF..."
            className="h-9 pl-8"
          />
          {loading && (
            <Loader2 className="absolute right-4 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          )}
        </div>
        <div className="max-h-64 overflow-y-auto py-1">
          {options.length === 0 && !loading && (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              Nenhum cliente encontrado.
            </p>
          )}
          {options.map((opt) => (
            <button
              type="button"
              key={opt.id}
              onClick={() => handleSelect(opt)}
              className={cn(
                "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted",
                value === opt.id && "bg-muted/60",
              )}
            >
              <span className="flex flex-col">
                <span className="font-medium">{opt.name}</span>
                <span className="text-xs text-muted-foreground">
                  {opt.cpf ? maskCpf(opt.cpf) : "Sem CPF"}
                </span>
              </span>
              {value === opt.id && <Check className="h-4 w-4 text-primary" />}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
