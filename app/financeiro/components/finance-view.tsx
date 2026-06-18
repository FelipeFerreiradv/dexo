"use client";

import { useCallback, useState } from "react";
import { Building2 } from "lucide-react";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { ToastViewport } from "@/components/ui/toast-viewport";
import { FinanceOverview } from "./finance-overview";
import { FinanceList } from "./finance-list";
import { UnidadeFilter } from "./shared/unidade-select";
import { UnidadesDialog } from "./unidades-dialog";

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
        <Button variant="outline" onClick={() => setUnidadesOpen(true)}>
          <Building2 className="h-4 w-4" />
          Gerenciar unidades
        </Button>
      </div>

      <FinanceOverview refreshKey={refreshKey} unidadeId={unidadeFilter} />

      <Tabs defaultValue="receivables" className="space-y-4">
        <TabsList>
          <TabsTrigger value="receivables">Contas a Receber</TabsTrigger>
          <TabsTrigger value="payables">Contas a Pagar</TabsTrigger>
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
    </div>
  );
}
