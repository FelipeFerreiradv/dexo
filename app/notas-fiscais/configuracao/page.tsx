import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import type { Metadata } from "next";

import { authOptions } from "@/app/lib/auth";
import { PageHeader } from "@/components/page-header";
import { FiscalConfigForm } from "../components/fiscal-config-form";

export const metadata: Metadata = {
  title: "Configuração Fiscal",
  description:
    "Dados do emissor, endereço fiscal, ambiente e provedor para emissão de NF-e.",
};

export default async function FiscalConfigPage() {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect("/login");
  }

  if (process.env.NEXT_PUBLIC_FISCAL_MODULE_ENABLED !== "true") {
    redirect("/");
  }

  const productionUnlocked =
    process.env.NEXT_PUBLIC_FISCAL_PRODUCTION_UNLOCKED === "true";

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Notas Fiscais"
        title="Configuração fiscal"
        subtitle="Dados do emissor usados em todas as NF-e. A emissão só fica liberada após este cadastro estar completo."
      />

      <FiscalConfigForm productionUnlocked={productionUnlocked} />
    </div>
  );
}
