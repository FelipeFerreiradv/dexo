"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface CurrencyInputProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "onChange" | "value"
> {
  value: number | null | undefined;
  onChange: (value: number | null) => void;
}

/**
 * Formata centavos (inteiro) para string BRL
 * Ex: 12345 → "123,45"
 */
function formatCentsToBRL(cents: number): string {
  if (cents === 0) return "0,00";

  const reais = Math.floor(cents / 100);
  const centavos = cents % 100;

  const reaisFormatted = reais.toLocaleString("pt-BR");
  const centavosFormatted = centavos.toString().padStart(2, "0");

  return `${reaisFormatted},${centavosFormatted}`;
}

/**
 * Formata número (decimal) para string BRL
 * Ex: 123.45 → "123,45"
 */
function formatToBRL(value: number | null | undefined): string {
  if (value === null || value === undefined || isNaN(value)) return "";
  return new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/**
 * Converte valor decimal para centavos (inteiro)
 * Ex: 123.45 → 12345
 */
function toCents(value: number | null | undefined): number {
  if (value === null || value === undefined || isNaN(value)) return 0;
  return Math.round(value * 100);
}

/**
 * Converte centavos para decimal
 * Ex: 12345 → 123.45
 */
function fromCents(cents: number): number {
  return cents / 100;
}

const CurrencyInput = React.forwardRef<HTMLInputElement, CurrencyInputProps>(
  ({ className, value, onChange, ...props }, ref) => {
    // Armazena valor em centavos para facilitar manipulação
    const [cents, setCents] = React.useState(() => toCents(value));

    // Sincroniza com value externo
    React.useEffect(() => {
      setCents(toCents(value));
    }, [value]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const rawValue = e.target.value;

      // Remove tudo que não é número
      const onlyDigits = rawValue.replace(/\D/g, "");

      // Converte para número (centavos)
      const newCents = parseInt(onlyDigits, 10) || 0;

      // Limita a um valor máximo razoável (999.999.999,99)
      const limitedCents = Math.min(newCents, 99999999999);

      setCents(limitedCents);

      // Notifica o valor em reais (decimal)
      onChange(limitedCents === 0 ? null : fromCents(limitedCents));
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Permite: Backspace, Delete, Tab, Escape, Enter, setas
      const allowedKeys = [
        "Backspace",
        "Delete",
        "Tab",
        "Escape",
        "Enter",
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
      ];

      if (allowedKeys.includes(e.key)) {
        return;
      }

      // Permite Ctrl+A, Ctrl+C, Ctrl+V, Ctrl+X
      if (e.ctrlKey || e.metaKey) {
        return;
      }

      // Bloqueia se não for número
      if (!/^\d$/.test(e.key)) {
        e.preventDefault();
      }
    };

    const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
      // Move cursor para o final
      setTimeout(() => {
        const len = e.target.value.length;
        e.target.setSelectionRange(len, len);
      }, 0);
    };

    return (
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
          R$
        </span>
        <Input
          ref={ref}
          type="text"
          inputMode="numeric"
          className={cn("pl-10", className)}
          value={formatCentsToBRL(cents)}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={handleFocus}
          {...props}
        />
      </div>
    );
  },
);

CurrencyInput.displayName = "CurrencyInput";

export { CurrencyInput, formatToBRL };
