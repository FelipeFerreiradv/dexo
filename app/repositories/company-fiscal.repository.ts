import prisma from "../lib/prisma";
import {
  CompanyFiscalConfig,
  CompanyFiscalConfigUpsert,
  FiscalAmbiente,
  RegimeTributario,
} from "../interfaces/company-fiscal.interface";

function toConfig(c: any): CompanyFiscalConfig {
  return {
    ...c,
    ambiente: c.ambiente as FiscalAmbiente,
    regimeTributario: c.regimeTributario as RegimeTributario,
  };
}

function onlyDigits(v: string | null | undefined): string | null {
  if (!v) return null;
  const d = v.replace(/\D/g, "");
  return d.length > 0 ? d : null;
}

export class CompanyFiscalRepository {
  async findByUserId(userId: string): Promise<CompanyFiscalConfig | null> {
    const row = await (prisma as any).companyFiscalConfig.findUnique({
      where: { userId },
    });
    return row ? toConfig(row) : null;
  }

  async upsert(
    userId: string,
    data: CompanyFiscalConfigUpsert,
  ): Promise<CompanyFiscalConfig> {
    const base = {
      cnpj: onlyDigits(data.cnpj) ?? "",
      razaoSocial: data.razaoSocial.trim(),
      nomeFantasia: data.nomeFantasia?.trim() || null,
      inscricaoEstadual: data.inscricaoEstadual.trim(),
      inscricaoMunicipal: data.inscricaoMunicipal?.trim() || null,
      regimeTributario: data.regimeTributario,
      cnae: data.cnae?.trim() || null,
      ambiente: data.ambiente ?? "HOMOLOGACAO",
      cep: onlyDigits(data.cep),
      logradouro: data.logradouro?.trim() || null,
      numero: data.numero?.trim() || null,
      complemento: data.complemento?.trim() || null,
      bairro: data.bairro?.trim() || null,
      municipio: data.municipio?.trim() || null,
      codMunicipio: data.codMunicipio?.trim() || null,
      uf: data.uf ? data.uf.toUpperCase() : null,
      codPais: data.codPais?.trim() || "1058",
      pais: data.pais?.trim() || "BRASIL",
      providerName: data.providerName?.trim() || null,
      serieNfe:
        typeof data.serieNfe === "number" && Number.isInteger(data.serieNfe)
          ? data.serieNfe
          : 1,
    };

    // providerToken é segredo e NÃO trafega de volta ao cliente (ver
    // sanitizeFiscalConfig). Por isso o formulário reenvia vazio quando o
    // usuário não digita um novo: nesse caso preservamos o token salvo em vez
    // de apagá-lo. Só sobrescrevemos quando um token não-vazio é informado.
    const tokenProvided =
      typeof data.providerToken === "string" &&
      data.providerToken.trim().length > 0;
    const tokenValue = tokenProvided ? data.providerToken!.trim() : null;

    const row = await (prisma as any).companyFiscalConfig.upsert({
      where: { userId },
      create: { userId, ...base, providerToken: tokenValue },
      update: tokenProvided ? { ...base, providerToken: tokenValue } : base,
    });
    return toConfig(row);
  }

  /**
   * Atualiza apenas os campos do certificado A1 (path/senha cifrada/validade).
   * Não toca nos demais dados da empresa. Requer config já existente.
   */
  async updateCertificate(
    userId: string,
    data: {
      certificadoPath: string;
      certificadoSenhaEnc: string;
      certificadoValidoAte: Date;
      certificadoSubjectCN: string | null;
    },
  ): Promise<CompanyFiscalConfig> {
    const row = await (prisma as any).companyFiscalConfig.update({
      where: { userId },
      data: {
        certificadoPath: data.certificadoPath,
        certificadoSenhaEnc: data.certificadoSenhaEnc,
        certificadoValidoAte: data.certificadoValidoAte,
        certificadoSubjectCN: data.certificadoSubjectCN,
      },
    });
    return toConfig(row);
  }
}
