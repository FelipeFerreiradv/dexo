"use client";

import { useCallback, useState } from "react";
import { Building2, Landmark } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { ToastViewport } from "@/components/ui/toast-viewport";
import { FinanceOverview } from "./finance-overview";
import { FinanceList } from "./finance-list";
import { UnidadeFilter } from "./shared/unidade-select";
import { UnidadesDialog } from "./unidades-dialog";
import { FinanceReportButton } from "./finance-report-button";
import { BudgetList } from "./budget-list";
import { BankAccountsDialog } from "./bank-accounts-dialog";
import { isBankAccountsUiEnabled } from "../lib/bank-accounts";

// BLOCO A — cadastro de contas bancárias / caixas.
const BANK_ACCOUNTS_UI = isBankAccountsUiEnabled();

// Flag do módulo de Orçamento. Ausente/false => o Financeiro renderiza
// EXATAMENTE como antes (apenas as duas abas). Referência literal a
// process.env.NEXT_PUBLIC_* para o Next.js inlinar no bundle do client.
const BUDGET_ENABLED = process.env.NEXT_PUBLIC_BUDGET_ENABLED === "true";

interface Toast {
  id: string;
  message: string;
  type: "success" | "error" | "warning";
}

export function FinanceView() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  // Filtro de unidade compartilhado por Overview + as duas listagens.
  // undefined = "Todas as unidades" => endpoints chamados SEM o parâmetro
  // => comportamento idêntico ao de hoje (zero regressão).
  const [unidadeFilter, setUnidadeFilter] = useState<string | undefined>(
    undefined,
  );
  const [unidadesOpen, setUnidadesOpen] = useState(false);
  // Bump para o UnidadeFilter recarregar a lista após gerenciar unidades.
  const [unidadeRefreshKey, setUnidadeRefreshKey] = useState(0);
  // BLOCO A — cadastro de contas bancárias / caixas.
  const [contasOpen, setContasOpen] = useState(false);
  const [bankAccountRefreshKey, setBankAccountRefreshKey] = useState(0);

  const showToast = useCallback(
    (message: string, type: "success" | "error" | "warning") => {
      const id =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : Math.random().toString(36);
      setToasts((prev) => [...prev, { id, message, type }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 4000);
    },
    [],
  );

  const bumpRefresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  return (
    <div className="space-y-6">
      <ToastViewport className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`rounded-lg px-4 py-3 text-sm font-medium shadow-lg ${
              t.type === "success"
                ? "bg-green-100 text-green-800 dark:bg-green-900/80 dark:text-green-200"
                : t.type === "warning"
                  ? "bg-amber-100 text-amber-900 dark:bg-amber-900/80 dark:text-amber-100"
                  : "bg-destructive text-white"
            }`}
          >
            {t.message}
          </div>
        ))}
      </ToastViewport>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Unidade:</span>
          <UnidadeFilter
            value={unidadeFilter}
            onChange={setUnidadeFilter}
            refreshKey={unidadeRefreshKey}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <FinanceReportButton unidadeId={unidadeFilter} />
          <Button variant="outline" onClick={() => setUnidadesOpen(true)}>
            <Building2 className="h-4 w-4" />
            Gerenciar unidades
          </Button>
          {/* BLOCO A — flag OFF ⇒ o botão não existe e o Financeiro renderiza
              como hoje. */}
          {BANK_ACCOUNTS_UI && (
            <Button variant="outline" onClick={() => setContasOpen(true)}>
              <Landmark className="h-4 w-4" />
              Contas e caixas
            </Button>
          )}
        </div>
      </div>

      <FinanceOverview refreshKey={refreshKey} unidadeId={unidadeFilter} />

      <Tabs defaultValue="receivables" className="space-y-4">
        <TabsList>
          <TabsTrigger value="receivables">Contas a Receber</TabsTrigger>
          <TabsTrigger value="payables">Contas a Pagar</TabsTrigger>
          {BUDGET_ENABLED && (
            <TabsTrigger value="budgets">Orçamentos</TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="receivables">
          <FinanceList
            kind="receivable"
            onToast={showToast}
            onChanged={bumpRefresh}
            unidadeId={unidadeFilter}
          />
        </TabsContent>
        <TabsContent value="payables">
          <FinanceList
            kind="payable"
            onToast={showToast}
            onChanged={bumpRefresh}
            unidadeId={unidadeFilter}
          />
        </TabsContent>
        {BUDGET_ENABLED && (
          <TabsContent value="budgets">
            <BudgetList
              onToast={showToast}
              onChanged={bumpRefresh}
              unidadeId={unidadeFilter}
            />
          </TabsContent>
        )}
      </Tabs>

      <UnidadesDialog
        open={unidadesOpen}
        onOpenChange={setUnidadesOpen}
        onToast={showToast}
        onChanged={() => {
          setUnidadeRefreshKey((k) => k + 1);
          bumpRefresh();
        }}
      />

      {/* BLOCO A — cadastro de contas. `bankAccountRefreshKey` invalida os
          seletores abertos: sem isso, cadastrar uma conta e voltar ao
          lançamento mostraria a lista velha. */}
      {BANK_ACCOUNTS_UI && (
        <BankAccountsDialog
          open={contasOpen}
          onOpenChange={setContasOpen}
          onToast={showToast}
          onChanged={() => {
            setBankAccountRefreshKey((k) => k + 1);
            bumpRefresh();
          }}
        />
      )}
    </div>
  );
}
