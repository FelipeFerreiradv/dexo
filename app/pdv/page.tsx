import { notFound, redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import type { Metadata } from "next";

import { authOptions } from "@/app/lib/auth";
import { assertPageAccess } from "@/app/lib/guard-page";
import { PageHeader } from "@/components/page-header";
import { PdvView } from "./components/pdv-view";

export const metadata: Metadata = {
  title: "PDV Balcão",
  description:
    "Ponto de venda balcão: cliente, produtos, recebimento e baixa de estoque com sincronização dos anúncios.",
};

// Módulo 100% aditivo atrás da flag. Com a flag desligada, a página não
// existe (mesmo por URL direta) — garante "flag off ⇒ app idêntico ao de hoje".
const PDV_ENABLED = process.env.NEXT_PUBLIC_PDV_ENABLED === "true";

export default async function PdvPage() {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect("/login");
  }

  if (!PDV_ENABLED) {
    notFound();
  }

  await assertPageAccess(session, "pdv");

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Vendas"
        title="PDV Balcão"
        subtitle="Venda de balcão ponta a ponta: selecione o cliente e os produtos, finalize o recebimento e o estoque baixa com os anúncios sincronizados."
      />
      <PdvView />
    </div>
  );
}
