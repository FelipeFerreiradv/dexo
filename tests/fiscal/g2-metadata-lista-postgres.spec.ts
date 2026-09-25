import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

// A lista de Notas Emitidas (NfeRepository.findEmitted REAL ⇒ attachFiscalLista) contra
// Postgres de verdade — os specs de unidade mockam o SQL; este prova as duas consultas
// novas (A2: QUALQUER reserva por nfeId; B8: updatedAt das travadas) no banco real:
//  - nota V1 rejeitada antes da virada (sem reserva) ⇒ sem `numeracao`, com `legadoV1`;
//  - reserva ABANDONADO ⇒ `numeracao:null`; BLOQUEADO ⇒ a numeração como antes;
//  - VALIDATING velha com RESERVADO ⇒ `retomavel`, na listagem E na ficha (GET /nfe/:id);
//  - config fora da V2 ⇒ nenhuma chave nova.
//
// Opt-in: NFE_TEST_DATABASE_URL=postgresql://postgres:<senha>@127.0.0.1:<porta>/nfe_test

const raw = process.env.NFE_TEST_DATABASE_URL;
const schema = `nfe_g2_${randomUUID().replace(/-/g, "")}`;
const CFC = `cfg-g2-${randomUUID().slice(0, 8)}`;
const CFC_V1 = `cfg-g2-v1-${randomUUID().slice(0, 8)}`;
const MIN = 60_000;

const describePg = describe.skipIf(!raw);
describePg("attachFiscalLista no Postgres real (A2 + B8)", () => {
  let admin: PrismaClient;
  let mods: {
    NfeRepository: typeof import("../../app/repositories/nfe.repository").NfeRepository;
    attachFiscalLista: typeof import("../../app/fiscal/numeracao/metadata").attachFiscalLista;
    prisma: PrismaClient;
  };
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const url = new URL(raw!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !url.pathname.includes("nfe_test")) {
      throw new Error("NFE_TEST_DATABASE_URL deve apontar a banco nfe_test em localhost");
    }
    url.searchParams.set("schema", schema);
    process.env.DATABASE_URL = url.toString();
    process.env.DIRECT_URL = url.toString();
    vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", "true");
    vi.stubEnv("NFE_NUMERACAO_V2_CONFIG_IDS", CFC);
    vi.stubEnv("NFE_NUMERACAO_V2_MODELOS", "55");
    vi.stubEnv("NFE_NUMERACAO_V2_FOCUS_ENABLED", "false");
    vi.stubEnv("NFE_DEVOLUCAO_ENABLED", "false");
    vi.stubEnv("NFE_NUMERACAO_V2_LEASE_PRE_ENVIO_MS", String(10 * MIN));
    vi.stubEnv("NEXT_PUBLIC_NFE_REEMISSAO_REJEITADA_ENABLED", "true");

    admin = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const diff = execFileSync("npx", ["prisma", "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/schema.prisma", "--script"], { encoding: "utf8", shell: true, env: process.env });
    const doDdl = /"(NfeNumeroReserva|NfeNumeroTentativa|CompanyFiscalRespTec|NfeDevolucao|NfeDevolucaoItem)"/;
    const stmts = diff.split(/;\s*(?:\r?\n|$)/).map((s) => s.replace(/^\s*--[^\n]*\n/gm, "").trim()).filter((s) => s && !/FOREIGN KEY/.test(s) && !doDdl.test(s));
    for (const sql of stmts) await admin.$executeRawUnsafe(sql);
    const ddl = readFileSync("prisma/ddl/2026-09-18-nfe-numeracao-v2.sql", "utf8").replace(/--[^\r\n]*/g, "");
    for (const sql of ddl.split(";").map((s) => s.trim()).filter((s) => s && !["BEGIN", "COMMIT"].includes(s))) await admin.$executeRawUnsafe(sql);

    mods = {
      NfeRepository: (await import("../../app/repositories/nfe.repository")).NfeRepository,
      attachFiscalLista: (await import("../../app/fiscal/numeracao/metadata")).attachFiscalLista,
      prisma: (await import("../../app/lib/prisma")).default,
    };

    const config = (id: string, isDefault: boolean, cnpj: string) => admin.companyFiscalConfig.create({
      data: { id, userId: "tenant", isDefault, cnpj, razaoSocial: "DESMANCHE TESTE", inscricaoEstadual: "123456789", regimeTributario: "SIMPLES", ambiente: "PRODUCAO", providerName: "SEFAZ_DIRECT", uf: "SC" },
    });
    await config(CFC, true, "11222333000181");
    await config(CFC_V1, false, "11444777000161");
    const nota = async (nome: string, cfc: string, status: string, numero: number, cStatRejeicao: number | null = null) => {
      const n = await admin.nfeEmitida.create({
        data: {
          userId: "tenant", companyFiscalConfigId: cfc, ambiente: "PRODUCAO", modelo: "55", serie: 1, numero, status, cStatRejeicao,
          tipoOperacao: "SAIDA", finalidade: "NORMAL", destinoOperacao: "INTERNA", naturezaOperacao: "VENDA", indPresenca: "NAO_SE_APLICA",
          destinatarioJson: { nome: `CLIENTE ${nome}` }, emittedByUserId: "tenant",
        },
      });
      ids[nome] = n.id;
      return n.id;
    };
    const reserva = (nfeId: string, estado: string, numero: number) => admin.$executeRawUnsafe(
      `INSERT INTO "NfeNumeroReserva" ("userId","companyFiscalConfigId","ambiente","modelo","serie","numero","nfeId","estado","origem") VALUES ('tenant',$1,'PRODUCAO','55',1,$2,$3,$4,'CONTADOR')`,
      CFC, numero, nfeId, estado);
    await nota("LEGADA", CFC, "REJECTED", 158, 225);
    await reserva(await nota("ABANDONADA", CFC, "REJECTED", 159, 225), "ABANDONADO", 159);
    await reserva(await nota("BLOQUEADA", CFC, "REJECTED", 160), "BLOQUEADO", 160);
    await reserva(await nota("TRAVADA", CFC, "VALIDATING", 161), "RESERVADO", 161);
    await reserva(await nota("RECENTE", CFC, "VALIDATING", 162), "RESERVADO", 162);
    await nota("V1", CFC_V1, "REJECTED", 5, 225);
    // A idade da trava: gravada como a app grava (relógio do host, Date do JS).
    await admin.$executeRawUnsafe(`UPDATE "NfeEmitida" SET "updatedAt"=$1 WHERE "id"=$2`, new Date(Date.now() - 30 * MIN), ids.TRAVADA);
    await admin.$executeRawUnsafe(`UPDATE "NfeEmitida" SET "updatedAt"=$1 WHERE "id"=$2`, new Date(Date.now() - 1 * MIN), ids.RECENTE);
  }, 180000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (mods?.prisma) await mods.prisma.$disconnect();
    if (admin) {
      await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.$disconnect();
    }
  });

  it("GET /fiscal/nfe (findEmitted real): legadoV1 × numeracao:null × BLOQUEADO × retomavel × V1", async () => {
    const corpo = JSON.parse(JSON.stringify(await new mods.NfeRepository().findEmitted("tenant", { page: 1, limit: 10 } as never)));
    const de = (nome: string) => corpo.notas.find((n: any) => n.id === ids[nome]);

    expect(de("LEGADA")).not.toHaveProperty("numeracao");
    expect(de("LEGADA")).toMatchObject({ legadoV1: true, reaproveitavel: true });

    expect(de("ABANDONADA")).toHaveProperty("numeracao", null);
    expect(de("ABANDONADA")).not.toHaveProperty("legadoV1");

    expect(de("BLOQUEADA")).toMatchObject({ numeracao: { estado: "BLOQUEADO", numero: 160, serie: 1, reutilizavel: false } });
    expect(de("BLOQUEADA")).not.toHaveProperty("legadoV1");

    expect(de("TRAVADA")).toMatchObject({ retomavel: true, numeracao: { estado: "RESERVADO", numero: 161 } });
    expect(de("RECENTE")).not.toHaveProperty("retomavel");

    for (const k of ["numeracao", "legadoV1", "retomavel"]) expect(de("V1"), k).not.toHaveProperty(k);
  }, 60000);

  it("GET /fiscal/nfe/:id (linha completa, já com updatedAt): mesma decisão", async () => {
    const row = await mods.prisma.nfeEmitida.findFirst({ where: { id: ids.TRAVADA, userId: "tenant" } });
    const [n] = await mods.attachFiscalLista("tenant", [row!]);
    expect(n).toMatchObject({ retomavel: true, numeracao: { estado: "RESERVADO", numero: 161 } });
    const legada = await mods.prisma.nfeEmitida.findFirst({ where: { id: ids.LEGADA, userId: "tenant" } });
    const [l] = await mods.attachFiscalLista("tenant", [legada!]);
    expect(l).not.toHaveProperty("numeracao");
    expect(l).toMatchObject({ legadoV1: true });
  }, 60000);
});
