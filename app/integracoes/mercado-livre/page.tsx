import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import type { Metadata } from "next";

import { authOptions } from "@/app/lib/auth";
import { PageHeader } from "@/components/page-header";
import { MLDashboard } from "./components/ml-dashboard";

export const metadata: Metadata = {
  title: "Integração Mercado Livre",
  description:
    "Gerencie tokens, anúncios e sincronização de estoque com o Mercado Livre na plataforma Dexo.",
};

export default async function MercadoLivrePage() {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect("/login");
  }

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Integrações"
        title="Mercado Livre"
        subtitle="Gerencie tokens, anúncios e sincronização de estoque com o Mercado Livre."
      />
      <MLDashboard />
    </div>
  );
}
