import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import type { Metadata } from "next";

import { authOptions } from "@/app/lib/auth";
import { PageHeader } from "@/components/page-header";
import { ScanReceiveFlow } from "../../components/scan-receive-flow";

export const metadata: Metadata = {
  title: "Receber por scan",
  description: "Vincule produtos a esta localização escaneando QR Codes.",
};

interface ScanLocationPageProps {
  params: Promise<{ id: string }>;
}

export default async function ScanLocationPage({
  params,
}: ScanLocationPageProps) {
  const session = await getServerSession(authOptions);
  if (!session) {
    redirect("/login");
  }

  const { id } = await params;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Estoque"
        title="Receber por scan"
        subtitle="Vá lendo o QR de cada produto que entrar nesta localização — ele será vinculado automaticamente."
      />
      <ScanReceiveFlow initialLocationId={id} />
    </div>
  );
}
