import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";

import { authOptions } from "@/app/lib/auth";
import { PageHeader } from "@/components/page-header";
import { OrdersList } from "./components/orders-list";

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
        pills={
          <span className="rounded-full border border-border/60 bg-muted/20 px-3 py-1 text-xs font-medium text-muted-foreground">
            Cobertura multicanal
          </span>
        }
      />

      <OrdersList />
    </div>
  );
}
