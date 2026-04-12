import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import type { Metadata } from "next";

import { authOptions } from "@/app/lib/auth";
import { ProductDetail } from "./product-detail";

export const metadata: Metadata = {
  title: "Detalhe do Produto",
  description: "Visualize as informações completas do produto.",
};

interface ProductPageProps {
  params: Promise<{ id: string }>;
}

export default async function ProductDetailPage({ params }: ProductPageProps) {
  const session = await getServerSession(authOptions);
  const { id } = await params;

  if (!session) {
    redirect(`/login?callbackUrl=/produtos/${encodeURIComponent(id)}`);
  }

  return <ProductDetail productId={id} />;
}
