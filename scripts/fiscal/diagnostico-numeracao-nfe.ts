import { PrismaClient } from "@prisma/client";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Operator-run diagnostic. Does not load .env, generate DDL, or repair historical data. */
async function main() {
  if(!process.env.DATABASE_URL)throw new Error("Informe DATABASE_URL explicitamente para o diagnóstico somente leitura");
  const db=new PrismaClient();
  try {
    const report=await db.$transaction(async tx=>{
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      const tables=await tx.$queryRawUnsafe<Array<{reserva:string|null;tentativa:string|null;rt:string|null;devolucao:string|null}>>(`SELECT to_regclass('"NfeNumeroReserva"')::text AS reserva,to_regclass('"NfeNumeroTentativa"')::text AS tentativa,to_regclass('"CompanyFiscalRespTec"')::text AS rt,to_regclass('"NfeDevolucao"')::text AS devolucao`);
      const divergencias=await tx.$queryRawUnsafe<Array<{id:string;userId:string;companyFiscalConfigId:string|null;numero:number;serie:number;numeroReal:number;serieReal:number;status:string}>>(`WITH notas AS (SELECT "id","userId","companyFiscalConfigId","numero","serie","status",regexp_replace(COALESCE("chaveAcesso",''),'[^0-9]','','g') AS chave FROM "NfeEmitida" WHERE "status" IN ('AUTHORIZED','CANCELLED')) SELECT "id","userId","companyFiscalConfigId","numero","serie","status",substring(chave,26,9)::integer AS "numeroReal",substring(chave,23,3)::integer AS "serieReal" FROM notas WHERE chave~'^[0-9]{44}$' AND ("numero"<>substring(chave,26,9)::integer OR "serie"<>substring(chave,23,3)::integer)`);
      const legados=await tx.$queryRawUnsafe(`SELECT "id","userId","companyFiscalConfigId","ambiente","modelo","serie","numero","status","updatedAt" FROM "NfeEmitida" WHERE "status" IN ('SENDING','VALIDATING','SIGNING') AND "updatedAt"<NOW()-interval '15 minutes' ORDER BY "updatedAt"`);
      const contadores=await tx.$queryRawUnsafe(`SELECT s.*, (SELECT MAX(n."numero") FROM "NfeEmitida" n WHERE n."userId"=s."userId" AND n."companyFiscalConfigId" IS NOT DISTINCT FROM s."companyFiscalConfigId" AND n."ambiente"=s."ambiente" AND n."modelo"=s."modelo" AND n."serie"=s."serie" AND n."status" IN ('AUTHORIZED','CANCELLED')) AS "maiorAutorizado" FROM "NfeSequence" s`);
      // Merge occupied ranges before reporting holes; accepted inutilizações never become suggestions.
      const lacunas=await tx.$queryRawUnsafe(`WITH intervalos AS (
        SELECT s."id",s."userId",s."companyFiscalConfigId",s."ambiente",s."modelo",s."serie",0::bigint AS inicio,0::bigint AS fim FROM "NfeSequence" s
        UNION ALL SELECT s."id",s."userId",s."companyFiscalConfigId",s."ambiente",s."modelo",s."serie",s."proximoNumero",s."proximoNumero" FROM "NfeSequence" s
        UNION ALL SELECT s."id",s."userId",s."companyFiscalConfigId",s."ambiente",s."modelo",s."serie",n."numero",n."numero" FROM "NfeSequence" s JOIN "NfeEmitida" n ON n."userId"=s."userId" AND n."companyFiscalConfigId" IS NOT DISTINCT FROM s."companyFiscalConfigId" AND n."ambiente"=s."ambiente" AND n."modelo"=s."modelo" AND n."serie"=s."serie" WHERE n."status" IN ('AUTHORIZED','CANCELLED','INUTILIZED') AND n."numero">0 AND n."numero"<s."proximoNumero"
        UNION ALL SELECT s."id",s."userId",s."companyFiscalConfigId",s."ambiente",s."modelo",s."serie",GREATEST(1,i."numeroInicial"),LEAST(s."proximoNumero",i."numeroFinal") FROM "NfeSequence" s JOIN "NfeInutilizacao" i ON i."userId"=s."userId" AND i."companyFiscalConfigId" IS NOT DISTINCT FROM s."companyFiscalConfigId" AND i."ambiente"=s."ambiente" AND i."serie"=s."serie" WHERE s."modelo"='55' AND i."status"='ACEITA' AND i."numeroInicial"<s."proximoNumero"
      ), anteriores AS (SELECT *,MAX(fim) OVER (PARTITION BY "id" ORDER BY inicio,fim ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS anterior FROM intervalos)
      SELECT "userId","companyFiscalConfigId","ambiente","modelo","serie",anterior+1 AS inicio,inicio-1 AS fim,'Consultar SEFAZ antes de qualquer inutilização; números podem estar reservados.' AS sugestao FROM anteriores WHERE inicio>anterior+1`);
      const retidos=await tx.$queryRawUnsafe(`SELECT "id","userId","companyFiscalConfigId","ambiente","modelo","serie","numero","status","updatedAt",("chaveAcesso" IS NOT NULL) AS "temChave" FROM "NfeEmitida" WHERE "numero">0 AND "status" IN ('DRAFT','REJECTED','SENDING','VALIDATING','SIGNING')`);
      const historico=await tx.$queryRawUnsafe(`SELECT a."nfeId",a."userId",a."createdAt",a."detalhes"->>'numero' AS numero,a."detalhes"->>'serie' AS serie FROM "NfeAuditLog" a WHERE a."evento"='NUMERADA' ORDER BY a."nfeId",a."createdAt"`);
      // Aggregate credentials only inside PostgreSQL; no token or fingerprint leaves the database.
      const tokensCompartilhados=await tx.$queryRawUnsafe(`SELECT array_agg("id") AS configs,COUNT(DISTINCT "userId")::integer AS tenants FROM "CompanyFiscalConfig" WHERE COALESCE("providerToken",'')<>'' GROUP BY "providerToken" HAVING COUNT(DISTINCT "userId")>1`);
      const prProducao=await tx.$queryRawUnsafe(`SELECT "id","userId","providerName" FROM "CompanyFiscalConfig" WHERE "uf"='PR' AND "ambiente"='PRODUCAO'`);
      const reservas=tables[0].reserva?await tx.$queryRawUnsafe(`SELECT "id","nfeId","userId","companyFiscalConfigId","ambiente","modelo","serie","numero","estado","requerInutilizacao","leaseAte","ultimoCStat" FROM "NfeNumeroReserva" WHERE "estado" IN ('ABANDONADO','BLOQUEADO','INCERTO','EM_TRANSMISSAO')`):[];
      const integridade=tables[0].reserva?await tx.$queryRawUnsafe<unknown[]>(`SELECT "nfeId",COUNT(*)::integer AS quantidade FROM "NfeNumeroReserva" WHERE "estado" IN ('RESERVADO','REJEITADO','EM_TRANSMISSAO','INCERTO','BLOQUEADO','AUTORIZADO','CANCELADO') GROUP BY "nfeId" HAVING COUNT(*)>1`):[];
      return {geradoEm:new Date().toISOString(),somenteLeitura:true,tabelas:tables[0],divergencias,legados,contadores,lacunas,retidos,historico,tokensCompartilhados,prProducao,reservas,integridade};
    },{timeout:60000});
    const dir=resolve("scripts/out");await mkdir(dir,{recursive:true});
    const base=resolve(dir,`diagnostico-numeracao-${new Date().toISOString().replace(/[:.]/g,"-")}`);
    await writeFile(`${base}.json`,JSON.stringify(report,(_key,value)=>typeof value==="bigint"?value.toString():value,2),{encoding:"utf8",flag:"wx"});
    const csv=["id;userId;companyFiscalConfigId;numero;serie;numeroReal;serieReal;status",...report.divergencias.map(r=>[r.id,r.userId,r.companyFiscalConfigId,r.numero,r.serie,r.numeroReal,r.serieReal,r.status].map(v=>`"${String(v??"").replace(/"/g,'""')}"`).join(";"))].join("\r\n");
    await writeFile(`${base}.csv`,csv,{encoding:"utf8",flag:"wx"});
    console.log(`Diagnóstico salvo em ${base}.{json,csv}. Nenhum dado foi alterado.`);
    if(report.integridade.length)process.exitCode=1;
  }finally{await db.$disconnect();}
}
main().catch(()=>{console.error("Diagnóstico não concluído. Verifique conexão e permissão de leitura. Credenciais não são registradas.");process.exitCode=1;});
