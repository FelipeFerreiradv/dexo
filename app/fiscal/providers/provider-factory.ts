import type { INfeProvider } from "./nfe-provider.interface";
import { FocusNfeProvider } from "./focus-nfe.provider";
import {
  SefazDirectProvider,
  type SefazDirectProviderOptions,
} from "./sefaz-direct.provider";
import { CertificateLoaderService } from "../certificate/certificate-loader.service";
import type { UF, SefazAmbiente } from "../sefaz/endpoints";

/**
 * Retorna o provedor fiscal configurado.
 *
 * Para `FOCUS_NFE` (e null/default), basta `providerName` + `ambiente` — o
 * token é injetado por chamada via `NfeProviderEmitInput.token`.
 *
 * Para `SEFAZ_DIRECT`, prefira `createNfeProviderFromConfig()` (async, carrega
 * certificado). Chamar este factory diretamente com providerName="SEFAZ_DIRECT"
 * lança erro: a integração direta exige certificado e UF, que não cabem na
 * assinatura compacta — migração feita em F-D nos use cases que orquestram
 * emissão/cancelamento/inutilização.
 */
export function createNfeProvider(
  providerName: string | null,
  ambiente: "HOMOLOGACAO" | "PRODUCAO",
): INfeProvider {
  const amb: SefazAmbiente =
    ambiente === "PRODUCAO" ? "producao" : "homologacao";

  switch (providerName) {
    case "SEFAZ_DIRECT":
      throw new Error(
        "Provider SEFAZ_DIRECT exige certificado + UF — use createNfeProviderFromConfig().",
      );
    case "FOCUS_NFE":
    default:
      return new FocusNfeProvider(amb);
  }
}

/**
 * Constrói um SefazDirectProvider já configurado a partir do
 * `CompanyFiscalConfig` (ou subconjunto dele) e dos arquivos no disco.
 *
 * Carrega o certificado uma vez por chamada (o próprio CertificateLoaderService
 * já tem cache TTL interno, então chamadas repetidas no mesmo processo reusam
 * o PFX parseado).
 */
export interface SefazDirectFactoryInput {
  providerName: "SEFAZ_DIRECT";
  ambiente: "HOMOLOGACAO" | "PRODUCAO";
  uf: UF;
  certificadoPath: string;
  certificadoSenhaEnc: string;
  timeoutMs?: number;
  retryMax?: number;
}

export async function createSefazDirectProvider(
  input: SefazDirectFactoryInput,
  certLoader: CertificateLoaderService = new CertificateLoaderService(),
): Promise<SefazDirectProvider> {
  const cert = await certLoader.load(input.certificadoPath, input.certificadoSenhaEnc);

  const opts: SefazDirectProviderOptions = {
    ambiente: input.ambiente === "PRODUCAO" ? "producao" : "homologacao",
    uf: input.uf,
    certificate: cert,
    timeoutMs: input.timeoutMs,
    retryMax: input.retryMax,
  };

  return new SefazDirectProvider(opts);
}

/**
 * Resolve o provider correto dado o `CompanyFiscalConfig` da empresa.
 * Função async para suportar carregamento de certificado em SEFAZ_DIRECT.
 *
 * Sobre integração com use cases:
 *   - F-C: testes diretos chamam createSefazDirectProvider() para validar o
 *     hello-world status servico.
 *   - F-D: nfe-emission.usecase.ts passa a usar esta função (em vez de
 *     createNfeProvider compacta) quando providerName="SEFAZ_DIRECT".
 *     FocusNfeProvider continua sendo resolvido via createNfeProvider.
 */
export async function createNfeProviderFromConfig(input: {
  providerName: string | null;
  ambiente: "HOMOLOGACAO" | "PRODUCAO";
  uf?: string | null;
  certificadoPath?: string | null;
  certificadoSenhaEnc?: string | null;
  timeoutMs?: number;
  retryMax?: number;
}): Promise<INfeProvider> {
  if (input.providerName === "SEFAZ_DIRECT") {
    if (!input.uf) throw new Error("SEFAZ_DIRECT exige uf no CompanyFiscalConfig.");
    if (!input.certificadoPath) {
      throw new Error("SEFAZ_DIRECT exige certificadoPath no CompanyFiscalConfig.");
    }
    if (!input.certificadoSenhaEnc) {
      throw new Error(
        "SEFAZ_DIRECT exige certificadoSenhaEnc no CompanyFiscalConfig.",
      );
    }

    return createSefazDirectProvider({
      providerName: "SEFAZ_DIRECT",
      ambiente: input.ambiente,
      uf: input.uf as UF,
      certificadoPath: input.certificadoPath,
      certificadoSenhaEnc: input.certificadoSenhaEnc,
      timeoutMs: input.timeoutMs,
      retryMax: input.retryMax,
    });
  }

  // Default e FOCUS_NFE
  return createNfeProvider(input.providerName, input.ambiente);
}
