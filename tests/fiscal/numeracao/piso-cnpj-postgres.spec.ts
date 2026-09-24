// Correção 3 — prova SEMÂNTICA, contra PostgreSQL real.
//
// Opt-in, igual ao resto da família: só roda com
// NFE_TEST_DATABASE_URL=postgresql://…@127.0.0.1:<porta>/nfe_test
// (ver reference_it_postgres_real_docker). Sem ela o describe inteiro é pulado.
//
// O caso é o do VN Motors: sob a config do CNPJ 65416054000188 existem notas
// históricas IMPORTADAS cuja chave de acesso carrega o CNPJ de empresas
// anteriores do mesmo dono. A chave dessas notas tem nNF bem alto (4052 na série
// 3), e era ele que virava o piso do contador desta empresa.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { NfeNumeracaoRepository } from "../../../app/fiscal/numeracao/numeracao.repository";
import { chaveToString, montarChave } from "../../../app/fiscal/sefaz/chave-acesso";
import type { ContextoReserva } from "../../../app/fiscal/numeracao/persistencia";

const raw = process.env.NFE_TEST_DATABASE_URL;
const schema = `nfe_piso_${randomUUID().replace(/-/g, "")}`;

const CNPJ_CONFIG = "65416054000188"; // VN Motors — o emitente de verdade
const CNPJ_OUTRO = "58388093000153"; // empresa anterior do mesmo dono (série 3)
const CNPJ_TERCEIRO = "35502529000198"; // outra empresa anterior (série 2)

/**
 * Chave de acesso real (44 dígitos, DV módulo 11), pelo gerador canônico:
 * cUF 1-2, AAMM 3-6, CNPJ 7-20, mod 21-22, série 23-25, nNF 26-34, tpEmis 35, cNF 36-43, DV 44.
 */
function chave(e: { cnpj: string; modelo?: "55" | "65"; serie: number; numero: number }): string {
  return chaveToString(montarChave({
    uf: "PR", ano: 2026, mes: 9, cnpj: e.cnpj, modelo: e.modelo ?? "55",
    serie: e.serie, numero: e.numero, tpEmis: 1, cNF: "87654321",
  }));
}

describe.skipIf(!raw)("PostgreSQL isolado: piso por evidência confere o CNPJ da chave", () => {
  let db: PrismaClient;
  let repo: NfeNumeracaoRepository;

  beforeAll(async () => {
    const url = new URL(raw!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !url.pathname.includes("nfe_test")) {
      throw new Error("NFE_TEST_DATABASE_URL deve apontar a banco nfe_test em localhost");
    }
    url.searchParams.set("schema", schema);
    db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    for (const sql of [
      `CREATE TABLE "NfeEmitida" ("id" text PRIMARY KEY,"userId" text,"companyFiscalConfigId" text,"ambiente" text,"modelo" text,"serie" integer,"numero" integer,"status" text,"chaveAcesso" text)`,
      `CREATE TABLE "NfeInutilizacao" ("userId" text,"companyFiscalConfigId" text,"ambiente" text,"serie" integer,"numeroInicial" integer,"numeroFinal" integer,"status" text,"createdAt" timestamp)`,
    ]) await db.$executeRawUnsafe(sql);
    repo = new NfeNumeracaoRepository(db);

    // `numero`=0 nas históricas de propósito: é a forma em que a importação as
    // deixou (o piso nunca confiou nessa coluna). O caso com `numero` preenchido
    // tem teste próprio, no fim do arquivo.
    const nota = async (id: string, serie: number, ch: string | null, status = "AUTHORIZED", numero = 0) =>
      db.$executeRawUnsafe(
        `INSERT INTO "NfeEmitida" ("id","userId","companyFiscalConfigId","ambiente","modelo","serie","numero","status","chaveAcesso") VALUES ($1,'tenant-vn','cfg-vn','PRODUCAO','55',$2,$5,$4,$3)`,
        id, serie, ch, status, numero);

    // As históricas importadas: numeração ALTA, de OUTROS CNPJs.
    await nota("hist-s3", 3, chave({ cnpj: CNPJ_OUTRO, serie: 3, numero: 4052 }));
    await nota("hist-s2", 2, chave({ cnpj: CNPJ_TERCEIRO, serie: 2, numero: 4044 }));
    // As da própria empresa, numeração baixa (a série 3 mal começou).
    await nota("propria-s3-17", 3, chave({ cnpj: CNPJ_CONFIG, serie: 3, numero: 17 }));
    await nota("propria-s3-12", 3, chave({ cnpj: CNPJ_CONFIG, serie: 3, numero: 12 }));
    // Ruído que já era ignorado antes: outro modelo, outra série, rascunho sem chave.
    await nota("outro-modelo", 3, chave({ cnpj: CNPJ_CONFIG, modelo: "65", serie: 3, numero: 9001 }));
    await nota("sem-chave", 3, null, "DRAFT");
  }, 30000);

  afterAll(async () => {
    if (db) { await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); await db.$disconnect(); }
  });

  const contexto = (serie: number, patch: Partial<ContextoReserva> = {}): ContextoReserva => ({
    userId: "tenant-vn", nfeId: "nfe-1", isDefault: false,
    key: { cfc: "cfg-vn", ambiente: "PRODUCAO", modelo: "55", serie },
    providerName: "SEFAZ_DIRECT", emitenteSnapshot: {},
    row: { numero: -1, serie, ambiente: "PRODUCAO", companyFiscalConfigId: "cfg-vn", status: "DRAFT" },
    ...patch,
  });

  it("chave de OUTRO CNPJ deixa de contar; a do próprio CNPJ continua contando", async () => {
    expect(await repo.pisoPorEvidencia(contexto(3, { cnpjEmitente: CNPJ_CONFIG }))).toBe(17);
  });

  it("sem CNPJ informado o piso continua exatamente como era — e era o número da outra empresa", async () => {
    // Este caso é a medida do defeito: 4052 é o nNF da chave do 58388093000153.
    expect(await repo.pisoPorEvidencia(contexto(3))).toBe(4052);
  });

  it("o CNPJ vem do snapshot do emitente quando não há campo explícito", async () => {
    expect(await repo.pisoPorEvidencia(contexto(3, { emitenteSnapshot: { cnpj: "65.416.054/0001-88" } }))).toBe(17);
  });

  it("série cuja única evidência é de terceiro cai para 0 (o contador é quem manda)", async () => {
    // Série 2 do VN Motors: as 396 chaves são todas do 35502529000198.
    expect(await repo.pisoPorEvidencia(contexto(2, { cnpjEmitente: CNPJ_CONFIG }))).toBe(0);
    expect(await repo.pisoPorEvidencia(contexto(2))).toBe(4044);
  });

  it("inutilização da própria empresa continua levantando o piso (não tem chave para conferir)", async () => {
    await db.$executeRawUnsafe(
      `INSERT INTO "NfeInutilizacao" ("userId","companyFiscalConfigId","ambiente","serie","numeroInicial","numeroFinal","status","createdAt") VALUES ('tenant-vn','cfg-vn','PRODUCAO',3,18,25,'ACEITA',NOW())`);
    expect(await repo.pisoPorEvidencia(contexto(3, { cnpjEmitente: CNPJ_CONFIG }))).toBe(25);
    await db.$executeRawUnsafe(`DELETE FROM "NfeInutilizacao"`);
  });

  it("CNPJ ilegível não filtra nada (não inventa piso 0 e não trava emissão)", async () => {
    expect(await repo.pisoPorEvidencia(contexto(3, { cnpjEmitente: "654160540001" }))).toBe(4052);
  });

  it("número de terceiro que ESTA base já ocupa continua levantando o piso", async () => {
    // A metade (b) da consulta. Sem ela, tirar a numeração do terceiro da
    // evidência jogaria o contador para 1, o laço de escolha teria de pular
    // 4.052 números ocupados e desistiria em 50 (COLISOES_EXCESSIVAS): a nota
    // travaria. O número é impossível de escolher de qualquer jeito — o índice
    // único (cfc, ambiente, série, número, modelo) o reserva.
    await db.$executeRawUnsafe(
      `INSERT INTO "NfeEmitida" ("id","userId","companyFiscalConfigId","ambiente","modelo","serie","numero","status","chaveAcesso") VALUES ('ocupa-s3','tenant-vn','cfg-vn','PRODUCAO','55',3,4052,'AUTHORIZED',$1)`,
      chave({ cnpj: CNPJ_OUTRO, serie: 3, numero: 4052 }));
    expect(await repo.pisoPorEvidencia(contexto(3, { cnpjEmitente: CNPJ_CONFIG }))).toBe(4052);
    await db.$executeRawUnsafe(`DELETE FROM "NfeEmitida" WHERE "id"='ocupa-s3'`);
    // Sem a linha ocupando, o piso volta a ser só a evidência da própria empresa.
    expect(await repo.pisoPorEvidencia(contexto(3, { cnpjEmitente: CNPJ_CONFIG }))).toBe(17);
  });

  it("rascunho com número provisório continua FORA do piso", async () => {
    // O piso nunca foi MAX(numero)+1: número de rascunho não é documento emitido.
    await db.$executeRawUnsafe(
      `INSERT INTO "NfeEmitida" ("id","userId","companyFiscalConfigId","ambiente","modelo","serie","numero","status","chaveAcesso") VALUES ('rascunho-alto','tenant-vn','cfg-vn','PRODUCAO','55',3,90000,'DRAFT',NULL)`);
    expect(await repo.pisoPorEvidencia(contexto(3, { cnpjEmitente: CNPJ_CONFIG }))).toBe(17);
    await db.$executeRawUnsafe(`DELETE FROM "NfeEmitida" WHERE "id"='rascunho-alto'`);
  });
});
