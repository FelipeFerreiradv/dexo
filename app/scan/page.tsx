import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import type { Metadata } from "next";

import { authOptions } from "@/app/lib/auth";
import { PageHeader } from "@/components/page-header";
import { ScanReceiveFlow } from "./components/scan-receive-flow";

export const metadata: Metadata = {
  title: "Receber por scan",
  description:
    "Vincule produtos a uma localização escaneando QR Codes pela câmera do celular.",
};

interface ScanPageProps {
  searchParams: Promise<{ locationId?: string }>;
}

export default async function ScanPage({ searchParams }: ScanPageProps) {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect("/login");
  }

  const { locationId } = await searchParams;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Estoque"
        title="Receber por scan"
        subtitle="Escaneie o QR da localização e, em seguida, vá lendo o QR de cada produto para vincular automaticamente."
      />

      <ScanReceiveFlow initialLocationId={locationId} />
    </div>
  );
}
