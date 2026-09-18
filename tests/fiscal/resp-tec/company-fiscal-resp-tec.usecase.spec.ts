import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyFiscalRespTecUseCase, resolverRespTecEmpresa } from "../../../app/usecases/company-fiscal-resp-tec.usecase";
import type { CompanyFiscalConfig } from "../../../app/interfaces/company-fiscal.interface";
import type { RespTecRow } from "../../../app/fiscal/providers/nfe-provider-resolver";
import { sanitizeDeep } from "../../../app/middlewares/logging.middleware";
import { respTecBody, respTecEndpoint } from "../../../app/notas-fiscais/lib/resp-tec-card";

afterEach(() => { vi.unstubAllEnvs(); });
function world() {
  const config = {id:"empresa",userId:"tenant",providerName:"SEFAZ_DIRECT",ambiente:"HOMOLOGACAO",uf:"SP"} as CompanyFiscalConfig;
  let row: RespTecRow | null = null;
  const repo = {find:vi.fn(async () => row),update:vi.fn(async (_u:string,_c:string,_a:string,build:(r:RespTecRow|null)=>RespTecRow) => {row=build(row);return row;})};
  const configs = {findByIdForUser:vi.fn(async (id:string,u:string) => id===config.id && u===config.userId ? config : null),findByUserId:vi.fn(async (u:string) => u===config.userId ? config:null)};
  const encrypt = vi.fn((s:string)=>`encrypted:${s}`);
  const usecase = new CompanyFiscalRespTecUseCase(repo,configs,encrypt);
  vi.stubEnv("NFE_RESP_TEC_EMPRESA_ENABLED","true");vi.stubEnv("NFE_RESP_TEC_EMPRESA_CONFIG_IDS","empresa");
  return {config,repo,configs,usecase,encrypt,row:()=>row};
}
const personalizado = {modo:"PERSONALIZADO",cnpj:"11222333000181",xContato:"Suporte",email:"suporte@example.test",fone:"11999999999",idCsrt:"01",csrtToken:"segredo-novo"};
describe("responsável técnico integrado",()=>{
  it("nega outra empresa e outro tenant sem consultar segredos",async()=>{
    const w=world();
    await expect(w.usecase.get("outro","empresa")).rejects.toMatchObject({httpStatus:404});
    await expect(w.usecase.get("tenant","outra")).rejects.toMatchObject({httpStatus:404});
    expect(w.repo.find).not.toHaveBeenCalled();
  });
  it("flag desligada não acessa a tabela nova na emissão",async()=>{
    const w=world();vi.stubEnv("NFE_RESP_TEC_EMPRESA_ENABLED","false");
    expect(await resolverRespTecEmpresa(w.config,w.repo)).toEqual({origem:"ENV_LEGADO"});
    expect(w.repo.find).not.toHaveBeenCalled();
  });
  it("DDL ausente mantém política legada; outros erros propagam",async()=>{
    const w=world();w.repo.find.mockRejectedValueOnce({code:"P2010",meta:{code:"42P01"}});
    expect(await resolverRespTecEmpresa(w.config,w.repo)).toEqual({origem:"ENV_LEGADO"});
    w.repo.find.mockRejectedValueOnce(new Error("offline"));
    await expect(resolverRespTecEmpresa(w.config,w.repo)).rejects.toThrow("offline");
  });
  it("cifra CSRT, devolve somente presença, preserva vazio e remove explicitamente",async()=>{
    const w=world();const result=await w.usecase.put("tenant","ator",personalizado,"empresa");
    expect(w.encrypt).toHaveBeenCalledWith("segredo-novo");
    expect(result.csrtConfigurado).toBe(true);expect(JSON.stringify(result)).not.toContain("segredo-novo");expect(result).not.toHaveProperty("csrtEnc");
    await w.usecase.put("tenant","ator",{...personalizado,csrtToken:""},"empresa");
    expect(w.encrypt).toHaveBeenCalledTimes(1);expect(w.row()?.csrtEnc).toBe("encrypted:segredo-novo");
    await w.usecase.put("tenant","ator",{...personalizado,csrtToken:"",idCsrt:null,removerCsrt:true},"empresa");
    expect(w.row()?.csrtEnc).toBeNull();
  });
  it("valida PR produção e modo Provedor no SEFAZ",async()=>{
    const w=world();w.config.uf="PR";w.config.ambiente="PRODUCAO";
    await expect(w.usecase.put("tenant","ator",{...personalizado,csrtToken:"",idCsrt:""})).rejects.toMatchObject({httpStatus:422});
    await expect(w.usecase.put("tenant","ator",{modo:"PROVEDOR"})).rejects.toMatchObject({httpStatus:422});
  });
  it("Focus padrão e Provedor não enviam RT",async()=>{
    const w=world();w.config.providerName="FOCUS_NFE";
    await w.usecase.put("tenant","ator",{modo:"PROVEDOR"});
    expect(await resolverRespTecEmpresa(w.config,w.repo)).toEqual({origem:"PROVEDOR"});
  });
  it("recusa campos extras e não ecoa segredo em validação",async()=>{
    const w=world();
    await expect(w.usecase.put("tenant","ator",{...personalizado,userId:"outro"})).rejects.toMatchObject({httpStatus:422});
    expect(w.repo.update).not.toHaveBeenCalled();
  });
  it("redige CSRT e XML original em objetos aninhados",()=>{
    expect(sanitizeDeep({respTec:{csrtEnc:"secret",csrtToken:"plain"},xmlOriginal:"<NFe>PII</NFe>"})).toEqual({respTec:{csrtEnc:"[REDACTED]",csrtToken:"[REDACTED]"},xmlOriginal:"[REDACTED]"});
  });
  it("card envia só campos editáveis e usa o emitente correto",()=>{
    const body=respTecBody({modo:"PADRAO",cnpj:null,xContato:null,email:null,fone:null,idCsrt:null,csrtConfigurado:true,modosPermitidos:["PADRAO"],avisos:[]},"",false);
    expect(body).not.toHaveProperty("csrtConfigurado");expect(body).not.toHaveProperty("csrtToken");
    expect(respTecEndpoint("a/b")).toBe("/fiscal/companies/a%2Fb/resp-tec");
  });
});
