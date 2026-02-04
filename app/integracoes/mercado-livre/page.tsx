import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/lib/auth";
import { MLDashboard } from "./components/ml-dashboard";

export default async function MercadoLivrePage() {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect("/login");
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-foreground">
          Mercado Livre
        </h2>
        <p className="text-muted-foreground">
          Gerencie sua integração com o Mercado Livre
        </p>
      </div>

      <MLDashboard />
    </div>
  );
}
