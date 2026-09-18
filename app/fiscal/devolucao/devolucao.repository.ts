import type { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import prisma from "../../lib/prisma";
import type { NfeDraftItem, NfeDraftResponse } from "../../interfaces/nfe.interface";
import type { DevolucaoMontada } from "./montagem-manual";
import type { FonteDevolucao, TipoDevolucao, EscopoDevolucao, IndFinalDevolucao, OrigemDevolucaoSnapshot, RefDevolucaoItem } from "./tipos";
import type { LinhaSaldoDevolucao } from "./saldo";
import { DevolucaoError } from "./devolucao.errors";
import { mapearCfopDevolucao } from "../domain/devolucao-cfop";

export type FiscalSql = Pick<Prisma.TransactionClient,"$queryRawUnsafe"|"$executeRawUnsafe">;
export interface CabecalhoDevolucao {
  nfeId:string;userId:string;tipo:TipoDevolucao;fonte:FonteDevolucao;escopoSolicitado:EscopoDevolucao;
  devolvidaAposEntrega:boolean|null;confirmadoSemXml:boolean;indFinal:IndFinalDevolucao;origensJson:OrigemDevolucaoSnapshot[];updatedAt:Date;
}
export type NotaDevolucao = NfeDraftResponse & {xmlAutorizadoPath:string|null;protocoloAutorizacao:string|null};
export interface DevolucaoPersistida {cabecalho:CabecalhoDevolucao;refs:RefDevolucaoItem[];nota:NotaDevolucao}
import { numeroPlaceholderRascunho } from "../domain/draft-number";

export class NfeDevolucaoRepository {
  constructor(readonly db:PrismaClient=prisma) {}
  transaction<T>(fn:(tx:FiscalSql)=>Promise<T>):Promise<T> {return this.db.$transaction(fn,{maxWait:5000,timeout:15000});}
  async lockOrigens(tx:FiscalSql,userId:string,chaves:string[]):Promise<void> {
    for(const chave of [...new Set(chaves)].sort()) {
      // executeRaw avoids deserializing PostgreSQL's void result.
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,JSON.stringify([userId,chave]));
    }
  }
  async nota(userId:string,nfeId:string,db:FiscalSql=this.db):Promise<NotaDevolucao|null> {
    const rows=await db.$queryRawUnsafe<NotaDevolucao[]>(`SELECT n.*, COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i."numero") FROM "NfeItem" i WHERE i."nfeId"=n."id"),'[]'::jsonb) AS itens
      FROM "NfeEmitida" n WHERE n."userId"=$1 AND n."id"=$2`,userId,nfeId);
    const n=rows[0];if(!n)return null;
    return {...n,valorFrete:n.valorFrete==null?null:Number(n.valorFrete),itens:n.itens.map(i=>({...i,quantidade:Number(i.quantidade),valorUnitario:Number(i.valorUnitario),valorTotal:Number(i.valorTotal),desconto:i.desconto==null?null:Number(i.desconto)}))};
  }
  async get(userId:string,nfeId:string,db:FiscalSql=this.db):Promise<DevolucaoPersistida|null> {
    const hs=await db.$queryRawUnsafe<CabecalhoDevolucao[]>(`SELECT * FROM "NfeDevolucao" WHERE "userId"=$1 AND "nfeId"=$2`,userId,nfeId);
    if(!hs[0])return null;
    const nota=await this.nota(userId,nfeId,db);if(!nota)return null;
    type RefRow=Omit<RefDevolucaoItem,"impostoOriginal"|"tributacao"|"cfopOriginal"|"cfopMapeamento"> & {impostoOriginalJson:RefDevolucaoItem["impostoOriginal"];tributacaoJson:RefDevolucaoItem["tributacao"]};
    const rs=await db.$queryRawUnsafe<RefRow[]>(`SELECT * FROM "NfeDevolucaoItem" WHERE "userId"=$1 AND "devolucaoNfeId"=$2 ORDER BY "ordem"`,userId,nfeId);
    return {nota,cabecalho:hs[0],refs:rs.map(r=>{
      const origem=hs[0].origensJson.find(o=>o.chaveAcesso===r.chaveAcessoOriginal);
      const original=origem?.itens.find(i=>i.nItem===r.nItemOriginal);
      return {...r,quantidade:Number(r.quantidade),valor:Number(r.valor),quantidadeOriginal:r.quantidadeOriginal==null?null:Number(r.quantidadeOriginal),valorUnitarioOriginal:r.valorUnitarioOriginal==null?null:Number(r.valorUnitarioOriginal),
        impostoOriginal:r.impostoOriginalJson,tributacao:r.tributacaoJson,cfopOriginal:original?.cfop??null,
        cfopMapeamento:mapearCfopDevolucao({cfopOriginal:original?.cfop??"",tipo:hs[0].tipo,idDestOriginal:origem?.idDest??1})};
    })};
  }
  async linhasSaldo(userId:string,chave:string,db:FiscalSql=this.db):Promise<LinhaSaldoDevolucao[]> {
    return db.$queryRawUnsafe<LinhaSaldoDevolucao[]>(`SELECT d."chaveAcessoOriginal" AS chave,d."nItemOriginal" AS "nItem",d."quantidade"::text AS quantidade,n."status" AS "statusDevolucao",d."devolucaoNfeId"
      FROM "NfeDevolucaoItem" d JOIN "NfeEmitida" n ON n."id"=d."devolucaoNfeId" AND n."userId"=d."userId"
      WHERE d."userId"=$1 AND d."chaveAcessoOriginal"=$2`,userId,chave);
  }
  async aberta(userId:string,chave:string,db:FiscalSql):Promise<string|null> {
    const rows=await db.$queryRawUnsafe<{id:string}[]>(`SELECT n."id" FROM "NfeEmitida" n JOIN "NfeDevolucaoItem" d ON d."devolucaoNfeId"=n."id"
      WHERE n."userId"=$1 AND d."userId"=$1 AND d."chaveAcessoOriginal"=$2 AND n."status" IN ('DRAFT','REJECTED') ORDER BY n."updatedAt" DESC LIMIT 1`,userId,chave);
    return rows[0]?.id??null;
  }
  async criar(tx:FiscalSql,userId:string,actorUserId:string,m:DevolucaoMontada,confirmadoSemXml=false,devolvidaAposEntrega:boolean|null=null):Promise<string> {
    const id=randomUUID();const h=m.cabecalho;
    const [count]=await tx.$queryRawUnsafe<{n:number}[]>(`SELECT COUNT(*)::integer AS n FROM "NfeEmitida" WHERE "userId"=$1 AND "status"='DRAFT'`,userId);
    await tx.$executeRawUnsafe(`INSERT INTO "NfeEmitida" ("id","userId","customerId","companyFiscalConfigId","ambiente","modelo","serie","numero","tipoOperacao","finalidade","destinoOperacao","naturezaOperacao","indPresenca","informacoesComplementares","destinatarioJson","modalidadeFrete","pagamentosJson","status","emittedByUserId","updatedAt")
      VALUES ($1,$2,$3,$4,$5,'55',$6,$7,$8,'DEVOLUCAO',$9,$10,$11,$12,$13::jsonb,$14,$15::jsonb,'DRAFT',$16,NOW())`,
    id,userId,h.customerId,h.companyFiscalConfigId,h.ambiente,h.serie,numeroPlaceholderRascunho(count.n),h.tipoOperacao,h.destinoOperacao,h.naturezaOperacao,h.indPresenca,h.informacoesComplementares,JSON.stringify(h.destinatarioJson??{}),h.modalidadeFrete,JSON.stringify(h.pagamentosJson),actorUserId);
    await tx.$executeRawUnsafe(`INSERT INTO "NfeDevolucao" ("id","nfeId","userId","tipo","fonte","escopoSolicitado","devolvidaAposEntrega","confirmadoSemXml","indFinal","origensJson","createdByUserId")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,randomUUID(),id,userId,m.tipo,m.fonte,m.escopo,devolvidaAposEntrega,confirmadoSemXml,m.indFinal,JSON.stringify([m.origem]),actorUserId);
    await this.gravarItens(tx,userId,id,m.itens,m.refs);
    await this.audit(tx,userId,id,"DEVOLUCAO_RASCUNHO_CRIADO",{actorUserId,tipo:m.tipo,fonte:m.fonte});
    return id;
  }
  async lockRascunho(tx:FiscalSql,userId:string,nfeId:string):Promise<void> {
    const ns=await tx.$queryRawUnsafe<{status:string}[]>(`SELECT "status" FROM "NfeEmitida" WHERE "userId"=$1 AND "id"=$2 FOR UPDATE`,userId,nfeId);
    if(!ns[0])throw new DevolucaoError("NAO_ENCONTRADA");
    if(!["DRAFT","REJECTED"].includes(ns[0].status))throw new DevolucaoError("DEVOLUCAO_EM_EMISSAO");
  }
  async gravarItens(tx:FiscalSql,userId:string,nfeId:string,itens:NfeDraftItem[],refs:RefDevolucaoItem[]):Promise<void> {
    await tx.$executeRawUnsafe(`DELETE FROM "NfeItem" WHERE "nfeId"=$1 AND EXISTS(SELECT 1 FROM "NfeEmitida" WHERE "id"=$1 AND "userId"=$2)`,nfeId,userId);
    await tx.$executeRawUnsafe(`DELETE FROM "NfeDevolucaoItem" WHERE "devolucaoNfeId"=$1 AND "userId"=$2`,nfeId,userId);
    for(const [idx,i] of itens.entries()) {
      const r=refs[idx];
      if(!r || r.ordem!==i.numero)throw new DevolucaoError("RASCUNHO_ALTERADO");
      await tx.$executeRawUnsafe(`INSERT INTO "NfeItem" ("id","nfeId","productId","numero","codigo","descricao","ncm","cfop","cest","origem","unidade","quantidade","valorUnitario","valorTotal","desconto","tributosJson")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)`,randomUUID(),nfeId,i.productId??null,i.numero,i.codigo,i.descricao,i.ncm,i.cfop,i.cest??null,i.origem,i.unidade,i.quantidade,i.valorUnitario,i.valorTotal,i.desconto??null,JSON.stringify(i.tributosJson??null));
      await tx.$executeRawUnsafe(`INSERT INTO "NfeDevolucaoItem" ("id","devolucaoNfeId","userId","ordem","originalNfeId","chaveAcessoOriginal","nItemOriginal","codigoOriginal","quantidadeOriginal","valorUnitarioOriginal","quantidade","valor","impostoOriginalJson","tributacaoJson")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb)`,randomUUID(),nfeId,userId,r.ordem,r.originalNfeId,r.chaveAcessoOriginal,r.nItemOriginal,r.codigoOriginal,r.quantidadeOriginal,r.valorUnitarioOriginal,r.quantidade,r.valor,JSON.stringify(r.impostoOriginal),JSON.stringify(r.tributacao));
    }
    await tx.$executeRawUnsafe(`UPDATE "NfeEmitida" SET "status"='DRAFT',"totaisJson"=NULL,"updatedAt"=NOW() WHERE "id"=$1 AND "userId"=$2`,nfeId,userId);
    await tx.$executeRawUnsafe(`UPDATE "NfeDevolucao" SET "updatedAt"=GREATEST(NOW(),"updatedAt"+interval '1 millisecond') WHERE "nfeId"=$1 AND "userId"=$2`,nfeId,userId);
  }
  async audit(tx:FiscalSql,userId:string,nfeId:string,evento:string,detalhes:Record<string,unknown>):Promise<void> {
    await tx.$executeRawUnsafe(`INSERT INTO "NfeAuditLog" ("id","nfeId","userId","evento","detalhes") VALUES ($1,$2,$3,$4,$5::jsonb)`,randomUUID(),nfeId,userId,evento,JSON.stringify(detalhes));
  }
}
