import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/lib/auth";
import { ProductsList } from "./components/products-list";

export default async function ProductsPage() {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect("/login");
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-foreground">
          Produtos
        </h2>
        <p className="text-muted-foreground">
          Gerencie o catálogo de produtos do seu estoque central
        </p>
      </div>

      <ProductsList />
    </div>
  );
}
