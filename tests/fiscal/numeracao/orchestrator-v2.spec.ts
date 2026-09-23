import {beforeEach,afterEach,describe,it,expect,vi} from "vitest";
import {NfeEmissaoV2Orchestrator} from "../../../app/usecases/nfe-emissao-v2.orchestrator";
import {NfeNumeracaoService} from "../../../app/fiscal/numeracao/numeracao.service";
import {FakeNumeracaoRepository} from "../__harness__/fake-numeracao-repository";
import {makeDraft,makeConfig} from "../__helpers__/test-draft";
import {montarChave,chaveToString} from "../../../app/fiscal/sefaz/chave-acesso";
import type {NfeRepository} from "../../../app/repositories/nfe.repository";
import type {FiscalStorageService} from "../../../app/fiscal/storage/fiscal-storage.service";
import type {NfeDraftResponse} from "../../../app/interfaces/nfe.interface";
const state=vi.hoisted(()=>({code:100,calls:[] as number[],key:"",db:null as unknown,config:null as unknown,consulta:217,failPrepare:false,failSave:false,claimLose:false,motivo:"resposta"}));
vi.mock("../../../app/lib/prisma",()=>({default:{$executeRawUnsafe:vi.fn(async(sql:string,...args:unknown[])=>{
  const db=state.db as FakeNumeracaoRepository;
  if(sql.includes('SET "status"=\'VALIDATING\'' )){if(state.claimLose)return 0;const n=db.state.notas.get(String(args[0]));if(!n || !["DRAFT","REJECTED"].includes(n.status))return 0;n.status="VALIDATING";return 1;}
  if(sql.includes("'DRAFT'")){const n=db.state.notas.get(String(args[1]));if(n && n.status==="VALIDATING")n.status="DRAFT";return 1;}return 1;
}),$queryRawUnsafe:vi.fn(async()=>[{protocoloAutorizacao:"protocol"}])}}));
vi.mock("../../../app/repositories/company-fiscal.repository",()=>({CompanyFiscalRepository:class {findByIdForUser=async()=>state.config;}}));
vi.mock("../../../app/usecases/company-fiscal-resp-tec.usecase",()=>({resolverRespTecEmpresa:async()=>({origem:"OMITIR"})}));
vi.mock("../../../app/fiscal/providers/sefaz-direct.provider",()=>({SefazDirectProvider:class {
  prepararEmissao(p:{numero:number;cNF:string;dhEmi:Date}){if(state.failPrepare)throw new Error("falha local");return {...p,chaveAcesso:state.key,signedXml:"<signed/>",digestValue:"digest",modelo:"55",tpEmis:1};}
  async transmitirPreparada(p:{numero:number}){state.calls.push(p.numero);return {transporte:state.code===0?"TIMEOUT":null,httpStatus:200,loteCStat:104,loteXMotivo:"",protCStat:state.code||null,protXMotivo:state.motivo,nProt:state.code===100?"protocol":null,dhRecbto:new Date(),nRec:null,chNFe:state.key,protNFeXml:null,xmlAutorizado:null};}
  async consultarDetalhado(){return {transporte:null,httpStatus:200,cStat:state.consulta,xMotivo:"consulta",nProt:state.consulta===100?"protocol":null,dhRecbto:new Date(),digVal:"digest",chNFe:state.key,protNFeXml:null};}
}}));
vi.mock("../../../app/fiscal/providers/provider-factory",async()=>{const {SefazDirectProvider}=await import("../../../app/fiscal/providers/sefaz-direct.provider");return {createNfeProviderFromConfig:async(c:{providerName:string})=>c.providerName==="SEFAZ_DIRECT"?new SefazDirectProvider({} as never):{}};});
vi.mock("../../../app/fiscal/providers/focus-nfe-v2.client",()=>({FocusNfeV2Client:class {
  async emitir(p:{numero:string|number}){state.calls.push(Number(p.numero));return {httpStatus:state.code===100?201:422,transporte:null,retryAfterMs:null,corpo:{status:state.code===100?"autorizado":"erro_autorizacao",status_sefaz:String(state.code),chave_nfe:state.key,protocolo:state.code===100?"protocol":null}};}
  async consultar(){return {httpStatus:404,transporte:null,retryAfterMs:null,corpo:{codigo:"nao_encontrado"}};}
}}));

function setup(providerName:"SEFAZ_DIRECT"|"FOCUS_NFE") {
  const db=new FakeNumeracaoRepository();state.db=db;
  const config=makeConfig({providerName,providerToken:"test",isDefault:true});state.config=config;
  const base=makeDraft({userId:config.userId,companyFiscalConfigId:config.id,status:"DRAFT",numero:-1,modelo:"55",serie:1});
  const key={cfc:config.id,ambiente:config.ambiente,modelo:"55",serie:1};
  const draft=(id:string)=>({...base,...db.state.notas.get(id),id,updatedAt:new Date()}) as NfeDraftResponse;
  const seed=(id:string)=>db.state.notas.set(id,{...base,id,key,numero:-1,status:"DRAFT"});
  const service=new NfeNumeracaoService(db);
  const storage={saveXmlTentativa:async()=>{if(state.failSave)throw new Error("disco");return "/tmp/signed.xml";}} as unknown as FiscalStorageService;
  // Semântica real do NfeRepository: findDraftById só enxerga DRAFT/REJECTED; findNfeById, qualquer status.
  const repo={findDraftById:async(_u:string,id:string)=>{const d=draft(id);return ["DRAFT","REJECTED"].includes(d.status)?d:null;},findNfeById:async(_u:string,id:string)=>db.state.notas.has(id)?draft(id):null} as unknown as NfeRepository;
  const autorizado=vi.fn(async()=>({} as never));
  const uc=new NfeEmissaoV2Orchestrator({validar:()=>{},snapshot:()=>({}),autorizado},service,repo,storage);
  const emit=async(id:string)=>{const n=db.state.notas.get(id)!;const proximo=n.numero>0?n.numero:([...db.state.sequences.values()][0]?.proximoNumero??((db.state.pisos.values().next().value??0)+1));state.key=chaveToString(montarChave({uf:"SP",ano:2026,mes:9,cnpj:config.cnpj,modelo:"55",serie:1,numero:proximo,tpEmis:1,cNF:"87654321"}));return uc.emitir(config.userId,draft(id),config);};
  return {db,config,service,uc,draft,seed,emit,autorizado};
}
beforeEach(()=>{state.code=100;state.calls=[];state.consulta=217;state.failPrepare=false;state.failSave=false;state.claimLose=false;state.motivo="resposta";vi.stubEnv("NFE_DEVOLUCAO_ENABLED","false");});
afterEach(()=>{vi.unstubAllEnvs();});
describe.each(["SEFAZ_DIRECT","FOCUS_NFE"] as const)("orquestração %s",provider=>{
  it("100 autorizada → 101 rejeitada → retry 101 autorizada → próxima 102",async()=>{
    const w=setup(provider);w.db.state.pisos.set(`${w.config.userId}:${JSON.stringify([w.config.id,"HOMOLOGACAO","55",1])}`,99);
    w.seed("a");expect((await w.emit("a")).numero).toBe(100);
    w.seed("b");state.code=974;expect((await w.emit("b")).status).toBe("REJECTED");
    const retry=w.draft("b");retry.naturezaOperacao="VENDA CORRIGIDA";
    state.code=100;expect((await w.uc.emitir(w.config.userId,retry,w.config)).numero).toBe(101);
    w.seed("c");expect((await w.emit("c")).numero).toBe(102);expect(state.calls).toEqual([100,101,101,102]);
  });
  it("duplo clique transmite uma única vez",async()=>{
    const w=setup(provider);w.seed("a");await Promise.all([w.emit("a"),w.emit("a")]);expect(state.calls).toHaveLength(1);
  });
  it("replay autorizado não transmite",async()=>{const w=setup(provider);w.seed("a");await w.emit("a");await w.emit("a");expect(state.calls).toHaveLength(1);});
  it("autorização chega ao pós-autorização (XML/DANFE) e responde sucesso com a nota já AUTHORIZED",async()=>{
    const w=setup(provider);w.seed("a");
    const r=await w.emit("a");
    expect(w.db.state.notas.get("a")?.status).toBe("AUTHORIZED");
    expect(r).toMatchObject({success:true,status:"AUTHORIZED",numero:1});
    expect(w.autorizado).toHaveBeenCalledTimes(1);
  });
  it("replay de nota AUTHORIZED responde a autorização sem erro",async()=>{
    const w=setup(provider);w.seed("a");await w.emit("a");
    await expect(w.emit("a")).resolves.toMatchObject({success:true,status:"AUTHORIZED"});
    expect(w.autorizado).toHaveBeenCalledTimes(1);
  });
  it("repetição sem correção é bloqueada antes do claim",async()=>{const w=setup(provider);w.seed("a");state.code=974;await w.emit("a");await expect(w.emit("a")).rejects.toMatchObject({code:"NUMERACAO_REPETICAO"});expect(state.calls).toHaveLength(1);});
});
it("falha local ou de armazenamento não cria tentativa nem transmite",async()=>{
  for(const falha of ["failPrepare","failSave"] as const){const w=setup("SEFAZ_DIRECT");w.seed("a");state[falha]=true;await expect(w.emit("a")).rejects.toThrow();expect(w.db.state.tentativas.size).toBe(0);expect(w.db.state.notas.get("a")?.status).toBe("DRAFT");state[falha]=false;}
  expect(state.calls).toHaveLength(0);
});
// Regressão do beco sem saída do 613 (ver bloqueado-nao-e-beco-sem-saida.spec.ts).
// Aqui o caminho é o REAL, ponta a ponta: envio 613 → consulta → ramo BLOQUEADO do
// orquestrador. O xMotivo do 613 não traz chave de 44 dígitos, então `extrairChaveReferida`
// devolve null, `mesmaIdentidade` é falsa e o ramo é DETERMINÍSTICO.
it("613 sem chave referida bloqueia o número, mas NÃO deixa a nota presa em SENDING",async()=>{
  const w=setup("SEFAZ_DIRECT");w.seed("a");
  state.code=613;state.motivo="Rejeicao: Chave de Acesso difere da existente em BD";state.consulta=217;

  const r=await w.emit("a");

  expect((await w.service.reservaViva(w.config.userId,"a"))?.estado).toBe("BLOQUEADO");
  // O beco: antes desta correção a nota ficava em SENDING — invisível para o wizard
  // (findDraftById só vê DRAFT/REJECTED), fora do alcance de `consultar` e com `emitir`
  // respondendo 409. Só SQL em produção resolvia.
  expect(w.db.state.notas.get("a")?.status).not.toBe("SENDING");
  expect(w.db.state.notas.get("a")?.status).toBe("REJECTED");
  expect(r).toMatchObject({status:"REJECTED",emAndamento:false,numeracao:{estado:"BLOQUEADO",numero:1}});
  // O cStat REAL da duplicidade (613, vindo do envio) sobrevive à consulta — sem ele a nota
  // exibiria o 217 "não consta" da consulta, que não explica nada. Nada é inventado.
  expect(w.db.state.notas.get("a")?.cStatRejeicao).toBe(613);
  expect(String(w.db.state.notas.get("a")?.motivoRejeicao)).toContain("cStat 613");
  expect([...w.db.state.tentativas.values()][0]).toMatchObject({cStat:613,classe:"DUPLICIDADE_OUTRA_CHAVE"});

  // Reemitir continua barrado: o número segue retido para conferência.
  await expect(w.emit("a")).rejects.toMatchObject({code:"NUMERACAO_BLOQUEADA"});

  // A saída humana existe e exige confirmação explícita.
  await expect(w.service.abandonarPorExclusao(w.config.userId,"a",false)).rejects.toMatchObject({code:"NUMERACAO_CONFIRMAR_DESCARTE"});
  await w.service.abandonarPorExclusao(w.config.userId,"a",true);
  expect([...w.db.state.reservas.values()][0]).toMatchObject({estado:"ABANDONADO",requerInutilizacao:false});
  expect(state.calls).toEqual([1]);
});
it("timeout bloqueia reenvio até consulta madura; mantém o número",async()=>{
  const w=setup("SEFAZ_DIRECT");w.seed("a");state.code=0;
  // A nota fica SENDING: a resposta tem de ser "em andamento", nunca 404/erro.
  expect(await w.emit("a")).toMatchObject({success:false,status:"SENDING",emAndamento:true,numeracao:{estado:"INCERTO",numero:1}});
  expect((await w.service.reservaViva(w.config.userId,"a"))?.estado).toBe("INCERTO");
  expect(await w.emit("a")).toMatchObject({status:"SENDING",emAndamento:true});expect(state.calls).toHaveLength(1);
  expect(await w.uc.consultar(w.config.userId,w.draft("a"),w.config)).toMatchObject({status:"SENDING",emAndamento:true});
  for(const t of w.db.state.tentativas.values())t.transmitidaEm=new Date(Date.now()-1000000);
  await w.uc.consultar(w.config.userId,w.draft("a"),w.config);
  expect((await w.service.reservaViva(w.config.userId,"a"))?.estado).toBe("RESERVADO");expect(state.calls).toHaveLength(1);
});
