"use client";

import { Control, Controller, FieldErrors } from "react-hook-form";
import { Info, Lock } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { FiscalConfigFormData } from "../../lib/fiscal-config-schema";

interface Props {
  control: Control<FiscalConfigFormData>;
  errors: FieldErrors<FiscalConfigFormData>;
  productionUnlocked: boolean;
}

export function FiscalEnvironmentStep({
  control,
  errors,
  productionUnlocked,
}: Props) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="space-y-1">
          <label className="text-sm font-medium">Ambiente *</label>
          <Controller
            control={control}
            name="ambiente"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecione" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="HOMOLOGACAO">Homologação</SelectItem>
                  <SelectItem value="PRODUCAO" disabled={!productionUnlocked}>
                    Produção{!productionUnlocked ? " (bloqueado)" : ""}
                  </SelectItem>
                </SelectContent>
              </Select>
            )}
          />
          {errors.ambiente && (
            <p className="text-xs text-destructive">
              {errors.ambiente.message}
            </p>
          )}
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium">Provedor fiscal</label>
          <Controller
            control={control}
            name="providerName"
            render={({ field }) => (
              <Select
                value={field.value ?? "FOCUS_NFE"}
                onValueChange={field.onChange}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Selecione" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="FOCUS_NFE">Focus NFe</SelectItem>
                </SelectContent>
              </Select>
            )}
          />
        </div>

        <div className="md:col-span-2 space-y-1">
          <label className="text-sm font-medium">Token do provedor</label>
          <Controller
            control={control}
            name="providerToken"
            render={({ field }) => (
              <Input
                {...field}
                value={field.value ?? ""}
                type="password"
                placeholder="Token de acesso à API Focus NFe"
                autoComplete="off"
              />
            )}
          />
          <p className="text-xs text-muted-foreground">
            Gere em <span className="font-mono">focusnfe.com.br</span> → Painel
            → Tokens de acesso.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-amber-400/40 bg-amber-400/5 p-4 text-sm">
        <div className="flex items-start gap-2">
          <Lock className="h-4 w-4 mt-0.5 text-amber-500" />
          <div className="space-y-1">
            <p className="font-medium text-foreground">
              Certificado digital A1
            </p>
            <p className="text-xs text-muted-foreground">
              Upload do certificado .pfx e senha serão habilitados na próxima
              etapa do módulo fiscal (emissão). Até lá, o provedor Focus NFe
              armazena o certificado no painel dele.
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border/60 bg-muted/30 p-4 text-sm">
        <div className="flex items-start gap-2">
          <Info className="h-4 w-4 mt-0.5 text-muted-foreground" />
          <div className="space-y-1">
            <p className="font-medium text-foreground">MVP em homologação</p>
            <p className="text-xs text-muted-foreground">
              A emissão em produção permanece bloqueada até validação com
              contador. Libere apenas após garantir que todos os dados do
              emissor e do certificado estejam corretos.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
