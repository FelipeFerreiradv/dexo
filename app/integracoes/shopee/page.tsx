import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/lib/auth";
import { ShopeeDashboard } from "./components/shopee-dashboard";

export default async function ShopeePage() {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect("/login");
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-foreground">
          Shopee
        </h2>
        <p className="text-muted-foreground">
          Gerencie sua integração com o Shopee
        </p>
      </div>

      <ShopeeDashboard />
    </div>
  );
}
