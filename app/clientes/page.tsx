import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import type { Metadata } from "next";

import { authOptions } from "@/app/lib/auth";
import { assertPageAccess } from "@/app/lib/guard-page";
import { PageHeader } from "@/components/page-header";
import { CustomersList } from "./components/customers-list";
import { ClientesTabs } from "./components/clientes-tabs";

// Flag do módulo de Orçamento (mesmo padrão do Financeiro). Ausente/false =>
// /clientes renderiza EXATAMENTE como antes (só a lista, sem abas/coluna/CRM).
const BUDGET_ENABLED = process.env.NEXT_PUBLIC_BUDGET_ENABLED === "true";

export const metadata: Metadata = {
  title: "Clientes",
  description:
    "Gerencie sua base de clientes — cadastro, endereço, contato e dados de entrega.",
};

export default async function ClientesPage() {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect("/login");
  }

  await assertPageAccess(session, "clientes");

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Relacionamento"
        title="Clientes"
        subtitle="Cadastre e mantenha os dados dos seus clientes. Eles são utilizados no módulo Financeiro para contas a pagar e a receber."
      />

      {BUDGET_ENABLED ? <ClientesTabs /> : <CustomersList />}
    </div>
  );
}
