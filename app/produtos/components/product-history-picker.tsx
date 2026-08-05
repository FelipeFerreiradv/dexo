"use client";

import { History, Info, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";

import { describeSnapshot } from "../lib/apply-product-history";
import type { ProductFormSnapshot } from "../lib/product-form-snapshot";

interface ProductHistoryPickerProps {
  entries: ProductFormSnapshot[];
  onApply: (snapshot: ProductFormSnapshot) => void;
  onClear: () => void;
  disabled?: boolean;
}

/**
 * "Usar último cadastro" — reaproveita um cadastro recente para as peças
 * seguintes (farol esquerdo, farol direito, farol lado motorista...).
 *
 * Card inline com o MESMO vocabulário visual do `InternalSuggestionPicker`
 * (borda tracejada, fundo suave, ícone + título, botão de ação à direita) para
 * o usuário não perceber duas mecânicas diferentes de "preencher a partir de
 * algo". Muda só a cor — âmbar é a sugestão da base interna, azul é o histórico
 * do próprio usuário.
 */
export function ProductHistoryPicker({
  entries,
  onApply,
  onClear,
  disabled,
}: ProductHistoryPickerProps) {
  if (entries.length === 0) return null;

  const agora = Date.now();

  return (
    <div className="space-y-2 rounded-md border border-dashed border-sky-500/50 bg-sky-500/5 p-3">
      <div className="flex items-center gap-2">
        <History className="size-4 text-sky-600 dark:text-sky-400" />
        <span className="text-sm font-medium">Cadastros recentes</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto h-7 gap-1 px-2 text-xs text-muted-foreground"
          onClick={onClear}
          disabled={disabled}
        >
          <Trash2 className="size-3" />
          Limpar
        </Button>
      </div>

      <ul className="space-y-1.5">
        {entries.map((snapshot, index) => (
          <li
            key={`${snapshot.savedAt}-${index}`}
            className="flex items-center gap-2"
          >
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {describeSnapshot(snapshot, agora)}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 shrink-0 px-2 text-xs"
              onClick={() => onApply(snapshot)}
              disabled={disabled}
            >
              {index === 0 ? "Usar último" : "Usar este"}
            </Button>
          </li>
        ))}
      </ul>

      <p className="flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground">
        <Info className="mt-0.5 size-3 shrink-0" />
        Preenche só os campos vazios. SKU, imagens e custo nunca são copiados.
      </p>
    </div>
  );
}
