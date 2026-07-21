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
import { HighlightText } from "@/app/localizacoes/components/highlight-text";
import { tokenize } from "@/app/localizacoes/lib/search-utils";
import {
  buildLocationSearchIndex,
  filterLocationIndex,
  type LocationSelectItem,
} from "@/app/produtos/lib/location-select-filter";

export type { LocationSelectItem } from "@/app/produtos/lib/location-select-filter";

interface Props {
  options: LocationSelectItem[];
  /** id da localização selecionada, ou null para "Nenhuma". */
  value: string | null;
  /** Recebe o id (ou null) e o fullPath da opção escolhida. */
  onChange: (id: string | null, fullPath: string) => void;
  disabled?: boolean;
  id?: string;
  /**
   * Permite escolher uma localização lotada. A capacidade conta PRODUTOS, não
   * filhas — uma prateleira cheia de peças ainda pode receber sub-localizações,
   * então quem escolhe uma localização-mãe passa `allowFull`. Omitido =
   * comportamento atual (lotada bloqueada), inalterado.
   */
  allowFull?: boolean;
}

/**
 * Seletor de localização com busca (Popover + Command), reutilizado pelos modais
 * de criar e editar produto. Espelha `cfop-combobox.tsx`. Preserva os
 * comportamentos do <Select> anterior: grava o id, exibe (count/max) + "Lotado",
 * desabilita localizações lotadas EXCETO a já selecionada (isenção do editar) e
 * oferece a opção "Nenhuma".
 */
export function LocationCombobox({
  options,
  value,
  onChange,
  disabled,
  id,
  allowFull,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  // Índice pré-normalizado: reconstruído só quando `options` muda (não por tecla).
  const searchIndex = useMemo(() => buildLocationSearchIndex(options), [options]);
  const filtered = useMemo(
    () => filterLocationIndex(searchIndex, query),
    [searchIndex, query],
  );
  const tokens = useMemo(() => tokenize(query), [query]);

  const selected = value ? options.find((l) => l.id === value) : undefined;

  const pick = (nextId: string | null, fullPath: string) => {
    onChange(nextId, fullPath);
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
            "w-full justify-between font-normal",
            !selected && "text-muted-foreground",
          )}
        >
          <span className="truncate">
            {selected ? selected.fullPath : "Selecione uma localização"}
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
            placeholder="Buscar por código, descrição ou caminho..."
          />
          {/* overflow-x-auto vence overflow-x-hidden da primitiva (twMerge);
              vertical (overflow-y-auto + max-h) permanece. No mobile o caminho
              hierárquico longo agora rola para o lado em vez de truncar. */}
          <CommandList className="overflow-x-auto max-h-[min(300px,60vh)]">
            <CommandEmpty>Nenhuma localização encontrada.</CommandEmpty>
            <CommandItem
              value="__none__"
              className="min-w-full w-max"
              onSelect={() => pick(null, "")}
            >
              <Check
                className={cn(
                  "mr-2 h-4 w-4 shrink-0",
                  !value ? "opacity-100" : "opacity-0",
                )}
              />
              <span className="text-sm text-muted-foreground">Nenhuma</span>
            </CommandItem>
            {filtered.map((loc) => {
              // Lotada e NÃO é a já selecionada → bloqueada (isenção do editar).
              // `allowFull` libera o bloqueio para quem escolhe uma mãe.
              const blocked = !allowFull && loc.isFull && loc.id !== value;
              return (
                <CommandItem
                  key={loc.id}
                  value={loc.id}
                  disabled={blocked}
                  className="min-w-full w-max"
                  onSelect={() => {
                    if (blocked) return;
                    pick(loc.id, loc.fullPath);
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4 shrink-0",
                      value === loc.id ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="whitespace-nowrap text-sm">
                    <HighlightText text={loc.fullPath} tokens={tokens} />
                  </span>
                  <span className="ml-2 shrink-0 text-xs text-muted-foreground">
                    {loc.maxCapacity > 0
                      ? ` (${loc.productsCount}/${loc.maxCapacity})`
                      : ""}
                    {blocked ? " — Lotado" : ""}
                  </span>
                </CommandItem>
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
