import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import type { Metadata } from "next";

import { authOptions } from "@/app/lib/auth";
import { PageHeader } from "@/components/page-header";
import { OrdersList } from "./components/orders-list";

export const metadata: Metadata = {
  title: "Pedidos",
  description:
    "Acompanhe pedidos importados de todos os marketplaces. Mantenha o status atualizado em tempo real.",
};

export default async function OrdersPage() {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect("/login");
  }

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Operações"
        title="Pedidos"
        subtitle="Acompanhe pedidos importados de todos os marketplaces e mantenha o status sempre atualizado."
      />

      <OrdersList />
    </div>
  );
}
