"use client";

// Multi-CNPJ — gestão de empresas (CNPJs) do tenant + vínculo de contas de
// marketplace ao CNPJ emissor. Sem rework visual: com 1 empresa e a flag
// desligada, renderiza APENAS o <FiscalConfigForm> legado (DOM idêntico ao
// anterior). A lista/gestão aparece quando o tenant tem 2+ empresas OU a flag
// NEXT_PUBLIC_MULTI_CNPJ_ENABLED está ligada (onboarding do 2º CNPJ).

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { Building2, Plus, Star, Trash2 } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToastViewport } from "@/components/ui/toast-viewport";
import { getApiBaseUrl } from "@/lib/api";

import { FiscalConfigForm } from "./fiscal-config-form";

// Referência literal para o Next inlinar no build.
const MULTI_CNPJ_ENABLED =
  process.env.NEXT_PUBLIC_MULTI_CNPJ_ENABLED === "true";

interface Company {
  id: string;
  cnpj: string;
  razaoSocial: string;
  nomeFantasia?: string | null;
  isDefault?: boolean;
  [key: string]: any;
}

interface MarketplaceAccount {
  id: string;
  platform: string;
  accountName: string;
  status: string;
  companyFiscalConfigId: string | null;
}

type Selection =
  | { mode: "default" }
  | { mode: "edit"; company: Company }
  | { mode: "create" };

function formatCnpj(cnpj: string): string {
  const d = (cnpj ?? "").replace(/\D/g, "");
  if (d.length !== 14) return cnpj;
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

const PLATFORM_LABELS: Record<string, string> = {
  MERCADO_LIVRE: "Mercado Livre",
  SHOPEE: "Shopee",
  MAGALU: "Magalu",
};

// Sentinela do item "CNPJ padrão" no Select de vínculo (o shadcn Select não
// aceita value="").
const DEFAULT_LINK = "__default__";

export function FiscalCompaniesManager({
  productionUnlocked,
}: {
  productionUnlocked: boolean;
}) {
  const { data: session } = useSession();
  const email = session?.user?.email ?? "";

  const [companies, setCompanies] = useState<Company[] | null>(null);
  const [accounts, setAccounts] = useState<MarketplaceAccount[]>([]);
  const [selection, setSelection] = useState<Selection>({ mode: "default" });
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [toast, setToast] = useState<{
    msg: string;
    type: "success" | "error";
  } | null>(null);

  const showToast = (msg: string, type: "success" | "error") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  };

  const loadCompanies = useCallback(async () => {
    if (!email) return;
    try {
      const res = await fetch(`${getApiBaseUrl()}/fiscal/companies`, {
        headers: { email },
      });
      const data = await res.json().catch(() => ({}));
      setCompanies(Array.isArray(data?.companies) ? data.companies : []);
    } catch {
      setCompanies([]);
    }
  }, [email]);

  const loadAccounts = useCallback(async () => {
    if (!email) return;
    try {
      const res = await fetch(`${getApiBaseUrl()}/fiscal/marketplace-accounts`, {
        headers: { email },
      });
      const data = await res.json().catch(() => ({}));
      if (Array.isArray(data?.accounts)) setAccounts(data.accounts);
    } catch {
      // silencioso — seção de contas simplesmente não aparece
    }
  }, [email]);

  useEffect(() => {
    loadCompanies();
  }, [loadCompanies]);

  const showManager =
    MULTI_CNPJ_ENABLED || (companies !== null && companies.length > 1);

  useEffect(() => {
    if (showManager) loadAccounts();
  }, [showManager, loadAccounts]);

  // Tenant de 1 CNPJ sem a flag: EXATAMENTE o form legado de antes.
  if (!showManager) {
    return <FiscalConfigForm productionUnlocked={productionUnlocked} />;
  }

  const list = companies ?? [];

  const handleSetDefault = async (id: string) => {
    try {
      const res = await fetch(
        `${getApiBaseUrl()}/fiscal/companies/${id}/default`,
        { method: "PUT", headers: { email } },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Erro ao definir padrão");
      showToast("Empresa padrão atualizada.", "success");
      await loadCompanies();
      setSelection({ mode: "default" });
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Erro ao definir padrão", "error");
    }
  };

  const handleDelete = async (id: string) => {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      setTimeout(() => setConfirmDeleteId(null), 4000);
      return;
    }
    setConfirmDeleteId(null);
    try {
      const res = await fetch(`${getApiBaseUrl()}/fiscal/companies/${id}`, {
        method: "DELETE",
        headers: { email },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Erro ao remover empresa");
      showToast("Empresa removida.", "success");
      await loadCompanies();
      setSelection({ mode: "default" });
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Erro ao remover empresa", "error");
    }
  };

  const handleLinkAccount = async (accountId: string, value: string) => {
    const companyFiscalConfigId = value === DEFAULT_LINK ? null : value;
    try {
      const res = await fetch(
        `${getApiBaseUrl()}/fiscal/marketplace-accounts/${accountId}/company`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json", email },
          body: JSON.stringify({ companyFiscalConfigId }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Erro ao vincular conta");
      setAccounts((prev) =>
        prev.map((a) =>
          a.id === accountId ? { ...a, companyFiscalConfigId } : a,
        ),
      );
      showToast("Vínculo atualizado — os pedidos desta conta emitirão por este CNPJ.", "success");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Erro ao vincular conta", "error");
    }
  };

  const selectedCompanyId =
    selection.mode === "edit" ? selection.company.id : null;

  return (
    <div className="space-y-6">
      {/* ── Empresas (CNPJs) do tenant ── */}
      <div className="rounded-2xl border border-border/60 bg-card/80 p-6 shadow-[0_18px_50px_-38px_rgba(0,0,0,0.45)] backdrop-blur">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Empresas emissoras
          </h3>
          {MULTI_CNPJ_ENABLED && (
            <button
              type="button"
              onClick={() => setSelection({ mode: "create" })}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 text-sm font-medium hover:bg-muted/60"
            >
              <Plus className="size-4" />
              Adicionar CNPJ
            </button>
          )}
        </div>

        <div className="space-y-2">
          {/* Empresa padrão sempre editável pelo fluxo legado */}
          {list.map((c) => {
            const isSelected = c.isDefault
              ? selection.mode === "default"
              : selectedCompanyId === c.id;
            return (
              <div
                key={c.id}
                className={
                  "flex items-center justify-between rounded-xl border px-4 py-3 " +
                  (isSelected
                    ? "border-primary/50 bg-primary/5"
                    : "border-border/60")
                }
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  onClick={() =>
                    setSelection(
                      c.isDefault
                        ? { mode: "default" }
                        : { mode: "edit", company: c },
                    )
                  }
                >
                  <Building2 className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate text-sm font-medium">
                    {c.nomeFantasia || c.razaoSocial}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatCnpj(c.cnpj)}
                  </span>
                  {c.isDefault && (
                    <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700">
                      Padrão
                    </span>
                  )}
                </button>
                {!c.isDefault && (
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      title="Tornar padrão"
                      onClick={() => handleSetDefault(c.id)}
                      className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    >
                      <Star className="size-4" />
                    </button>
                    <button
                      type="button"
                      title={
                        confirmDeleteId === c.id
                          ? "Clique de novo para confirmar"
                          : "Remover"
                      }
                      onClick={() => handleDelete(c.id)}
                      className={
                        "rounded-lg p-1.5 " +
                        (confirmDeleteId === c.id
                          ? "bg-destructive/10 text-destructive"
                          : "text-muted-foreground hover:bg-muted/60 hover:text-destructive")
                      }
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          {selection.mode === "create" && (
            <div className="rounded-xl border border-dashed border-primary/50 bg-primary/5 px-4 py-3 text-sm">
              Nova empresa — preencha o cadastro abaixo e salve.
            </div>
          )}
        </div>
      </div>

      {/* ── Vínculo conta de marketplace → CNPJ emissor ── */}
      {accounts.length > 0 && (
        <div className="rounded-2xl border border-border/60 bg-card/80 p-6 shadow-[0_18px_50px_-38px_rgba(0,0,0,0.45)] backdrop-blur">
          <h3 className="mb-1 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Contas de marketplace
          </h3>
          <p className="mb-4 text-xs text-muted-foreground">
            O pedido de cada conta emite automaticamente pelo CNPJ vinculado.
            Sem vínculo, usa o CNPJ padrão.
          </p>
          <div className="space-y-2">
            {accounts.map((a) => (
              <div
                key={a.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/60 px-4 py-3"
              >
                <div className="min-w-0">
                  <span className="text-sm font-medium">
                    {PLATFORM_LABELS[a.platform] ?? a.platform}
                  </span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {a.accountName}
                  </span>
                </div>
                <div className="w-64">
                  <Select
                    value={a.companyFiscalConfigId ?? DEFAULT_LINK}
                    onValueChange={(v) => handleLinkAccount(a.id, v)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={DEFAULT_LINK}>
                        CNPJ padrão
                      </SelectItem>
                      {list.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {`${c.nomeFantasia || c.razaoSocial} — ${formatCnpj(c.cnpj)}`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Cadastro da empresa selecionada ── */}
      {selection.mode === "default" && (
        <FiscalConfigForm
          key="default"
          productionUnlocked={productionUnlocked}
          onSaved={loadCompanies}
        />
      )}
      {selection.mode === "edit" && (
        <FiscalConfigForm
          key={selection.company.id}
          productionUnlocked={productionUnlocked}
          companyId={selection.company.id}
          initialCompany={selection.company}
          onSaved={loadCompanies}
        />
      )}
      {selection.mode === "create" && (
        <FiscalConfigForm
          key="create"
          productionUnlocked={productionUnlocked}
          createMode
          onSaved={async () => {
            await loadCompanies();
            setSelection({ mode: "default" });
            showToast(
              "Empresa adicionada — selecione-a na lista para enviar o certificado A1 dela.",
              "success",
            );
          }}
        />
      )}

      {toast && (
        <ToastViewport
          className={
            "fixed bottom-6 right-6 z-[100] rounded-xl border px-4 py-3 text-sm shadow-lg " +
            (toast.type === "success"
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600"
              : "border-destructive/40 bg-destructive/10 text-destructive")
          }
        >
          {toast.msg}
        </ToastViewport>
      )}
    </div>
  );
}
