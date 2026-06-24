"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";

/**
 * Converte o texto digitado num número (reais) para o formulário fiscal.
 *
 * Aceita "." ou "," como separador decimal (a NF-e armazena um número simples,
 * sem separador de milhar). Vazio/sem dígito → 0 — preserva o contrato do
 * `<input type="number">` anterior, cujo onChange fazia `Number(e.target.value)`
 * e `Number("") === 0`.
 *
 *   "50" → 50   "1234,56" → 1234.56   "1234.56" → 1234.56   "0,50" → 0.5
 *   "" / "R$" → 0
 */
export function parseValorInput(raw: string): number {
  const cleaned = String(raw ?? "").replace(/[^\d.,]/g, "");
  if (!/\d/.test(cleaned)) return 0;
  // Vírgula → ponto. Se sobrar mais de um ponto, o primeiro é o decimal e os
  // demais são descartados (este campo não recebe separador de milhar).
  const dotted = cleaned.replace(/,/g, ".");
  const firstDot = dotted.indexOf(".");
  const normalized =
    firstDot === -1
      ? dotted
      : `${dotted.slice(0, firstDot)}.${dotted
          .slice(firstDot + 1)
          .replace(/\./g, "")}`;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
}

/** Texto exibido a partir do número. 0/null/NaN → "" (sem "0" à esquerda). */
function valorToText(value: number | null | undefined): string {
  if (
    value === null ||
    value === undefined ||
    Number.isNaN(value) ||
    value === 0
  ) {
    return "";
  }
  return String(value);
}

interface ValorInputProps
  extends Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    "value" | "onChange"
  > {
  value: number | null | undefined;
  onChange: (value: number) => void;
}

/**
 * Input de valor (R$) do wizard fiscal. Entrada NATURAL: começa vazio quando o
 * valor é 0 (em vez de mostrar "0"), então digitar "50" resulta em 50 — e não
 * "050". Mantém o texto enquanto o campo está focado (permite digitar "0,50");
 * normaliza a exibição ao sair (blur).
 *
 * Contrato idêntico ao `<input type="number">` anterior: `value`/`onChange` em
 * número (reais); vazio → 0.
 */
export const ValorInput = React.forwardRef<HTMLInputElement, ValorInputProps>(
  ({ value, onChange, onFocus, onBlur, ...props }, ref) => {
    const [focused, setFocused] = React.useState(false);
    const [text, setText] = React.useState<string>(() => valorToText(value));

    // Sincroniza com o valor externo só quando NÃO está focado — assim não
    // brigamos com a digitação (ex.: "0," intermediário não vira "").
    React.useEffect(() => {
      if (!focused) setText(valorToText(value));
    }, [value, focused]);

    return (
      <Input
        {...props}
        ref={ref}
        type="text"
        inputMode="decimal"
        value={text}
        onChange={(e) => {
          const cleaned = e.target.value.replace(/[^\d.,]/g, "");
          setText(cleaned);
          onChange(parseValorInput(cleaned));
        }}
        onFocus={(e) => {
          setFocused(true);
          // Seleciona tudo para que digitar SUBSTITUA o valor pré-preenchido
          // (ex.: Quantidade default 1 → digitar 5 dá 5, não "15").
          const el = e.target;
          setTimeout(() => {
            try {
              el.select();
            } catch {
              /* no-op */
            }
          }, 0);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          setText(valorToText(parseValorInput(text)));
          onBlur?.(e);
        }}
      />
    );
  },
);

ValorInput.displayName = "ValorInput";
