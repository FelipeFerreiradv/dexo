"use client";

import { Control, Controller, FieldErrors, useWatch } from "react-hook-form";
import { Info } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { FiscalConfigFormData } from "../../lib/fiscal-config-schema";
import {
  CertificateUploadCard,
  type CertificateStatus,
} from "./certificate-upload";

interface Props {
  control: Control<FiscalConfigFormData>;
  errors: FieldErrors<FiscalConfigFormData>;
  productionUnlocked: boolean;
  userEmail: string | null | undefined;
  configExists: boolean;
  certStatus: CertificateStatus | null;
  onCertUploaded: (status: CertificateStatus) => void;
  providerTokenConfigured: boolean;
}

export function FiscalEnvironmentStep({
  control,
  errors,
  productionUnlocked,
  userEmail,
  configExists,
  certStatus,
  onCertUploaded,
  providerTokenConfigured,
}: Props) {
  const providerName = useWatch({ control, name: "providerName" });
  const uf = useWatch({ control, name: "uf" });
  const isSefazDirect = providerName === "SEFAZ_DIRECT";

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
                  <SelectItem value="SEFAZ_DIRECT">SEFAZ Direto</SelectItem>
                  <SelectItem value="FOCUS_NFE">Focus NFe</SelectItem>
                </SelectContent>
              </Select>
            )}
          />
          <p className="text-xs text-muted-foreground">
            {isSefazDirect
              ? "Emissão direta à SEFAZ com seu certificado A1 (sem intermediário)."
              : "Emissão via API Focus NFe (intermediário)."}
          </p>
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium">Série padrão da NF-e</label>
          <Controller
            control={control}
            name="serieNfe"
            render={({ field }) => (
              <Input
                type="number"
                min={1}
                max={999}
                value={field.value ?? 1}
                onChange={(e) => field.onChange(Number(e.target.value))}
              />
            )}
          />
          {errors.serieNfe && (
            <p className="text-xs text-destructive">
              {errors.serieNfe.message}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Toda nota nova já vem nesta série. O número é sequencial automático
            por série — você não precisa controlar manualmente.
          </p>
        </div>

        {/* Token Focus — só quando o provedor é Focus NFe */}
        {!isSefazDirect && (
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
                  placeholder={
                    providerTokenConfigured
                      ? "•••••••• (token salvo — deixe em branco para manter)"
                      : "Token de acesso à API Focus NFe"
                  }
                  autoComplete="off"
                />
              )}
            />
            <p className="text-xs text-muted-foreground">
              {providerTokenConfigured
                ? "Há um token salvo. Deixe o campo em branco para mantê-lo, ou digite um novo para substituir."
                : "Gere em focusnfe.com.br → Painel → Tokens de acesso."}
            </p>
          </div>
        )}
      </div>

      {/* Certificado A1 — só quando o provedor é SEFAZ Direto */}
      {isSefazDirect ? (
        <CertificateUploadCard
          userEmail={userEmail}
          configExists={configExists}
          uf={uf}
          status={certStatus}
          onUploaded={onCertUploaded}
        />
      ) : (
        <div className="rounded-xl border border-border/60 bg-muted/30 p-4 text-sm">
          <div className="flex items-start gap-2">
            <Info className="mt-0.5 h-4 w-4 text-muted-foreground" />
            <div className="space-y-1">
              <p className="font-medium text-foreground">Certificado digital A1</p>
              <p className="text-xs text-muted-foreground">
                No provedor Focus NFe o certificado é cadastrado no painel deles.
                Para enviar o .pfx aqui no Dexo, selecione o provedor{" "}
                <span className="font-medium">SEFAZ Direto</span>.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-border/60 bg-muted/30 p-4 text-sm">
        <div className="flex items-start gap-2">
          <Info className="mt-0.5 h-4 w-4 text-muted-foreground" />
          <div className="space-y-1">
            <p className="font-medium text-foreground">
              Produção exige validação
            </p>
            <p className="text-xs text-muted-foreground">
              Valide a emissão em homologação com seu contador antes de mudar o
              ambiente para Produção. Garanta que todos os dados do emissor e o
              certificado estejam corretos.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
