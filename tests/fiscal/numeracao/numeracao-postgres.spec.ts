import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {PrismaClient} from "@prisma/client";
import {readFileSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {NfeNumeracaoRepository} from "../../../app/fiscal/numeracao/numeracao.repository";
import {NfeNumeracaoService} from "../../../app/fiscal/numeracao/numeracao.service";
import type {ContextoReserva} from "../../../app/fiscal/numeracao/persistencia";

const raw=process.env.NFE_TEST_DATABASE_URL;
const schema=`nfe_test_${randomUUID().replace(/-/g,"")}`;
describe.skipIf(!raw)("PostgreSQL isolado: persistência V2",()=>{
  let db:PrismaClient;let svc:NfeNumeracaoService;
  beforeAll(async()=>{
    const url=new URL(raw!);
    if(!["localhost","127.0.0.1","[::1]"].includes(url.hostname) || !url.pathname.includes("nfe_test"))throw new Error("NFE_TEST_DATABASE_URL deve apontar a banco nfe_test em localhost");
    url.searchParams.set("schema",schema);url.searchParams.set("connection_limit","12");
    db=new PrismaClient({datasources:{db:{url:url.toString()}}});
    await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    for(const sql of [
      `CREATE TABLE "NfeSequence" ("id" text PRIMARY KEY,"userId" text,"companyFiscalConfigId" text,"ambiente" text,"modelo" text,"serie" integer,"proximoNumero" integer,"updatedAt" timestamp,UNIQUE("companyFiscalConfigId","ambiente","modelo","serie"))`,
      `CREATE TABLE "NfeEmitida" ("id" text PRIMARY KEY,"userId" text,"companyFiscalConfigId" text,"ambiente" text,"modelo" text,"serie" integer,"numero" integer,"status" text,"emitenteJson" jsonb,"chaveAcesso" text,"dataEmissao" timestamp,"updatedAt" timestamp DEFAULT NOW(),"motivoRejeicao" text,"cStatRejeicao" integer,"protocoloAutorizacao" text,"dataAutorizacao" timestamp,"xmlAssinadoPath" text,UNIQUE("companyFiscalConfigId","ambiente","modelo","serie","numero"))`,
      `CREATE TABLE "NfeInutilizacao" ("userId" text,"companyFiscalConfigId" text,"ambiente" text,"serie" integer,"numeroInicial" integer,"numeroFinal" integer,"status" text,"createdAt" timestamp)`,
      `CREATE TABLE "NfeAuditLog" ("id" text,"nfeId" text,"userId" text,"evento" text,"detalhes" jsonb,"createdAt" timestamp)`
    ])await db.$executeRawUnsafe(sql);
    const ddl=readFileSync("prisma/ddl/2026-09-18-nfe-numeracao-v2.sql","utf8").replace(/--[^\r\n]*/g,"");
    for(const sql of ddl.split(";").map(s=>s.trim()).filter(s=>s && !["BEGIN","COMMIT"].includes(s)))await db.$executeRawUnsafe(sql);
    svc=new NfeNumeracaoService(new NfeNumeracaoRepository(db));
  },30000);
  afterAll(async()=>{if(db){await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);await db.$disconnect();}});
  const contexto=(id:string,cfc="empresa"):ContextoReserva=>({userId:"tenant",nfeId:id,isDefault:false,key:{cfc,ambiente:"HOMOLOGACAO",modelo:"55",serie:1},providerName:"SEFAZ_DIRECT",emitenteSnapshot:{},row:{numero:-1,serie:1,ambiente:"HOMOLOGACAO",companyFiscalConfigId:cfc,status:"DRAFT"}});
  it("40 requisições concorrentes não repetem número",async()=>{
    for(let i=0;i<40;i++)await db.$executeRawUnsafe(`INSERT INTO "NfeEmitida" ("id","userId","companyFiscalConfigId","ambiente","modelo","serie","numero","status") VALUES ($1,'tenant','empresa','HOMOLOGACAO','55',1,$2,'VALIDATING')`,`n${i}`,-i-1);
    const rs=await Promise.all(Array.from({length:40},(_,i)=>svc.reservarOuReutilizar(contexto(`n${i}`))));
    expect(rs.map(r=>r.numero).sort((a,b)=>a-b)).toEqual(Array.from({length:40},(_,i)=>i+1));
  },30000);
  it("falha após incrementar reverte sequência e reserva",async()=>{
    await expect(svc.reservarOuReutilizar(contexto("inexistente","rollback"))).rejects.toMatchObject({code:"NUMERACAO_CONCORRENCIA"});
    expect(await db.$queryRawUnsafe('SELECT * FROM "NfeSequence" WHERE "companyFiscalConfigId"=$1',"rollback")).toEqual([]);
    expect(await svc.repo.reservas("tenant","inexistente")).toEqual([]);
  });
});
