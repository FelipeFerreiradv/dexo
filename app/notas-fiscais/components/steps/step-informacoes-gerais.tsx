"use client";

import { useEffect, useState } from "react";
import { Control, Controller, FieldErrors, useWatch } from "react-hook-form";
import { useSession } from "next-auth/react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getApiBaseUrl } from "@/lib/api";
import type { NfeDraftFormData } from "../../lib/nfe-form-schema";
import {
  TIPO_OPERACAO_LABELS,
  FINALIDADE_LABELS,
  DESTINO_LABELS,
  IND_PRESENCA_LABELS,
  NATUREZA_OPERACAO_OPTIONS,
} from "../../lib/nfe-defaults";

interface Props {
  control: Control<NfeDraftFormData>;
  errors: FieldErrors<NfeDraftFormData>;
}

export function StepInformacoesGerais({ control, errors }: Props) {
  const { data: session } = useSession();
  const serie = useWatch({ control, name: "serie" });
  const [proximoNumero, setProximoNumero] = useState<number | null>(null);
  const [loadingNumero, setLoadingNumero] = useState(false);

  // Preview do próximo número para a série selecionada. Read-only — o número
  // definitivo é reservado atomicamente na emissão (pode mudar se outra nota
  // for emitida na mesma série antes desta).
  useEffect(() => {
    const email = session?.user?.email;
    const s = Number(serie);
    if (!email || !Number.isInteger(s) || s < 0 || s > 999) {
      setProximoNumero(null);
      return;
    }
    let cancelled = false;
    setLoadingNumero(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `${getApiBaseUrl()}/fiscal/nfe/proximo-numero?serie=${s}`,
          { headers: { email } },
        );
        const data = await res.json().catch(() => ({}));
        if (!cancelled) {
          setProximoNumero(res.ok ? (data?.proximoNumero ?? null) : null);
        }
      } catch {
        if (!cancelled) setProximoNumero(null);
      } finally {
        if (!cancelled) setLoadingNumero(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [serie, session?.user?.email]);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">
          Informações da NF-e
        </h3>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1">
            <label className="text-sm font-medium">Série *</label>
            <Controller
              control={control}
              name="serie"
              render={({ field }) => (
                <Input
                  {...field}
                  type="number"
                  min={1}
                  value={field.value ?? 1}
                  onChange={(e) => field.onChange(Number(e.target.value))}
                />
              )}
            />
            {errors.serie && (
              <p className="text-xs text-destructive">{errors.serie.message}</p>
            )}
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">Número</label>
            <Input
              value={
                loadingNumero
                  ? "Calculando…"
                  : proximoNumero != null
                    ? `Próximo nº: ${proximoNumero}`
                    : "Gerado na emissão"
              }
              disabled
              className="text-muted-foreground"
            />
            <p className="text-xs text-muted-foreground">
              Sequencial automático por série — atribuído na emissão.
            </p>
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">Tipo de operação *</label>
            <Controller
              control={control}
              name="tipoOperacao"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(TIPO_OPERACAO_LABELS).map(([k, v]) => (
                      <SelectItem key={k} value={k}>
                        {v}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">Finalidade *</label>
            <Controller
              control={control}
              name="finalidade"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(FINALIDADE_LABELS).map(([k, v]) => (
                      <SelectItem key={k} value={k}>
                        {v}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">Destino da operação *</label>
            <Controller
              control={control}
              name="destinoOperacao"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(DESTINO_LABELS).map(([k, v]) => (
                      <SelectItem key={k} value={k}>
                        {v}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">Indicador de presença *</label>
            <Controller
              control={control}
              name="indPresenca"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(IND_PRESENCA_LABELS).map(([k, v]) => (
                      <SelectItem key={k} value={k}>
                        {v}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          <div className="md:col-span-2 lg:col-span-3 space-y-1">
            <label className="text-sm font-medium">
              Natureza da operação *
            </label>
            <Controller
              control={control}
              name="naturezaOperacao"
              render={({ field }) => (
                <>
                  <Input
                    {...field}
                    value={field.value ?? ""}
                    placeholder="Ex: VENDA DE MERCADORIA"
                    list="natureza-options"
                  />
                  <datalist id="natureza-options">
                    {NATUREZA_OPERACAO_OPTIONS.map((opt) => (
                      <option key={opt} value={opt} />
                    ))}
                  </datalist>
                </>
              )}
            />
            {errors.naturezaOperacao && (
              <p className="text-xs text-destructive">
                {errors.naturezaOperacao.message}
              </p>
            )}
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">Número do pedido</label>
            <Controller
              control={control}
              name="numeroPedido"
              render={({ field }) => (
                <Input
                  {...field}
                  value={field.value ?? ""}
                  onChange={(e) => field.onChange(e.target.value || null)}
                  placeholder="Opcional"
                />
              )}
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">Intermediador</label>
            <Controller
              control={control}
              name="intermediador"
              render={({ field }) => (
                <Input
                  {...field}
                  value={field.value ?? ""}
                  onChange={(e) => field.onChange(e.target.value || null)}
                  placeholder="Opcional"
                />
              )}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
