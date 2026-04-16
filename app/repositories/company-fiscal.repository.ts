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
      providerToken: data.providerToken?.trim() || null,
    };

    const row = await (prisma as any).companyFiscalConfig.upsert({
      where: { userId },
      create: { userId, ...base },
      update: base,
    });
    return toConfig(row);
  }
}
