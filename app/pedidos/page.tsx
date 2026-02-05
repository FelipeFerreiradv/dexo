import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/lib/auth";
import { OrdersList } from "./components/orders-list";

export default async function OrdersPage() {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect("/login");
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-foreground">
          Pedidos
        </h2>
        <p className="text-muted-foreground">
          Gerencie os pedidos importados dos marketplaces
        </p>
      </div>

      <OrdersList />
    </div>
  );
}
