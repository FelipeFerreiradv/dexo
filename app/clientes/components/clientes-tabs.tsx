"use client";

import { useState } from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CustomersList } from "./customers-list";
import { BudgetCrm } from "./budget-crm";

// Container das abas de Clientes (só montado quando NEXT_PUBLIC_BUDGET_ENABLED).
// Guarda o estado de deep-link (clicar no badge de contagem em Clientes abre a
// aba Orçamentos já filtrada por aquele cliente).
export function ClientesTabs() {
  const [tab, setTab] = useState("clientes");
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState<string | null>(null);

  const openBudgets = (id: string, name: string) => {
    setCustomerId(id);
    setCustomerName(name);
    setTab("orcamentos");
  };

  const clearCustomer = () => {
    setCustomerId(null);
    setCustomerName(null);
  };

  return (
    <Tabs value={tab} onValueChange={setTab} className="space-y-4">
      <TabsList>
        <TabsTrigger value="clientes">Clientes</TabsTrigger>
        <TabsTrigger value="orcamentos">Orçamentos</TabsTrigger>
      </TabsList>

      <TabsContent value="clientes">
        <CustomersList showBudgets onOpenBudgets={openBudgets} />
      </TabsContent>

      <TabsContent value="orcamentos">
        <BudgetCrm
          initialCustomerId={customerId}
          initialCustomerName={customerName}
          onClearCustomer={clearCustomer}
        />
      </TabsContent>
    </Tabs>
  );
}
