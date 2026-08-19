"use client";

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { CANCEL_NOTE_MAX, CANCEL_REASONS } from "../../lib/cancel-reasons";

// BLOCO D — campo de motivo dentro do diálogo de confirmação do cancelamento.
//
// OPCIONAL por decisão de produto (o cliente pediu obrigatório). Isso tem uma
// consequência de UX que não é óbvia: se o motivo é opcional, o campo NÃO pode
// atrapalhar quem só quer cancelar. Por isso nada aqui é obrigatório, nada
// bloqueia o botão e o padrão é "não informar" — quem quiser justificar,
// justifica; quem não quiser, segue em um clique como sempre seguiu.
//
// Compartilhado entre o Financeiro e o menu do PDV pelo mesmo motivo do
// SaleStatusFilter: dois diálogos, um comportamento, idêntico por construção.

// Radix Select não aceita value="" — sentinela para "nenhum motivo".
const NENHUM = "__none__";

export interface CancelReasonValue {
  code: string | null;
  note: string;
}

export const EMPTY_CANCEL_REASON: CancelReasonValue = { code: null, note: "" };

interface Props {
  value: CancelReasonValue;
  onChange: (v: CancelReasonValue) => void;
  disabled?: boolean;
}

export function CancelReasonField({ value, onChange, disabled }: Props) {
  return (
    <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="space-y-1.5">
        <Label
          htmlFor="cancel-reason-code"
          className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground"
        >
          Motivo (opcional)
        </Label>
        <Select
          value={value.code ?? NENHUM}
          disabled={disabled}
          onValueChange={(v) =>
            onChange({ ...value, code: v === NENHUM ? null : v })
          }
        >
          <SelectTrigger id="cancel-reason-code" className="h-9">
            <SelectValue placeholder="Não informar" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NENHUM}>Não informar</SelectItem>
            {CANCEL_REASONS.map((r) => (
              <SelectItem key={r.code} value={r.code}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label
          htmlFor="cancel-reason-note"
          className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground"
        >
          Observação
        </Label>
        <Textarea
          id="cancel-reason-note"
          rows={2}
          // O backend trunca em CANCEL_NOTE_MAX na fronteira; limitar aqui
          // evita que o operador escreva um texto que seria cortado sem aviso.
          maxLength={CANCEL_NOTE_MAX}
          disabled={disabled}
          placeholder="Detalhe se precisar (fica registrado no histórico da venda)"
          value={value.note}
          onChange={(e) => onChange({ ...value, note: e.target.value })}
          className="resize-none text-sm"
        />
      </div>
    </div>
  );
}
