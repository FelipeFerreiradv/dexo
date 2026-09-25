import type { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import prisma from "../../lib/prisma";
import type { NfeDraftItem, NfeDraftResponse } from "../../interfaces/nfe.interface";
import type { DevolucaoMontada } from "./montagem-manual";
import type { FonteDevolucao, TipoDevolucao, EscopoDevolucao, IndFinalDevolucao, OrigemDevolucaoSnapshot, RefDevolucaoItem } from "./tipos";
import type { LinhaSaldoDevolucao } from "./saldo";
import { DevolucaoError } from "./devolucao.errors";
import { mapearCfopDevolucao } from "../domain/devolucao-cfop";
import { tabelaFiscalAusente } from "../numeracao/numeracao.errors";

export type FiscalSql = Pick<Prisma.TransactionClient,"$queryRawUnsafe"|"$executeRawUnsafe">;
export interface CabecalhoDevolucao {
  nfeId:string;userId:string;tipo:TipoDevolucao;fonte:FonteDevolucao;escopoSolicitado:EscopoDevolucao;
  devolvidaAposEntrega:boolean|null;confirmadoSemXml:boolean;indFinal:IndFinalDevolucao;origensJson:OrigemDevolucaoSnapshot[];updatedAt:Date;
}
export type NotaDevolucao = NfeDraftResponse & {xmlAutorizadoPath:string|null;protocoloAutorizacao:string|null};
export interface DevolucaoPersistida {cabecalho:CabecalhoDevolucao;refs:RefDevolucaoItem[];nota:NotaDevolucao}
import { numeroPlaceholderRascunho } from "../domain/draft-number";

/**
 * Rascunho GERENCIADO pela devolução (com cabeçalho) numa empresa com a devolução DESLIGADA
 * (rollback por config: a empresa saiu da allowlist). A MESMA recusa no Emitir (V1), no
 * autosave e no /calculate (updateDraft): ele não emite no V1 (sairia finNFe 4 sem NFref ⇒
 * 321) e não pode virar nota comum. EXIGE_NUMERACAO_V2 (422), e não RASCUNHO_ALTERADO: a
 * frase padrão deste manda "tentar novamente" e a tela oferece o botão, que repetiria o
 * mesmo erro para sempre. A frase só promete o que existe: depois do rollback a tela não tem
 * botão para excluir este rascunho (o quadro "Devoluções em andamento" só lista empresa com a
 * devolução ligada) — quem religa a devolução ou exclui o rascunho é o suporte.
 */
export function erroRascunhoComDevolucaoDesligada(draftId:string):DevolucaoError {
  return new DevolucaoError("EXIGE_NUMERACAO_V2",undefined,{draftId,mensagem:"Este rascunho foi criado pela Devolução do Dexo, que foi desligada para esta empresa: ele não pode ser emitido nem alterado como nota comum. Fale com o suporte do Dexo para religar a devolução desta empresa (aí este rascunho volta a emitir) ou para excluir este rascunho."});
}

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
  // quantidadeOriginal + fonte: a devolução pela CHAVE (sem quantidade da nota) usa a quantidade
  // que uma devolução montada do XML já gravou para o mesmo item (saldo.quantidadeOriginalDoLivro).
  // nº/série/criação: para a tela dizer EM QUAL outra devolução o item está.
  async linhasSaldo(userId:string,chave:string,db:FiscalSql=this.db):Promise<LinhaSaldoDevolucao[]> {
    return db.$queryRawUnsafe<LinhaSaldoDevolucao[]>(`SELECT d."chaveAcessoOriginal" AS chave,d."nItemOriginal" AS "nItem",d."quantidade"::text AS quantidade,n."status" AS "statusDevolucao",d."devolucaoNfeId",
        d."quantidadeOriginal"::text AS "quantidadeOriginal",h."fonte" AS "fonteDevolucao",n."numero" AS "numeroDevolucao",n."serie" AS "serieDevolucao",n."createdAt" AS "criadaEm"
      FROM "NfeDevolucaoItem" d JOIN "NfeEmitida" n ON n."id"=d."devolucaoNfeId" AND n."userId"=d."userId"
      LEFT JOIN "NfeDevolucao" h ON h."nfeId"=d."devolucaoNfeId" AND h."userId"=d."userId"
      WHERE d."userId"=$1 AND d."chaveAcessoOriginal"=$2`,userId,chave);
  }
  /**
   * Rascunho de devolução ABERTO (DRAFT/REJECTED) que já referencia a chave. Com `tipo`,
   * só o do mesmo tipo (uma devolução de compra nunca reaproveita uma de venda).
   */
  async aberta(userId:string,chave:string,db:FiscalSql,tipo?:TipoDevolucao):Promise<string|null> {
    const rows=tipo
      ?await db.$queryRawUnsafe<{id:string}[]>(`SELECT n."id" FROM "NfeEmitida" n JOIN "NfeDevolucaoItem" d ON d."devolucaoNfeId"=n."id"
      JOIN "NfeDevolucao" h ON h."nfeId"=n."id" AND h."userId"=n."userId"
      WHERE n."userId"=$1 AND d."userId"=$1 AND d."chaveAcessoOriginal"=$2 AND n."status" IN ('DRAFT','REJECTED') AND h."tipo"=$3 ORDER BY n."updatedAt" DESC LIMIT 1`,userId,chave,tipo)
      :await db.$queryRawUnsafe<{id:string}[]>(`SELECT n."id" FROM "NfeEmitida" n JOIN "NfeDevolucaoItem" d ON d."devolucaoNfeId"=n."id"
      WHERE n."userId"=$1 AND d."userId"=$1 AND d."chaveAcessoOriginal"=$2 AND n."status" IN ('DRAFT','REJECTED') ORDER BY n."updatedAt" DESC LIMIT 1`,userId,chave);
    return rows[0]?.id??null;
  }
  async escopoDe(userId:string,nfeId:string,db:FiscalSql=this.db):Promise<EscopoDevolucao|null> {
    const rows=await db.$queryRawUnsafe<{escopoSolicitado:EscopoDevolucao}[]>(`SELECT "escopoSolicitado" FROM "NfeDevolucao" WHERE "userId"=$1 AND "nfeId"=$2`,userId,nfeId);
    return rows[0]?.escopoSolicitado??null;
  }
  /**
   * Rascunho GERENCIADO pela devolução (tem cabeçalho NfeDevolucao)? Vale com ou sem a
   * devolução ligada para a empresa: depois de um rollback por config o cabeçalho continua
   * lá, e é ele que diz que a nota não pode seguir como nota comum. `SELECT 1` pelo índice
   * único de "nfeId" (egress: nenhuma coluna). Tabela ausente ⇒ não tem.
   */
  async temCabecalho(userId:string,nfeId:string,db:FiscalSql=this.db):Promise<boolean> {
    try{return (await db.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM "NfeDevolucao" WHERE "nfeId"=$1 AND "userId"=$2 LIMIT 1`,nfeId,userId)).length>0;}
    catch(e){if(tabelaFiscalAusente(e))return false;throw e;}
  }
  /**
   * A empresa do rascunho GERENCIADO pela devolução, ou `null` quando ele não tem cabeçalho —
   * a existência e a empresa na MESMA ida ao banco, para a proteção de campos do updateDraft
   * escolher a recusa certa (devolução ligada: a de sempre; rollback por config: a do
   * rollback). Rascunho sem empresa gravada é da empresa PADRÃO (a de findByUserId, como no
   * findExistingDraft). Pelo PK da nota e o índice único de "nfeId"; tabela ausente ⇒ `null`.
   */
  async empresaDoRascunhoGerenciado(userId:string,nfeId:string,db:FiscalSql=this.db):Promise<{companyFiscalConfigId:string|null}|null> {
    try{
      const rows=await db.$queryRawUnsafe<Array<{companyFiscalConfigId:string|null}>>(`SELECT COALESCE(n."companyFiscalConfigId",(SELECT c."id" FROM "CompanyFiscalConfig" c WHERE c."userId"=n."userId" ORDER BY c."isDefault" DESC,c."createdAt" ASC LIMIT 1)) AS "companyFiscalConfigId"
        FROM "NfeEmitida" n JOIN "NfeDevolucao" d ON d."nfeId"=n."id" AND d."userId"=n."userId" WHERE n."id"=$1 AND n."userId"=$2 LIMIT 1`,nfeId,userId);
      return rows[0]?{companyFiscalConfigId:rows[0].companyFiscalConfigId}:null;
    }catch(e){if(tabelaFiscalAusente(e))return null;throw e;}
  }
  /**
   * A nota do PRÓPRIO Dexo com esta chave (NF-e de saída autorizada), para a devolução
   * manual de venda gravar o vínculo (`originalNfeId`) e a quantidade de cada item.
   * A Focus V1 guarda a chave com o prefixo "NFe": as duas grafias são procuradas.
   */
  async notaPorChave(userId:string,chave:string,db:FiscalSql=this.db):Promise<{id:string;xmlAutorizadoPath:string|null;itens:Array<{numero:number;codigo:string;quantidade:string}>}|null> {
    const rows=await db.$queryRawUnsafe<Array<{id:string;xmlAutorizadoPath:string|null;itens:Array<{numero:number;codigo:string;quantidade:string}>}>>(`SELECT n."id",n."xmlAutorizadoPath",
        COALESCE((SELECT jsonb_agg(jsonb_build_object('numero',i."numero",'codigo',i."codigo",'quantidade',i."quantidade"::text) ORDER BY i."numero") FROM "NfeItem" i WHERE i."nfeId"=n."id"),'[]'::jsonb) AS itens
      FROM "NfeEmitida" n WHERE n."userId"=$1 AND n."chaveAcesso" IN ($2,'NFe'||$2) AND n."status"='AUTHORIZED' AND n."tipoOperacao"='SAIDA' AND n."finalidade"<>'DEVOLUCAO'
      ORDER BY n."dataAutorizacao" DESC NULLS LAST LIMIT 1`,userId,chave);
    return rows[0]??null;
  }
  /**
   * Rascunhos de devolução em aberto (DRAFT/REJECTED, finalidade DEVOLUCAO) — COM ou SEM
   * cabeçalho de devolução: o rascunho feito à mão (sem NfeDevolucao) também segura número
   * e precisa aparecer para poder ser descartado. Só colunas pequenas: o `origensJson`
   * volta reduzido a chave/nº/série (ele carrega o imposto de cada item do XML).
   */
  async abertasDoUsuario(userId:string,db:FiscalSql=this.db):Promise<Array<{id:string;status:string;tipoOperacao:string;companyFiscalConfigId:string|null;createdAt:Date;updatedAt:Date;destinatarioNome:string|null;quantidadeItens:number;tipo:TipoDevolucao|null;fonte:FonteDevolucao|null;originais:Array<{chaveAcesso:string;numero:number;serie:number}>}>> {
    return db.$queryRawUnsafe(`SELECT n."id",n."status",n."tipoOperacao",n."companyFiscalConfigId",n."createdAt",n."updatedAt",n."destinatarioJson"->>'nome' AS "destinatarioNome",
        (SELECT COUNT(*)::integer FROM "NfeItem" i WHERE i."nfeId"=n."id") AS "quantidadeItens",h."tipo",h."fonte",
        COALESCE((SELECT jsonb_agg(jsonb_build_object('chaveAcesso',o->>'chaveAcesso','numero',o->'numero','serie',o->'serie')) FROM jsonb_array_elements(h."origensJson") o),'[]'::jsonb) AS "originais"
      FROM "NfeEmitida" n LEFT JOIN "NfeDevolucao" h ON h."nfeId"=n."id" AND h."userId"=n."userId"
      WHERE n."userId"=$1 AND n."finalidade"='DEVOLUCAO' AND n."status" IN ('DRAFT','REJECTED')
      ORDER BY n."updatedAt" DESC LIMIT 50`,userId);
  }
  /** Número fiscal preso a cada rascunho (reserva viva da numeração V2). Tabela ausente ⇒ nenhum. */
  async reservasVivas(userId:string,nfeIds:string[],db:FiscalSql=this.db):Promise<Array<{nfeId:string;numero:number;serie:number;estado:string;ambiente:string}>> {
    if(!nfeIds.length)return [];
    try{return await db.$queryRawUnsafe(`SELECT "nfeId","numero","serie","estado","ambiente" FROM "NfeNumeroReserva" WHERE "userId"=$1 AND "nfeId"=ANY($2::text[]) AND "estado" IN ('RESERVADO','REJEITADO','EM_TRANSMISSAO','INCERTO','BLOQUEADO')`,userId,nfeIds);}
    catch(e){if(tabelaFiscalAusente(e))return [];throw e;}
  }
  /** Configs fiscais do usuário (só id e padrão) — para saber em qual a devolução está ligada. */
  async configsDoUsuario(userId:string,db:FiscalSql=this.db):Promise<Array<{id:string;isDefault:boolean}>> {
    return db.$queryRawUnsafe(`SELECT "id","isDefault" FROM "CompanyFiscalConfig" WHERE "userId"=$1`,userId);
  }
  /**
   * As empresas do usuário para a tela escolher o CNPJ da devolução — SÓ colunas de
   * identificação (nada de token/certificado), a padrão primeiro (a mesma ordem de
   * `CompanyFiscalRepository.findByUserId`: isDefault desc, createdAt asc).
   */
  async empresasDoUsuario(userId:string,db:FiscalSql=this.db):Promise<Array<{id:string;isDefault:boolean;cnpj:string;razaoSocial:string;nomeFantasia:string|null;uf:string|null;ambiente:string}>> {
    return db.$queryRawUnsafe(`SELECT "id","isDefault","cnpj","razaoSocial","nomeFantasia","uf","ambiente" FROM "CompanyFiscalConfig" WHERE "userId"=$1 ORDER BY "isDefault" DESC,"createdAt" ASC`,userId);
  }
  /** Donos (userId) destas configs — as da allowlist da devolução (poucas; o caso de uso guarda o resultado). */
  async donosDasConfigs(ids:string[],db:FiscalSql=this.db):Promise<string[]> {
    if(!ids.length)return [];
    const rows=await db.$queryRawUnsafe<Array<{userId:string}>>(`SELECT DISTINCT "userId" FROM "CompanyFiscalConfig" WHERE "id"=ANY($1::text[])`,ids);
    return rows.map(r=>r.userId);
  }
  /** Idempotência dos passos pós-autorização (o replay depois de queda pode chamar de novo). */
  async temEvento(tx:FiscalSql,userId:string,nfeId:string,evento:string):Promise<boolean> {
    const rows=await tx.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM "NfeAuditLog" WHERE "userId"=$1 AND "nfeId"=$2 AND "evento"=$3 LIMIT 1`,userId,nfeId,evento);
    return rows.length>0;
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
  /** `escopo` (opcional): o escopo DERIVADO dos itens gravados (saldo.escopoDaDevolucao); ausente = não muda. */
  async gravarItens(tx:FiscalSql,userId:string,nfeId:string,itens:NfeDraftItem[],refs:RefDevolucaoItem[],escopo?:EscopoDevolucao):Promise<void> {
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
    await tx.$executeRawUnsafe(`UPDATE "NfeDevolucao" SET "escopoSolicitado"=COALESCE($3,"escopoSolicitado"),"updatedAt"=GREATEST(NOW(),"updatedAt"+interval '1 millisecond') WHERE "nfeId"=$1 AND "userId"=$2`,nfeId,userId,escopo??null);
  }
  async audit(tx:FiscalSql,userId:string,nfeId:string,evento:string,detalhes:Record<string,unknown>):Promise<void> {
    await tx.$executeRawUnsafe(`INSERT INTO "NfeAuditLog" ("id","nfeId","userId","evento","detalhes") VALUES ($1,$2,$3,$4,$5::jsonb)`,randomUUID(),nfeId,userId,evento,JSON.stringify(detalhes));
  }
}
