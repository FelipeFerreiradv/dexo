import type { INfeProvider } from "./nfe-provider.interface";
import { FocusNfeProvider } from "./focus-nfe.provider";

/**
 * Retorna o provedor fiscal configurado.
 * Por ora só Focus NFe é suportado. Extensível via switch.
 */
export function createNfeProvider(
  providerName: string | null,
  ambiente: "HOMOLOGACAO" | "PRODUCAO",
): INfeProvider {
  const amb = ambiente === "PRODUCAO" ? "producao" : "homologacao";

  switch (providerName) {
    case "FOCUS_NFE":
    default:
      return new FocusNfeProvider(amb);
  }
}
