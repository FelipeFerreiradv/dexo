"use client";

// BLOCO C — filtro por status da venda, com múltipla seleção.
//
// Componente ÚNICO, usado pela lista do Financeiro e pelo livro do dia do PDV:
// o vocabulário e a tradução para o `where` já são compartilhados
// (`lib/finance-status-filters.ts`), e a UI ser compartilhada é o que impede as
// duas telas de divergirem no rótulo ou no comportamento.
//
// Dropdown com checkbox em vez de `Select` porque o Radix Select é de escolha
// única; a pílula segue a mesma linguagem dos filtros vizinhos (altura 10,
// borda suave, cantos redondos).

import { ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SALE_STATUS_FILTERS,
  saleStatusFilterLabel,
  type SaleStatusFilterCode,
} from "@/app/lib/finance-status-filters";

export type { SaleStatusFilterCode };

interface Props {
  value: SaleStatusFilterCode[];
  onChange: (v: SaleStatusFilterCode[]) => void;
  className?: string;
}

export function SaleStatusFilter({ value, onChange, className }: Props) {
  const rotulo =
    value.length === 0
      ? "Todos os status"
      : value.length === 1
        ? saleStatusFilterLabel(value[0])
        : `${value.length} status`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className={
            className ??
            "h-10 w-full shrink-0 justify-between rounded-full border-border/70 bg-muted/20 font-normal sm:w-[210px]"
          }
        >
          {rotulo}
          <ChevronDown className="size-4 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[210px]">
        {SALE_STATUS_FILTERS.map((f) => (
          <DropdownMenuCheckboxItem
            key={f.code}
            checked={value.includes(f.code)}
            onCheckedChange={(on) =>
              onChange(
                on ? [...value, f.code] : value.filter((c) => c !== f.code),
              )
            }
            // Marcar vários seguidos é o caso de uso; fechar a cada clique
            // tornaria isso penoso. Fecha no clique fora.
            onSelect={(e) => e.preventDefault()}
          >
            {f.label}
          </DropdownMenuCheckboxItem>
        ))}
        {value.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onChange([])}>
              Limpar
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
