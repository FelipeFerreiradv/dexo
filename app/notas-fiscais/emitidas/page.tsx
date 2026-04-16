import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import type { Metadata } from "next";

import { authOptions } from "@/app/lib/auth";
import { PageHeader } from "@/components/page-header";
import { NfeList } from "../components/nfe-list";

export const metadata: Metadata = {
  title: "Notas Emitidas",
  description: "Listagem e gerenciamento de Notas Fiscais Eletrônicas emitidas.",
};

export default async function NotasEmitidasPage() {
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
        title="Notas Emitidas"
        subtitle="Visualize, filtre e exporte suas notas fiscais eletrônicas emitidas."
      />
      <NfeList />
    </div>
  );
}
