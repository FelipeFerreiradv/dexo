"use client";

import { useMemo, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  cfopDigits,
  findCfop,
  getCfopsByTipo,
  type CfopTipo,
} from "@/app/fiscal/domain/cfop-catalog";
import { matchesTokens, tokenize } from "@/app/localizacoes/lib/search-utils";

interface Props {
  /** Código CFOP atual (4 dígitos) ou string vazia. */
  value: string;
  /** Chamado com o código selecionado (4 dígitos). */
  onChange: (codigo: string) => void;
  /** Tipo de operação da nota — filtra ENTRADA (1/2/3) vs SAIDA (5/6/7). */
  tipo: CfopTipo;
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
}

// A lista oficial é grande; limitamos o que é renderizado por busca para
// manter o combobox leve. O filtro por tipo já reduz para ~250-290 itens, e a
// busca textual normalmente recorta para poucas dezenas.
const MAX_RESULTS = 60;

export function CfopCombobox({
  value,
  onChange,
  tipo,
  disabled,
  invalid,
  id,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const list = useMemo(() => getCfopsByTipo(tipo), [tipo]);

  const filtered = useMemo(() => {
    const tokens = tokenize(query);
    const result = list.filter((c) =>
      matchesTokens(tokens, { code: c.codigo, description: c.descricao }),
    );
    return result.slice(0, MAX_RESULTS);
  }, [list, query]);

  const selected = value ? findCfop(value) : undefined;

  // Permite manter um CFOP de 4 dígitos fora do catálogo (paridade com o input
  // de texto livre anterior — zero regressão; a validação real é na emissão).
  const typedDigits = cfopDigits(query);
  const showCustom =
    typedDigits.length === 4 && !findCfop(typedDigits) && !value;

  const pick = (codigo: string) => {
    onChange(codigo);
    setQuery("");
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            "h-8 w-full justify-between text-sm font-normal",
            !value && "text-muted-foreground",
            invalid && "border-destructive",
          )}
        >
          <span className="truncate">
            {value
              ? selected
                ? `${value} — ${selected.descricao}`
                : `${value} (personalizado)`
              : "Selecione o CFOP"}
          </span>
          <ChevronsUpDown className="ml-1 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-(--radix-popover-trigger-width) min-w-[calc(100vw-1.5rem)] p-0 sm:min-w-[340px]"
      >
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Buscar por código ou descrição..."
          />
          <CommandList>
            <CommandEmpty>Nenhum CFOP encontrado.</CommandEmpty>
            {showCustom && (
              <CommandItem
                value={`custom-${typedDigits}`}
                onSelect={() => pick(typedDigits)}
              >
                <Check className="mr-2 h-4 w-4 opacity-0" />
                <span className="text-sm">
                  Usar CFOP{" "}
                  <span className="font-mono font-medium">{typedDigits}</span>{" "}
                  (personalizado)
                </span>
              </CommandItem>
            )}
            {filtered.map((c) => (
              <CommandItem
                key={c.codigo}
                value={c.codigo}
                onSelect={() => pick(c.codigo)}
              >
                <Check
                  className={cn(
                    "mr-2 h-4 w-4 shrink-0",
                    value === c.codigo ? "opacity-100" : "opacity-0",
                  )}
                />
                <span className="font-mono text-xs">{c.codigo}</span>
                <span className="ml-2 truncate text-xs text-muted-foreground">
                  {c.descricao}
                </span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
