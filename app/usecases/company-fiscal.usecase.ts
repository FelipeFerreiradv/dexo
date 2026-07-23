import {
  CompanyFiscalConfig,
  CompanyFiscalConfigUpsert,
  RegimeTributario,
} from "../interfaces/company-fiscal.interface";
import { CompanyFiscalRepository } from "../repositories/company-fiscal.repository";
import { FiscalStorageService } from "../fiscal/storage/fiscal-storage.service";
import { CertificateManagerService } from "../fiscal/certificate/certificate-manager.service";
import { validateCertForEmitter } from "../fiscal/certificate/certificate-loader.service";
import { isValidCnpj } from "../lib/masks";

/**
 * Resultado do upload de certificado A1. `ok=false` carrega `status` (HTTP) e
 * `error` (mensagem amigável) para a rota mapear; `ok=true` carrega os metadados
 * do certificado gravado para exibição na UI.
 */
export interface CertificateUploadResult {
  ok: boolean;
  status?: number;
  error?: string;
  subjectCN?: string | null;
  certCnpj?: string | null;
  validoAte?: Date;
  cnpjMatched?: boolean;
}

// Teto de empresas emissoras por tenant — defensivo (exaustão de disco/linhas),
// muito acima de qualquer uso real de matriz+filiais.
const MAX_EMPRESAS_POR_TENANT = 20;

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
  private storage: FiscalStorageService;
  // Lazy: o CertificateManagerService falha fechado em produção sem
  // FISCAL_CERT_ENC_KEY; só instanciamos quando o upload é de fato exercido,
  // para não acoplar o boot da API a essa env var.
  private certManager: CertificateManagerService | null;

  constructor(
    repo?: CompanyFiscalRepository,
    storage?: FiscalStorageService,
    certManager?: CertificateManagerService,
  ) {
    this.repo = repo ?? new CompanyFiscalRepository();
    this.storage = storage ?? new FiscalStorageService();
    this.certManager = certManager ?? null;
  }

  private getCertManager(): CertificateManagerService {
    if (!this.certManager) {
      this.certManager = new CertificateManagerService();
    }
    return this.certManager;
  }

  async getByUserId(userId: string): Promise<CompanyFiscalConfig | null> {
    return this.repo.findByUserId(userId);
  }

  // ── Multi-CNPJ ──

  async listByUserId(userId: string): Promise<CompanyFiscalConfig[]> {
    return this.repo.listByUserId(userId);
  }

  async getByIdForUser(
    id: string,
    userId: string,
  ): Promise<CompanyFiscalConfig | null> {
    return this.repo.findByIdForUser(id, userId);
  }

  /**
   * Cadastra um CNPJ ADICIONAL. Gated por FISCAL_MULTI_CNPJ_ENABLED (só pode
   * ser ligada após o SQL-2 do docs/multi-cnpj-sql.md — antes disso o unique
   * antigo de numeração ainda está de pé e um 2º CNPJ colidiria).
   */
  async createSecondary(
    userId: string,
    data: CompanyFiscalConfigUpsert,
  ): Promise<CompanyFiscalConfig> {
    if (!userId) throw new Error("Usuário não encontrado");
    if (process.env.FISCAL_MULTI_CNPJ_ENABLED !== "true") {
      throw new Error(
        "Cadastro de múltiplos CNPJs não está habilitado. Contate o suporte.",
      );
    }
    const defaultConfig = await this.repo.findDefaultByUserId(userId);
    if (!defaultConfig) {
      throw new Error(
        "Configure a empresa principal antes de adicionar outro CNPJ.",
      );
    }
    this.validateUpsert(data);
    // Teto defensivo por tenant (hardening): nenhum uso legítimo chega perto
    // disso; fecha superfície de exaustão (linhas + .pfx por config no disco).
    const total = await this.repo.countByUserId(userId);
    if (total >= MAX_EMPRESAS_POR_TENANT) {
      throw new Error(
        "Limite de empresas por cadastro atingido. Contate o suporte.",
      );
    }
    return this.repo.createSecondary(userId, data);
  }

  async updateById(
    id: string,
    userId: string,
    data: CompanyFiscalConfigUpsert,
  ): Promise<CompanyFiscalConfig> {
    if (!userId) throw new Error("Usuário não encontrado");
    this.validateUpsert(data);
    return this.repo.updateById(id, userId, data);
  }

  async setDefault(id: string, userId: string): Promise<void> {
    if (!userId) throw new Error("Usuário não encontrado");
    return this.repo.setDefault(id, userId);
  }

  async deleteById(id: string, userId: string): Promise<void> {
    if (!userId) throw new Error("Usuário não encontrado");
    const certPath = await this.repo.deleteById(id, userId);
    // Higiene: remove do disco o A1 POR-CONFIG da empresa excluída (best-
    // effort). NUNCA o path legado compartilhado certs/<userId>.pfx — a
    // config padrão pode apontar para ele.
    if (certPath && certPath.endsWith(`${userId}-${id}.pfx`)) {
      await this.storage.deleteFile(certPath);
    }
  }

  async upsert(
    userId: string,
    data: CompanyFiscalConfigUpsert,
  ): Promise<CompanyFiscalConfig> {
    if (!userId) throw new Error("Usuário não encontrado");
    this.validateUpsert(data);
    return this.repo.upsert(userId, data);
  }

  /**
   * Validações compartilhadas entre upsert (legado), createSecondary e
   * updateById — extraídas para os três caminhos nunca divergirem.
   */
  private validateUpsert(data: CompanyFiscalConfigUpsert): void {
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
    if (data.serieNfce !== undefined && data.serieNfce !== null) {
      // Série da NFC-e: mesma regra da série da NF-e (inteiro 1–999).
      if (
        !Number.isInteger(data.serieNfce) ||
        data.serieNfce < 1 ||
        data.serieNfce > 999
      ) {
        throw new Error("Série da NFC-e deve ser um inteiro entre 1 e 999");
      }
    }
    if (data.ncmPadrao !== undefined && data.ncmPadrao !== null) {
      // NCM padrão: vazio (limpa) ou exatamente 8 dígitos.
      const ncmDigits = data.ncmPadrao.replace(/\D/g, "");
      if (ncmDigits.length !== 0 && ncmDigits.length !== 8) {
        throw new Error("NCM padrão deve ter 8 dígitos");
      }
    }
    if (data.serieNfe !== undefined && data.serieNfe !== null) {
      // Série da NF-e: inteiro 1–999 (SEFAZ aceita 0–999, mas o wizard usa ≥1).
      if (
        !Number.isInteger(data.serieNfe) ||
        data.serieNfe < 1 ||
        data.serieNfe > 999
      ) {
        throw new Error("Série da NF-e deve ser um inteiro entre 1 e 999");
      }
    }
  }

  /**
   * Recebe um certificado A1 (.pfx) + senha, valida (senha correta, não
   * expirado, CNPJ pertence ao emissor), grava o arquivo em disco e persiste
   * path/senha-cifrada/validade no CompanyFiscalConfig. Substitui a função do
   * script setup-sefaz-direct.ts para onboarding self-service de clientes.
   *
   * Falhas de validação retornam `{ ok:false, status, error }` (sem persistir
   * nada). Falhas de infraestrutura (disco/banco/cifragem) sobem como exceção
   * para a rota tratar como 500.
   */
  async uploadCertificate(
    userId: string,
    pfxBuffer: Buffer,
    senha: string,
    configId?: string,
  ): Promise<CertificateUploadResult> {
    if (!userId) {
      return { ok: false, status: 401, error: "Usuário não encontrado" };
    }
    if (!pfxBuffer || pfxBuffer.length === 0) {
      return { ok: false, status: 400, error: "Arquivo do certificado vazio" };
    }
    if (!senha || senha.length === 0) {
      return {
        ok: false,
        status: 400,
        error: "A senha do certificado é obrigatória",
      };
    }

    // A empresa precisa existir para conferirmos o CNPJ do emissor.
    // Multi-CNPJ: com `configId`, o certificado é da empresa selecionada e o
    // CNPJ conferido é o DELA; sem, caminho legado (empresa padrão) intacto.
    const config = configId
      ? await this.repo.findByIdForUser(configId, userId)
      : await this.repo.findByUserId(userId);
    if (!config) {
      return configId
        ? { ok: false, status: 404, error: "Empresa não encontrada" }
        : {
            ok: false,
            status: 409,
            error:
              "Salve os dados da empresa (CNPJ e endereço) antes de enviar o certificado.",
          };
    }

    const validation = validateCertForEmitter(pfxBuffer, senha, config.cnpj);
    if (!validation.ok) {
      return { ok: false, status: 400, error: validation.error };
    }

    // Persistência. Cifra a senha ANTES de gravar o .pfx em disco: o
    // CertificateManagerService falha fechado (lança) sem FISCAL_CERT_ENC_KEY
    // válida em produção; cifrando primeiro, esse erro aborta sem deixar um
    // .pfx órfão no filesystem. Erros aqui sobem como exceção → 500 na rota.
    // Path SEMPRE por config (certs/<userId>-<configId>.pfx), inclusive na
    // rota legada: o path por-usuário era compartilhável entre configs — com
    // multi-CNPJ, um upload pelo caminho legado (que opera sobre o PADRÃO,
    // mutável via setDefault) sobrescreveria o A1 de OUTRO CNPJ cujo registro
    // ainda aponta para certs/<userId>.pfx. Certificados antigos continuam
    // lidos do path gravado na própria linha.
    const senhaEnc = this.getCertManager().encryptPassword(senha);
    const certPath = await this.storage.saveCertificate(
      userId,
      pfxBuffer,
      config.id,
    );
    const certData = {
      certificadoPath: certPath,
      certificadoSenhaEnc: senhaEnc,
      certificadoValidoAte: validation.notAfter as Date,
      certificadoSubjectCN: validation.subjectCN ?? null,
    };
    if (configId) {
      await this.repo.updateCertificateById(config.id, userId, certData);
    } else {
      await this.repo.updateCertificate(userId, certData);
    }

    return {
      ok: true,
      subjectCN: validation.subjectCN ?? null,
      certCnpj: validation.certCnpj ?? null,
      validoAte: validation.notAfter,
      cnpjMatched: validation.cnpjMatched ?? false,
    };
  }
}
