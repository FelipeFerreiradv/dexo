import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import type { Metadata } from "next";

import { authOptions } from "@/app/lib/auth";
import { PageHeader } from "@/components/page-header";
import { ScrapsList } from "./components/scraps-list";

export const metadata: Metadata = {
  title: "Sucatas",
  description:
    "Gerencie as sucatas cadastradas. Controle veículos, custos, dados fiscais e vincule produtos extraídos.",
};

export default async function ScrapsPage() {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect("/login");
  }

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Estoque"
        title="Sucatas"
        subtitle="Gerencie os veículos sucateados. Cadastre dados do veículo, nota fiscal, custos e vincule produtos extraídos."
      />

      <ScrapsList />
    </div>
  );
}
