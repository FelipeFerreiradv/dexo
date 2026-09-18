import { z } from "zod";
import { CompanyFiscalRepository } from "../repositories/company-fiscal.repository";
import { CompanyFiscalRespTecRepository } from "../repositories/company-fiscal-resp-tec.repository";
import type { ICompanyFiscalRespTecRepository } from "../repositories/company-fiscal-resp-tec.repository";
import type { CompanyFiscalConfig } from "../interfaces/company-fiscal.interface";
import { avisosRespTec, modosPermitidos, validarRespTec } from "../fiscal/domain/resp-tec";
import { encryptFiscalSecret, decryptFiscalSecret } from "../fiscal/certificate/fiscal-secret";
import { resolveRespTec } from "../fiscal/providers/nfe-provider-resolver";
import type { RespTecPolicy, RespTecRow } from "../fiscal/providers/nfe-provider-resolver";
import { isFiscalFeatureOn } from "../fiscal/flags";
import { NumeracaoError, tabelaFiscalAusente } from "../fiscal/numeracao/numeracao.errors";

const texto = z.string().max(128).nullable().optional();
const bodySchema = z.object({ modo:z.enum(["PADRAO","PROVEDOR","PERSONALIZADO","NENHUM"]), cnpj:texto, xContato:texto,
  email:texto, fone:texto, idCsrt:texto, csrtToken:texto, removerCsrt:z.boolean().optional() }).strict();
const PADRAO: RespTecRow = {modo:"PADRAO",cnpj:null,xContato:null,email:null,fone:null,idCsrt:null,csrtEnc:null};
type Configs = Pick<CompanyFiscalRepository, "findByIdForUser" | "findByUserId">;

export class CompanyFiscalRespTecUseCase {
  constructor(private readonly repo: ICompanyFiscalRespTecRepository = new CompanyFiscalRespTecRepository(),
    private readonly configs: Configs = new CompanyFiscalRepository(),
    private readonly encrypt: (secret: string) => string = encryptFiscalSecret) {}

  private async config(userId: string, configId?: string): Promise<CompanyFiscalConfig> {
    const config = configId ? await this.configs.findByIdForUser(configId,userId) : await this.configs.findByUserId(userId);
    if (!config || !isFiscalFeatureOn("RESP_TEC_EMPRESA",config.id)) throw new NumeracaoError("RECURSO_INDISPONIVEL",404,"Recurso indisponível");
    return config;
  }
  async get(userId: string, configId?: string) {
    const config = await this.config(userId,configId);
    try { return this.publico(config,await this.repo.find(userId,config.id) ?? PADRAO); }
    catch (error) { if (tabelaFiscalAusente(error)) throw new NumeracaoError("RECURSO_INDISPONIVEL",404,"Recurso indisponível"); throw error; }
  }
  async put(userId: string, actorUserId: string, body: unknown, configId?: string) {
    const config = await this.config(userId,configId);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) throw new NumeracaoError("RESP_TEC_INVALIDO",422,"Dados do responsável técnico inválidos");
    const i = parsed.data;
    const row = await this.repo.update(userId,config.id,actorUserId,existing => {
      const validation = validarRespTec({ ...i, csrtNovo:i.csrtToken, csrtConfigurado:!!existing?.csrtEnc },config);
      if (!validation.ok) throw new NumeracaoError("RESP_TEC_INVALIDO",422,"Revise os dados do responsável técnico",{campos:validation.erros});
      const n = validation.normalizado;
      return {modo:n.modo,cnpj:n.cnpj,xContato:n.xContato,email:n.email,fone:n.fone,idCsrt:n.idCsrt,
        csrtEnc:n.removerCsrt ? null : n.csrtNovo ? this.encrypt(n.csrtNovo) : existing?.csrtEnc ?? null};
    });
    return this.publico(config,row);
  }
  private publico(config: CompanyFiscalConfig, row: RespTecRow) {
    const { csrtEnc, ...safe } = row;
    const padraoSistema = {configurado:!!process.env.NFE_RESP_TEC_CNPJ,temCsrt:!!process.env.NFE_RESP_TEC_ID_CSRT && !!process.env.NFE_RESP_TEC_CSRT};
    return { ...safe, companyFiscalConfigId:config.id, csrtConfigurado:!!csrtEnc, modosPermitidos:modosPermitidos(config.providerName),
      avisos:avisosRespTec({...config,...safe,csrtConfigurado:!!csrtEnc,padraoSistema}) };
  }
}

/** Flag off performs no query; absent DDL retains the legacy provider policy. */
export async function resolverRespTecEmpresa(config: CompanyFiscalConfig, repo: ICompanyFiscalRespTecRepository = new CompanyFiscalRespTecRepository()): Promise<RespTecPolicy> {
  const ativo = isFiscalFeatureOn("RESP_TEC_EMPRESA",config.id);
  let row: RespTecRow | null = null;
  if (ativo) {
    try { row = await repo.find(config.userId,config.id); }
    catch (error) { if (!tabelaFiscalAusente(error)) throw error; }
  }
  return resolveRespTec(config.providerName,row,ativo,decryptFiscalSecret,config);
}
