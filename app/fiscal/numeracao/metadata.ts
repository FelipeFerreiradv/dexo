import { isNumeracaoV2ParaEmissao, isDevolucaoAtiva } from "../flags";
import prisma from "../../lib/prisma";
import type { Reserva } from "./persistencia";
import { CompanyFiscalRepository } from "../../repositories/company-fiscal.repository";
import { NfeNumeracaoService } from "./numeracao.service";
import { tabelaFiscalAusente } from "./numeracao.errors";
export async function configNumeracao(userId:string,d:{companyFiscalConfigId?:string|null;modelo?:string}) {
  if(process.env.NFE_NUMERACAO_V2_ENABLED!=="true")return null;
  const configs=new CompanyFiscalRepository();
  const c=d.companyFiscalConfigId?await configs.findByIdForUser(d.companyFiscalConfigId,userId):await configs.findByUserId(userId);
  return c && isNumeracaoV2ParaEmissao(c.id,d.modelo==="65"?"65":"55",c.providerName)?c:null;
}
export async function attachNumeracao<T extends {id:string;companyFiscalConfigId?:string|null;modelo?:string}>(userId:string,d:T):Promise<T> {
  if(!await configNumeracao(userId,d))return d;
  try {
    const r=await new NfeNumeracaoService().reservaViva(userId,d.id);
    return {...d,numeracao:r?{estado:r.estado,numero:r.numero,serie:r.serie,ambiente:r.ambiente,companyFiscalConfigId:r.companyFiscalConfigId,reutilizavel:["RESERVADO","REJEITADO"].includes(r.estado)}:null};
  }catch(e){if(tabelaFiscalAusente(e))return d;throw e;}
}
/**
 * Reservas da config com envio sem desfecho (EM_TRANSMISSAO/INCERTO): a consulta delas
 * usa o token/ambiente ATUAIS da config. Global desligado ⇒ [] sem consulta (I8);
 * tabela ausente ⇒ [] (sem guarda).
 */
export async function reservasPendentesDaConfig(userId:string,cfcId:string):Promise<Array<{numero:number;serie:number;ambiente:string;modelo:string;estado:string}>> {
  if(process.env.NFE_NUMERACAO_V2_ENABLED!=="true")return [];
  try{return await prisma.$queryRawUnsafe(`SELECT "numero","serie","ambiente","modelo","estado" FROM "NfeNumeroReserva" WHERE "userId"=$1 AND "companyFiscalConfigId"=$2 AND "estado" IN ('EM_TRANSMISSAO','INCERTO') ORDER BY "ambiente","modelo","serie","numero" LIMIT 20`,userId,cfcId);}
  catch(e){if(tabelaFiscalAusente(e))return [];throw e;}
}
/**
 * A nota de SAÍDA autorizada (não devolução) pode ser devolvida pelo botão "Devolver"?
 * O botão monta a devolução do XML autorizado: sem ele guardado (`xmlAutorizadoPath`) e
 * sem a Focus para buscá-lo (provedor ≠ SEFAZ direto, com token), o clique só respondia
 * "Nota sem XML autorizado no Dexo — use a devolução manual" — 447 notas da DLS (histórico
 * importado). Essas ganham `devolucaoPelaChave` no lugar, para a tela oferecer o caminho
 * que funciona. Mesma regra de `NfeDevolucaoUseCase.original()`.
 */
function candidataADevolver(n:{status?:unknown;tipoOperacao?:unknown;finalidade?:unknown}):boolean {
  return n.status==="AUTHORIZED" && n.tipoOperacao==="SAIDA" && n.finalidade!=="DEVOLUCAO";
}
export async function attachFiscalLista<T extends {id:string;companyFiscalConfigId?:string|null;modelo?:string}>(userId:string,notas:T[]):Promise<T[]> {
  if(!notas.length || (process.env.NFE_NUMERACAO_V2_ENABLED!=="true" && process.env.NFE_DEVOLUCAO_ENABLED!=="true"))return notas;
  const configs=await prisma.$queryRawUnsafe<Array<{id:string;providerName:string;isDefault:boolean;temToken?:boolean}>>('SELECT "id","providerName","isDefault",("providerToken" IS NOT NULL AND "providerToken"<>\'\') AS "temToken" FROM "CompanyFiscalConfig" WHERE "userId"=$1',userId);
  const configDe=(n:T)=>n.companyFiscalConfigId?configs.find(c=>c.id===n.companyFiscalConfigId):configs.find(c=>c.isDefault);
  const elegiveis=notas.filter(n=>{const c=configDe(n);return c && isNumeracaoV2ParaEmissao(c.id,n.modelo==="65"?"65":"55",c.providerName);});
  let reservas:Reserva[]=[];
  try{if(elegiveis.length)reservas=await prisma.$queryRawUnsafe<Reserva[]>(`SELECT * FROM "NfeNumeroReserva" WHERE "userId"=$1 AND "nfeId"=ANY($2::text[]) AND "estado" IN ('RESERVADO','REJEITADO','EM_TRANSMISSAO','INCERTO','BLOQUEADO','AUTORIZADO','CANCELADO')`,userId,elegiveis.map(n=>n.id));}catch(e){if(!tabelaFiscalAusente(e))throw e;}
  // Quem tem o XML autorizado guardado: a linha completa (GET /nfe/:id) já traz a coluna;
  // a da listagem não — para essas, UMA consulta só pelos ids que precisam da resposta.
  const semXmlConhecido=notas.filter(n=>{const c=configDe(n);return c && isDevolucaoAtiva(c.id) && candidataADevolver(n as never) && !("xmlAutorizadoPath" in n) && !(c.providerName!=="SEFAZ_DIRECT" && c.temToken===true);});
  const xmlDe=(n:T)=>(n as {xmlAutorizadoPath?:unknown}).xmlAutorizadoPath;
  const comXml=new Set<string>(notas.filter(n=>{const x=xmlDe(n);return typeof x==="string" && x!=="";}).map(n=>n.id));
  if(semXmlConhecido.length){
    const rows=await prisma.$queryRawUnsafe<Array<{id:string}>>(`SELECT "id" FROM "NfeEmitida" WHERE "userId"=$1 AND "id"=ANY($2::text[]) AND "xmlAutorizadoPath" IS NOT NULL AND "xmlAutorizadoPath"<>''`,userId,semXmlConhecido.map(n=>n.id));
    for(const r of rows)comXml.add(r.id);
  }
  return notas.map(n=>{
    const c=configDe(n);const r=reservas.find(r=>r.nfeId===n.id);
    const ativa=!!c && isDevolucaoAtiva(c.id);
    const pelaChave=ativa && candidataADevolver(n as never) && !comXml.has(n.id) && !(c!.providerName!=="SEFAZ_DIRECT" && c!.temToken===true);
    return {...n,...(elegiveis.includes(n)?{numeracao:r?{estado:r.estado,numero:r.numero,serie:r.serie,reutilizavel:["RESERVADO","REJEITADO"].includes(r.estado)}:null}:{}),
      ...(ativa && !pelaChave?{devolucaoDisponivel:true}:{}),...(pelaChave?{devolucaoPelaChave:true}:{})};
  });
}
