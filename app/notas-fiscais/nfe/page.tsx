import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import type { Metadata } from "next";

import { authOptions } from "@/app/lib/auth";
import { PageHeader } from "@/components/page-header";
import { NfeWizard } from "../components/nfe-wizard";

export const metadata: Metadata = {
  title: "Emitir NF-e",
  description: "Criação e emissão de Nota Fiscal Eletrônica modelo 55.",
};

export default async function NfePage() {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect("/login");
  }

  if (process.env.NEXT_PUBLIC_FISCAL_MODULE_ENABLED !== "true") {
    redirect("/");
  }

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Notas Fiscais"
        title="Emitir NF-e"
        subtitle="Preencha as etapas abaixo para gerar uma Nota Fiscal Eletrônica. O rascunho é salvo automaticamente."
      />

      <NfeWizard />
    </div>
  );
}
