"use client";

import { Badge } from "@/components/ui/badge";

const STATUS_CONFIG: Record<
  string,
  {
    label: string;
    variant: "default" | "secondary" | "destructive" | "outline";
    className: string;
  }
> = {
  DRAFT: {
    label: "Rascunho",
    variant: "secondary",
    className: "",
  },
  VALIDATING: {
    label: "Validando",
    variant: "outline",
    className: "border-blue-500/50 bg-blue-500/10 text-blue-700 dark:text-blue-400",
  },
  SIGNING: {
    label: "Assinando",
    variant: "outline",
    className: "border-blue-500/50 bg-blue-500/10 text-blue-700 dark:text-blue-400",
  },
  SENDING: {
    label: "Enviando",
    variant: "outline",
    className: "border-yellow-500/50 bg-yellow-500/10 text-yellow-700 dark:text-yellow-400",
  },
  AUTHORIZED: {
    label: "Autorizada",
    variant: "default",
    className: "border-green-500/50 bg-green-500/10 text-green-700 dark:text-green-400",
  },
  REJECTED: {
    label: "Rejeitada",
    variant: "destructive",
    className: "",
  },
  CANCELLED: {
    label: "Cancelada",
    variant: "outline",
    className: "border-red-500/50 bg-red-500/10 text-red-700 dark:text-red-400",
  },
  INUTILIZED: {
    label: "Inutilizada",
    variant: "outline",
    className: "border-gray-500/50 bg-gray-500/10 text-gray-700 dark:text-gray-400",
  },
};

export function NfeStatusBadge({ status }: { status: string }) {
  const config = STATUS_CONFIG[status] ?? {
    label: status,
    variant: "secondary" as const,
    className: "",
  };

  return (
    <Badge variant={config.variant} className={config.className}>
      {config.label}
    </Badge>
  );
}
