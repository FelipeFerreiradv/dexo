import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import type { Metadata } from "next";

import { authOptions } from "@/app/lib/auth";
import { PageHeader } from "@/components/page-header";
import { ProductsList } from "./components/products-list";

export const metadata: Metadata = {
  title: "Produtos",
  description:
    "Gerencie o catálogo unificado de produtos. Controle estoque, preços e anúncios em todos os canais de venda.",
};

export default async function ProductsPage() {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect("/login");
  }

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Catálogo"
        title="Produtos"
        subtitle="Gerencie o catálogo unificado e mantenha estoque, preços e anúncios consistentes em todos os canais."
      />

      <ProductsList />
    </div>
  );
}
