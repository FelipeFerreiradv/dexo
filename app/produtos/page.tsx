import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";

import { authOptions } from "@/app/lib/auth";
import { PageHeader } from "@/components/page-header";
import { ProductsList } from "./components/products-list";

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
