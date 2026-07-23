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

// Multi-CNPJ: ordenação canônica "default primeiro". Para tenant com 1 config
// (todo o legado), o resultado é idêntico ao antigo findUnique por userId.
const DEFAULT_FIRST = [
  { isDefault: "desc" as const },
  { createdAt: "asc" as const },
];

function buildBaseData(data: CompanyFiscalConfigUpsert) {
  return {
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
    // ── NFC-e (Fase 2) — mesmos padrões de saneamento dos campos acima. ──
    serieNfce:
      typeof data.serieNfce === "number" && Number.isInteger(data.serieNfce)
        ? data.serieNfce
        : 1,
    cscId: data.cscId?.trim() || null,
    ncmPadrao: onlyDigits(data.ncmPadrao),
  };
}

// providerToken/cscToken são segredos e NÃO trafegam de volta ao cliente (ver
// sanitizeFiscalConfig). O formulário reenvia vazio quando o usuário não digita
// um novo: nesse caso preservamos o valor salvo em vez de apagá-lo. Só
// sobrescrevemos quando um valor não-vazio é informado.
function buildSecrets(data: CompanyFiscalConfigUpsert) {
  const tokenProvided =
    typeof data.providerToken === "string" &&
    data.providerToken.trim().length > 0;
  const tokenValue = tokenProvided ? data.providerToken!.trim() : null;

  const cscProvided =
    typeof data.cscToken === "string" && data.cscToken.trim().length > 0;
  const cscValue = cscProvided ? data.cscToken!.trim() : null;

  const secretsCreate: Record<string, unknown> = {
    providerToken: tokenValue,
    cscToken: cscValue,
  };
  const secretsUpdate: Record<string, unknown> = {
    ...(tokenProvided ? { providerToken: tokenValue } : {}),
    ...(cscProvided ? { cscToken: cscValue } : {}),
  };
  return { secretsCreate, secretsUpdate };
}

/**
 * Erro de CNPJ duplicado no tenant (unique userId+cnpj) → mensagem amigável.
 * SÓ P2002: um regex em mensagem mascararia outros erros como "CNPJ duplicado".
 */
function isDuplicateCnpjError(err: any): boolean {
  return err?.code === "P2002";
}

export class CompanyFiscalRepository {
  /**
   * Config fiscal do tenant. Multi-CNPJ: retorna a config PADRÃO (isDefault
   * primeiro; fallback à mais antiga). Para tenant com 1 config — todo o
   * legado — o resultado é idêntico ao antigo findUnique({ where: { userId } }).
   */
  async findByUserId(userId: string): Promise<CompanyFiscalConfig | null> {
    const row = await (prisma as any).companyFiscalConfig.findFirst({
      where: { userId },
      orderBy: DEFAULT_FIRST,
    });
    return row ? toConfig(row) : null;
  }

  /** Nome explícito para o mesmo contrato de findByUserId (config padrão). */
  async findDefaultByUserId(
    userId: string,
  ): Promise<CompanyFiscalConfig | null> {
    return this.findByUserId(userId);
  }

  /** Config específica, escopada pelo dono — nunca vaza config de outro tenant. */
  async findByIdForUser(
    id: string,
    userId: string,
  ): Promise<CompanyFiscalConfig | null> {
    if (!id) return null;
    const row = await (prisma as any).companyFiscalConfig.findFirst({
      where: { id, userId },
    });
    return row ? toConfig(row) : null;
  }

  /**
   * Todas as configs do tenant, padrão primeiro. `omit` da senha cifrada do
   * A1 (egress): o único consumidor é a listagem sanitizada, que descarta o
   * campo sem derivar nada dele — os demais segredos FICAM no select porque o
   * sanitize deriva booleanos deles (certificadoPath/providerToken/cscToken).
   */
  async listByUserId(userId: string): Promise<CompanyFiscalConfig[]> {
    const rows = await (prisma as any).companyFiscalConfig.findMany({
      where: { userId },
      orderBy: DEFAULT_FIRST,
      omit: { certificadoSenhaEnc: true },
    });
    return rows.map(toConfig);
  }

  /** Contagem enxuta (1 escalar) — usada pelo teto de empresas por tenant. */
  async countByUserId(userId: string): Promise<number> {
    return (prisma as any).companyFiscalConfig.count({ where: { userId } });
  }

  /**
   * Upsert LEGADO (PUT /fiscal/config): opera sempre sobre a config padrão.
   * Reescrito sem o unique de userId (removido no multi-CNPJ), com o mesmo
   * comportamento externo de antes — inclusive preserve-when-blank dos segredos.
   */
  async upsert(
    userId: string,
    data: CompanyFiscalConfigUpsert,
  ): Promise<CompanyFiscalConfig> {
    const base = buildBaseData(data);
    const { secretsCreate, secretsUpdate } = buildSecrets(data);

    const existing = await this.findDefaultByUserId(userId);
    if (existing) {
      const row = await (prisma as any).companyFiscalConfig.update({
        where: { id: existing.id },
        data: { ...base, ...secretsUpdate },
      });
      return toConfig(row);
    }

    // Primeira config do tenant nasce como padrão. O upsert antigo era
    // atômico pelo unique de userId; sem ele, dois PUTs simultâneos da 1ª
    // configuração podem correr — o perdedor (P2002 no unique parcial de
    // default ou no userId+cnpj) reaplica como update, preservando o 200.
    try {
      const row = await (prisma as any).companyFiscalConfig.create({
        data: { userId, isDefault: true, ...base, ...secretsCreate },
      });
      return toConfig(row);
    } catch (err: any) {
      if (err?.code !== "P2002") throw err;
      const raced = await this.findDefaultByUserId(userId);
      if (!raced) throw err;
      const row = await (prisma as any).companyFiscalConfig.update({
        where: { id: raced.id },
        data: { ...base, ...secretsUpdate },
      });
      return toConfig(row);
    }
  }

  /**
   * Cria um CNPJ ADICIONAL (multi-CNPJ). Nunca mexe no padrão; exige que o
   * tenant já tenha a config padrão (o fluxo legado cria a primeira).
   */
  async createSecondary(
    userId: string,
    data: CompanyFiscalConfigUpsert,
  ): Promise<CompanyFiscalConfig> {
    const base = buildBaseData(data);
    const { secretsCreate } = buildSecrets(data);
    try {
      const row = await (prisma as any).companyFiscalConfig.create({
        data: { userId, isDefault: false, ...base, ...secretsCreate },
      });
      return toConfig(row);
    } catch (err: any) {
      if (isDuplicateCnpjError(err)) {
        throw new Error("Já existe uma empresa com este CNPJ neste cadastro");
      }
      throw err;
    }
  }

  /** Atualiza uma config específica (escopada pelo dono). */
  async updateById(
    id: string,
    userId: string,
    data: CompanyFiscalConfigUpsert,
  ): Promise<CompanyFiscalConfig> {
    const base = buildBaseData(data);
    const { secretsUpdate } = buildSecrets(data);
    try {
      // updateMany guardado por {id, userId}: nunca atualiza config de outro
      // tenant (update simples por id não teria o escopo).
      const res = await (prisma as any).companyFiscalConfig.updateMany({
        where: { id, userId },
        data: { ...base, ...secretsUpdate },
      });
      if (res.count === 0) throw new Error("Empresa não encontrada");
    } catch (err: any) {
      if (isDuplicateCnpjError(err)) {
        throw new Error("Já existe uma empresa com este CNPJ neste cadastro");
      }
      throw err;
    }
    const row = await this.findByIdForUser(id, userId);
    if (!row) throw new Error("Empresa não encontrada");
    return row;
  }

  /**
   * Torna esta config o CNPJ padrão do tenant. Transacional: zera o default
   * atual e seta o novo (o unique parcial (userId) WHERE isDefault garante no
   * banco que nunca há dois padrões).
   */
  async setDefault(id: string, userId: string): Promise<void> {
    await (prisma as any).$transaction(async (tx: any) => {
      const target = await tx.companyFiscalConfig.findFirst({
        where: { id, userId },
        select: { id: true },
      });
      if (!target) throw new Error("Empresa não encontrada");
      await tx.companyFiscalConfig.updateMany({
        where: { userId, isDefault: true },
        data: { isDefault: false },
      });
      await tx.companyFiscalConfig.update({
        where: { id },
        data: { isDefault: true },
      });
    });
  }

  /**
   * Remove uma config. Recusa: config padrão (trocar o padrão antes) e config
   * em uso (notas/sequences/contas de marketplace referenciando — a numeração
   * fiscal do CNPJ não pode órfã).
   */
  async deleteById(id: string, userId: string): Promise<string | null> {
    // Select enxuto (egress): só o necessário para os guards + o path do A1
    // (devolvido ao caller para a limpeza best-effort do arquivo por-config).
    const target = await (prisma as any).companyFiscalConfig.findFirst({
      where: { id, userId },
      select: { id: true, isDefault: true, certificadoPath: true },
    });
    if (!target) throw new Error("Empresa não encontrada");
    if (target.isDefault) {
      throw new Error(
        "A empresa padrão não pode ser removida — defina outra como padrão antes",
      );
    }
    const [nfes, sequences, accounts, inutilizacoes] = await Promise.all([
      (prisma as any).nfeEmitida.count({
        where: { companyFiscalConfigId: id },
      }),
      (prisma as any).nfeSequence.count({
        where: { companyFiscalConfigId: id },
      }),
      (prisma as any).marketplaceAccount.count({
        where: { companyFiscalConfigId: id },
      }),
      (prisma as any).nfeInutilizacao.count({
        where: { companyFiscalConfigId: id },
      }),
    ]);
    if (nfes > 0 || sequences > 0 || accounts > 0 || inutilizacoes > 0) {
      throw new Error(
        "Empresa em uso (notas emitidas, numeração ou contas vinculadas) — não pode ser removida",
      );
    }
    await (prisma as any).companyFiscalConfig.deleteMany({
      where: { id, userId, isDefault: false },
    });
    return target.certificadoPath ?? null;
  }

  /**
   * Atualiza apenas os campos do certificado A1 (path/senha cifrada/validade).
   * LEGADO: opera sobre a config padrão. Não toca nos demais dados da empresa.
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
    const existing = await this.findDefaultByUserId(userId);
    if (!existing) throw new Error("Configuração fiscal não encontrada");
    return this.updateCertificateById(existing.id, userId, data);
  }

  /** Certificado A1 de uma config específica (multi-CNPJ). */
  async updateCertificateById(
    id: string,
    userId: string,
    data: {
      certificadoPath: string;
      certificadoSenhaEnc: string;
      certificadoValidoAte: Date;
      certificadoSubjectCN: string | null;
    },
  ): Promise<CompanyFiscalConfig> {
    const res = await (prisma as any).companyFiscalConfig.updateMany({
      where: { id, userId },
      data: {
        certificadoPath: data.certificadoPath,
        certificadoSenhaEnc: data.certificadoSenhaEnc,
        certificadoValidoAte: data.certificadoValidoAte,
        certificadoSubjectCN: data.certificadoSubjectCN,
      },
    });
    if (res.count === 0) throw new Error("Empresa não encontrada");
    const row = await this.findByIdForUser(id, userId);
    if (!row) throw new Error("Empresa não encontrada");
    return row;
  }
}
