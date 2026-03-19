import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import type { Metadata } from "next";

import { authOptions } from "@/app/lib/auth";
import { PageHeader } from "@/components/page-header";
import { ShopeeDashboard } from "./components/shopee-dashboard";

export const metadata: Metadata = {
  title: "Integração Shopee",
  description:
    "Gerencie credenciais, anúncios e sincronização de estoque com a Shopee na plataforma Dexo.",
};

export default async function ShopeePage() {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect("/login");
  }

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Integrações"
        title="Shopee"
        subtitle="Controle credenciais, anúncios e sincronização de estoque com a Shopee."
        pills={
          <span className="rounded-full border border-border/60 bg-muted/20 px-3 py-1 text-xs font-medium text-muted-foreground">
            Em tempo real
          </span>
        }
      />

      <ShopeeDashboard />
    </div>
  );
}
