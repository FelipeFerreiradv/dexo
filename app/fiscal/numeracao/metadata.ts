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
export async function attachFiscalLista<T extends {id:string;companyFiscalConfigId?:string|null;modelo?:string}>(userId:string,notas:T[]):Promise<T[]> {
  if(!notas.length || (process.env.NFE_NUMERACAO_V2_ENABLED!=="true" && process.env.NFE_DEVOLUCAO_ENABLED!=="true"))return notas;
  const configs=await prisma.$queryRawUnsafe<Array<{id:string;providerName:string;isDefault:boolean}>>('SELECT "id","providerName","isDefault" FROM "CompanyFiscalConfig" WHERE "userId"=$1',userId);
  const elegiveis=notas.filter(n=>{const c=n.companyFiscalConfigId?configs.find(c=>c.id===n.companyFiscalConfigId):configs.find(c=>c.isDefault);return c && isNumeracaoV2ParaEmissao(c.id,n.modelo==="65"?"65":"55",c.providerName);});
  let reservas:Reserva[]=[];
  try{if(elegiveis.length)reservas=await prisma.$queryRawUnsafe<Reserva[]>(`SELECT * FROM "NfeNumeroReserva" WHERE "userId"=$1 AND "nfeId"=ANY($2::text[]) AND "estado" IN ('RESERVADO','REJEITADO','EM_TRANSMISSAO','INCERTO','BLOQUEADO','AUTORIZADO','CANCELADO')`,userId,elegiveis.map(n=>n.id));}catch(e){if(!tabelaFiscalAusente(e))throw e;}
  return notas.map(n=>{const c=n.companyFiscalConfigId?configs.find(c=>c.id===n.companyFiscalConfigId):configs.find(c=>c.isDefault);const r=reservas.find(r=>r.nfeId===n.id);return {...n,...(elegiveis.includes(n)?{numeracao:r?{estado:r.estado,numero:r.numero,serie:r.serie,reutilizavel:["RESERVADO","REJEITADO"].includes(r.estado)}:null}:{}),...(c && isDevolucaoAtiva(c.id)?{devolucaoDisponivel:true}:{})};});
}
