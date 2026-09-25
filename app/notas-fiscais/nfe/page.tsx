import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import type { Metadata } from "next";

import { authOptions } from "@/app/lib/auth";
import { assertPageAccess } from "@/app/lib/guard-page";
import { PageHeader } from "@/components/page-header";
import { NfeWizard } from "../components/nfe-wizard";
import { SUBTITULO_EMITIR_NFE } from "../lib/nfe-devolucao-wizard-ui";

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

  // Depois da flag, nunca antes (ver page-access.ts): com o módulo desligado o
  // destino continua sendo "/".
  await assertPageAccess(session, "fiscal");

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Notas Fiscais"
        title="Emitir NF-e"
        subtitle={SUBTITULO_EMITIR_NFE}
      />

      <NfeWizard />
    </div>
  );
}
