import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import type { Metadata } from "next";

import { authOptions } from "@/app/lib/auth";
import { PageHeader } from "@/components/page-header";
import { FinanceView } from "./components/finance-view";

export const metadata: Metadata = {
  title: "Financeiro",
  description:
    "Gerencie contas a pagar e a receber. Acompanhe vencimentos, encargos e parcelamentos vinculados aos clientes.",
};

export default async function FinancePage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login");

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Gestão"
        title="Financeiro"
        subtitle="Contas a pagar e a receber, vinculadas ao cadastro de clientes, com encargos e parcelamentos."
      />
      <FinanceView />
    </div>
  );
}
