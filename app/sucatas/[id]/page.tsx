import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import type { Metadata } from "next";

import { authOptions } from "@/app/lib/auth";
import { ScrapDetail } from "./scrap-detail";

export const metadata: Metadata = {
  title: "Detalhe do Lote",
  description:
    "Saúde financeira do lote: investimento, receita realizada, potencial em estoque, ROI e peças.",
};

interface ScrapPageProps {
  params: Promise<{ id: string }>;
}

export default async function ScrapDetailPage({ params }: ScrapPageProps) {
  const session = await getServerSession(authOptions);
  const { id } = await params;

  if (!session) {
    redirect(`/login?callbackUrl=/sucatas/${encodeURIComponent(id)}`);
  }

  return <ScrapDetail scrapId={id} />;
}
