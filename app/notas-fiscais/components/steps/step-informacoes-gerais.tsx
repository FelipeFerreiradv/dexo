"use client";

import { useEffect, useState } from "react";
import { Control, Controller, FieldErrors, useWatch } from "react-hook-form";
import { useSession } from "next-auth/react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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

// Multi-CNPJ: opção de emitente (mesma forma do CompanyOption do wizard).
interface CompanyOptionLike {
  id: string;
  cnpj: string;
  razaoSocial: string;
  nomeFantasia?: string | null;
  isDefault?: boolean;
  serieNfe?: number;
}

interface Props {
  control: Control<NfeDraftFormData>;
  errors: FieldErrors<NfeDraftFormData>;
  // Multi-CNPJ (opcionais — ausentes, o passo renderiza EXATAMENTE como antes)
  companies?: CompanyOptionLike[];
  selectedCompanyId?: string | null;
  onCompanyChange?: (companyId: string) => void;
}

function formatCnpj(cnpj: string): string {
  const d = (cnpj ?? "").replace(/\D/g, "");
  if (d.length !== 14) return cnpj;
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

export function StepInformacoesGerais({
  control,
  errors,
  companies,
  selectedCompanyId,
  onCompanyChange,
}: Props) {
  const { data: session } = useSession();
  const serie = useWatch({ control, name: "serie" });
  const [proximoNumero, setProximoNumero] = useState<number | null>(null);
  const [loadingNumero, setLoadingNumero] = useState(false);

  // Seletor de emitente SÓ com 2+ empresas — tenant de 1 CNPJ nem percebe.
  const showCompanySelector = (companies?.length ?? 0) > 1;

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
        // Multi-CNPJ: com 2+ empresas o preview é do EMITENTE selecionado.
        const companyQs =
          showCompanySelector && selectedCompanyId
            ? `&companyId=${encodeURIComponent(selectedCompanyId)}`
            : "";
        const res = await fetch(
          `${getApiBaseUrl()}/fiscal/nfe/proximo-numero?serie=${s}${companyQs}`,
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
  }, [serie, session?.user?.email, selectedCompanyId, showCompanySelector]);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">
          Informações da NF-e
        </h3>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {showCompanySelector && (
            <div className="md:col-span-2 lg:col-span-3 space-y-1">
              <label className="text-sm font-medium">Emitente (CNPJ) *</label>
              <Select
                value={selectedCompanyId ?? undefined}
                onValueChange={(v) => onCompanyChange?.(v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Selecione o CNPJ emissor" />
                </SelectTrigger>
                <SelectContent>
                  {(companies ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {`${c.nomeFantasia || c.razaoSocial} — ${formatCnpj(c.cnpj)}${c.isDefault ? " (padrão)" : ""}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                A nota será emitida por este CNPJ (certificado e numeração
                próprios).
              </p>
            </div>
          )}

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

          <div className="space-y-1 md:col-span-2 lg:col-span-3">
            <label className="text-sm font-medium">Observações</label>
            <Controller
              control={control}
              name="informacoesComplementares"
              render={({ field }) => (
                <Textarea
                  {...field}
                  value={field.value ?? ""}
                  onChange={(e) => field.onChange(e.target.value || null)}
                  placeholder="Opcional"
                  maxLength={5000}
                  rows={3}
                />
              )}
            />
            <p className="text-xs text-muted-foreground">
              Aparecem na NF-e e no DANFE, visíveis para o cliente
            </p>
            {errors.informacoesComplementares && (
              <p className="text-xs text-destructive">
                {errors.informacoesComplementares.message}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
