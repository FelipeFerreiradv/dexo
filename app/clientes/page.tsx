import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import type { Metadata } from "next";

import { authOptions } from "@/app/lib/auth";
import { PageHeader } from "@/components/page-header";
import { CustomersList } from "./components/customers-list";

export const metadata: Metadata = {
  title: "Clientes",
  description:
    "Gerencie sua base de clientes — cadastro, endereço, contato e dados de entrega.",
};

export default async function ClientesPage() {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect("/login");
  }

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Relacionamento"
        title="Clientes"
        subtitle="Cadastre e mantenha os dados dos seus clientes. Eles são utilizados no módulo Financeiro para contas a pagar e a receber."
      />

      <CustomersList />
    </div>
  );
}
