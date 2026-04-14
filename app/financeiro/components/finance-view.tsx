"use client";

import { useCallback, useState } from "react";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { FinanceOverview } from "./finance-overview";
import { FinanceList } from "./finance-list";

interface Toast {
  id: string;
  message: string;
  type: "success" | "error" | "warning";
}

export function FinanceView() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

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
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
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
      </div>

      <FinanceOverview refreshKey={refreshKey} />

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
          />
        </TabsContent>
        <TabsContent value="payables">
          <FinanceList
            kind="payable"
            onToast={showToast}
            onChanged={bumpRefresh}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
