import {
  CompanyFiscalConfig,
  CompanyFiscalConfigUpsert,
  RegimeTributario,
} from "../interfaces/company-fiscal.interface";
import { CompanyFiscalRepository } from "../repositories/company-fiscal.repository";
import { isValidCnpj } from "../lib/masks";

const REGIMES: RegimeTributario[] = [
  "SIMPLES",
  "LUCRO_PRESUMIDO",
  "LUCRO_REAL",
];

const UFS = new Set([
  "AC","AL","AM","AP","BA","CE","DF","ES","GO","MA",
  "MG","MS","MT","PA","PB","PE","PI","PR","RJ","RN",
  "RO","RR","RS","SC","SE","SP","TO",
]);

export class CompanyFiscalUseCase {
  private repo: CompanyFiscalRepository;

  constructor() {
    this.repo = new CompanyFiscalRepository();
  }

  async getByUserId(userId: string): Promise<CompanyFiscalConfig | null> {
    return this.repo.findByUserId(userId);
  }

  async upsert(
    userId: string,
    data: CompanyFiscalConfigUpsert,
  ): Promise<CompanyFiscalConfig> {
    if (!userId) throw new Error("Usuário não encontrado");

    if (!data.cnpj || !isValidCnpj(data.cnpj)) {
      throw new Error("CNPJ inválido");
    }
    if (!data.razaoSocial || data.razaoSocial.trim().length < 2) {
      throw new Error("Razão social é obrigatória");
    }
    if (!data.inscricaoEstadual || data.inscricaoEstadual.trim().length < 1) {
      throw new Error("Inscrição estadual é obrigatória");
    }
    if (!data.regimeTributario || !REGIMES.includes(data.regimeTributario)) {
      throw new Error("Regime tributário inválido");
    }
    if (data.ambiente && data.ambiente === "PRODUCAO") {
      if (process.env.FISCAL_PRODUCTION_UNLOCKED !== "true") {
        throw new Error(
          "Ambiente de produção bloqueado. Contate o suporte para liberar.",
        );
      }
    }
    if (data.uf && !UFS.has(data.uf.toUpperCase())) {
      throw new Error("UF inválida");
    }
    if (data.cep) {
      const digits = data.cep.replace(/\D/g, "");
      if (digits.length !== 0 && digits.length !== 8) {
        throw new Error("CEP deve ter 8 dígitos");
      }
    }

    return this.repo.upsert(userId, data);
  }
}
