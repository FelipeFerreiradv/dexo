import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { makeDraft } from "../../__helpers__/test-draft";

// REGRESSÃO (revisão V2, achado inutil-cancel-pdv-3): com a flag GLOBAL ligada, a ref do
// cancelamento Focus e o CANCELADO vêm do LEDGER (focusRefAutorizada), mesmo depois do rollback
// do canário (config fora da allowlist ou sub-flag Focus desligada).
//
// PostgreSQL REAL (mesmo harness de tests/fiscal/numeracao/orquestrador-v2-postgres.spec.ts) e
// SEM doubles de aplicação: NfeEmissionUseCase (despacho contextoV2 → orquestrador V2),
// NfeRepository, NfeNumeracaoRepository/Service, CompanyFiscalRepository, FocusNfeV2Client,
// NfeCancelamentoUseCase e FocusNfeProvider (V1, que faz o DELETE) são os REAIS.
// Só o `fetch` global é simulado, com a semântica de REF da Focus: cada `ref` é um documento
// independente; o DELETE /v2/nfe/{ref} cancela a nota autorizada NAQUELA ref.
//
// Roteiro (canário Kiko, Focus, homologação):
//  1. V2 ligada. Nota X: POST ?ref=X (nº 1) → a SEFAZ responde 205 (número já existe na base)
//     ⇒ reserva nº 1 CONSUMIDO_EXTERNO, nota REJECTED.
//  2. Reemitir X: nova reserva nº 2; focusRefPara ⇒ ref `${X}n2` (a ref X já foi usada).
//     POST ?ref=Xn2 → autorizada nº 2.
//  3. Rollback do canário (docs/roteiro-emissao-focus-nfe.md "Retorno ao estado anterior":
//     retirar a config da allowlist) — ou desligar a sub-flag Focus.
//  4. Usuário cancela X dentro das 24h pela UI (NfeCancelamentoUseCase.cancel).
//
// (cada ref recebe um cNF próprio para as chaves das várias notas do schema não colidirem.)
// Único stub além do transporte: handleAuthorized (download de XML/DANFE pós-autorização).

const raw = process.env.NFE_TEST_DATABASE_URL;
const schema = `nfe_vcp3_${randomUUID().replace(/-/g, "")}`;

const HOMOLOG = "https://homologacao.focusnfe.com.br";
const TOKEN = "tok-homolog-kiko-0001";
const CNPJ = "11222333000181";
const JUSTIFICATIVA = "Cancelamento solicitado pelo cliente - teste";

type Desfecho = "SEFAZ_205" | "AUTORIZA";
const h = vi.hoisted(() => ({
  calls: [] as Array<{ metodo: string; ref: string; http: number }>,
  /** Estado de cada ref na "Focus" (homologação). */
  refs: new Map<string, { numero: number; serie: number; cNF: string; status: "erro_autorizacao" | "autorizado" | "cancelado" }>(),
  /** Desfecho que a SEFAZ dará a cada POST, em ordem. */
  desfechos: [] as string[],
}));

const describePg = describe.skipIf(!raw);
describePg("regressão inutil-cancel-pdv-3: cancelamento de nota renumerada pela V2 depois do rollback do canário — PostgreSQL real", () => {
  let admin: PrismaClient;
  let mods: {
    NfeEmissionUseCase: typeof import("../../../../app/usecases/nfe-emission.usecase").NfeEmissionUseCase;
    NfeCancelamentoUseCase: typeof import("../../../../app/usecases/nfe-cancelamento.usecase").NfeCancelamentoUseCase;
    prisma: PrismaClient;
    montarChave: typeof import("../../../../app/fiscal/sefaz/chave-acesso").montarChave;
    chaveToString: typeof import("../../../../app/fiscal/sefaz/chave-acesso").chaveToString;
  };

  beforeAll(async () => {
    const url = new URL(raw!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !url.pathname.includes("nfe_test")) {
      throw new Error("NFE_TEST_DATABASE_URL deve apontar a banco nfe_test em localhost");
    }
    url.searchParams.set("schema", schema);
    process.env.DATABASE_URL = url.toString();
    admin = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const diff = execFileSync("npx", ["prisma", "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/schema.prisma", "--script"], { encoding: "utf8", shell: true, env: process.env });
    const doDdl = /"(NfeNumeroReserva|NfeNumeroTentativa|CompanyFiscalRespTec|NfeDevolucao|NfeDevolucaoItem)"/;
    const stmts = diff.split(/;\s*(?:\r?\n|$)/).map((s) => s.replace(/^\s*--[^\n]*\n/gm, "").trim()).filter((s) => s && !/FOREIGN KEY/.test(s) && !doDdl.test(s));
    for (const sql of stmts) await admin.$executeRawUnsafe(sql);
    await admin.$executeRawUnsafe(`CREATE UNIQUE INDEX "NfeSequence_cfcId_ambiente_serie_modelo_key" ON "NfeSequence"("companyFiscalConfigId","ambiente","serie","modelo") WHERE "companyFiscalConfigId" IS NOT NULL`);
    await admin.$executeRawUnsafe(`CREATE UNIQUE INDEX "NfeEmitida_cfcId_ambiente_serie_numero_modelo_key" ON "NfeEmitida"("companyFiscalConfigId","ambiente","serie","numero","modelo") WHERE "companyFiscalConfigId" IS NOT NULL AND "numero" > 0`);
    const ddl = readFileSync("prisma/ddl/2026-09-18-nfe-numeracao-v2.sql", "utf8").replace(/--[^\r\n]*/g, "");
    for (const sql of ddl.split(";").map((s) => s.trim()).filter((s) => s && !["BEGIN", "COMMIT"].includes(s))) await admin.$executeRawUnsafe(sql);

    const chave = await import("../../../../app/fiscal/sefaz/chave-acesso");
    const emission = await import("../../../../app/usecases/nfe-emission.usecase");
    vi.spyOn(emission.NfeEmissionUseCase.prototype as never, "handleAuthorized" as never).mockResolvedValue({} as never);
    mods = {
      NfeEmissionUseCase: emission.NfeEmissionUseCase,
      NfeCancelamentoUseCase: (await import("../../../../app/usecases/nfe-cancelamento.usecase")).NfeCancelamentoUseCase,
      prisma: (await import("../../../../app/lib/prisma")).default,
      montarChave: chave.montarChave,
      chaveToString: chave.chaveToString,
    };
  }, 180000);

  afterAll(async () => {
    if (mods?.prisma) await mods.prisma.$disconnect();
    if (admin) {
      await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.$disconnect();
    }
  });

  function json(status: number, corpo: unknown): Response {
    return new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });
  }

  beforeEach(() => {
    h.calls = [];
    h.refs = new Map();
    h.desfechos = [];
    vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
      const url = new URL(String(input));
      const metodo = init?.method ?? "GET";
      const partes = url.pathname.split("/");
      const ref = decodeURIComponent(metodo === "POST" ? (url.searchParams.get("ref") ?? "") : (partes[partes.length - 1] ?? ""));
      const registrar = (http: number) => h.calls.push({ metodo, ref, http });
      if (url.origin !== HOMOLOG || !url.pathname.startsWith("/v2/nfe")) { registrar(404); return new Response("not found", { status: 404 }); }
      if (metodo === "POST") {
        const payload = JSON.parse(String(init.body)) as { numero: string; serie: string };
        const desfecho = (h.desfechos.shift() ?? "AUTORIZA") as Desfecho;
        h.refs.set(ref, { numero: Number(payload.numero), serie: Number(payload.serie), cNF: String(Math.floor(Math.random() * 1e8)).padStart(8, "0"), status: desfecho === "AUTORIZA" ? "autorizado" : "erro_autorizacao" });
        registrar(202);
        return json(202, { cnpj_emitente: CNPJ, ref, status: "processando_autorizacao" });
      }
      const nota = h.refs.get(ref);
      if (!nota) { registrar(404); return json(404, { codigo: "nao_encontrado", mensagem: "Nota fiscal não encontrada" }); }
      if (metodo === "DELETE") {
        // A Focus cancela a nota autorizada NA REF informada. Ref que não chegou a autorizar ⇒ recusa.
        if (nota.status !== "autorizado") {
          registrar(422);
          return json(422, { codigo: "requisicao_invalida", mensagem: "Nota fiscal não está autorizada nesta referência, não pode ser cancelada" });
        }
        nota.status = "cancelado";
        registrar(200);
        return json(200, { status: "cancelado", status_sefaz: "135", mensagem_sefaz: "Evento registrado e vinculado a NF-e", protocolo: "135260000000777" });
      }
      registrar(200);
      if (nota.status === "erro_autorizacao") {
        return json(200, { cnpj_emitente: CNPJ, ref, status: "erro_autorizacao", status_sefaz: "205", mensagem_sefaz: "Rejeicao: NF-e esta denegada na base de dados da SEFAZ" });
      }
      const chave44 = mods.chaveToString(mods.montarChave({ uf: "SP", ano: 2026, mes: 9, cnpj: CNPJ, modelo: "55", serie: nota.serie, numero: nota.numero, tpEmis: 1, cNF: nota.cNF }));
      return json(200, {
        cnpj_emitente: CNPJ, ref, status: nota.status, status_sefaz: "100", mensagem_sefaz: "Autorizado o uso da NF-e",
        chave_nfe: `NFe${chave44}`, numero: String(nota.numero), serie: String(nota.serie), protocolo: "135260000000555",
      });
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  /** Kiko no canário V2 (Focus, homologação): nota renumerada pela V2 e autorizada na ref `${id}n2`. */
  async function notaRenumeradaAutorizada() {
    const cfc = `cfg-kiko-${randomUUID().slice(0, 8)}`;
    const USER = `tenant-kiko-${randomUUID().slice(0, 8)}`;
    await admin.companyFiscalConfig.create({ data: {
      id: cfc, userId: USER, isDefault: true, cnpj: CNPJ, razaoSocial: "KIKO 4X4 PECAS LTDA", nomeFantasia: "KIKO 4X4", inscricaoEstadual: "123456789",
      regimeTributario: "SIMPLES", cep: "01000000", logradouro: "RUA TESTE", numero: "100", bairro: "CENTRO",
      municipio: "SAO PAULO", codMunicipio: "3550308", uf: "SP", providerName: "FOCUS_NFE", serieNfe: 1, ambiente: "HOMOLOGACAO", providerToken: TOKEN,
    } });
    vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", "true");
    vi.stubEnv("NFE_NUMERACAO_V2_CONFIG_IDS", cfc);
    vi.stubEnv("NFE_NUMERACAO_V2_MODELOS", "55");
    vi.stubEnv("NFE_NUMERACAO_V2_FOCUS_ENABLED", "true");
    vi.stubEnv("NFE_DEVOLUCAO_ENABLED", "false");
    vi.stubEnv("NFE_RESP_TEC_EMPRESA_ENABLED", "false");

    const base = makeDraft({ userId: USER, companyFiscalConfigId: cfc });
    const nota = await admin.nfeEmitida.create({
      data: {
        userId: USER, companyFiscalConfigId: cfc, ambiente: "HOMOLOGACAO", modelo: "55", serie: 1, numero: -1, status: "DRAFT",
        tipoOperacao: base.tipoOperacao, finalidade: base.finalidade, destinoOperacao: base.destinoOperacao,
        naturezaOperacao: base.naturezaOperacao, indPresenca: base.indPresenca, destinatarioJson: base.destinatarioJson as object,
        emittedByUserId: USER,
        itens: { create: [{ numero: 1, codigo: "P1", descricao: "PECA TESTE", ncm: "87089990", cfop: "5102", origem: 0, unidade: "UN", quantidade: 1, valorUnitario: 100, valorTotal: 100 }] },
      },
    });
    const id = nota.id;
    const uc = new mods.NfeEmissionUseCase();

    // 1ª emissão: nº 1 já existe na SEFAZ ⇒ CONSUMIDO_EXTERNO.
    h.desfechos = ["SEFAZ_205"];
    const r1 = await uc.emit(USER, id);
    expect(r1).toMatchObject({ success: false, status: "REJECTED" });
    // 2ª emissão: nova reserva nº 2, ref renumerada, autorizada.
    const r2 = await uc.emit(USER, id);
    expect(r2).toMatchObject({ success: true, status: "AUTHORIZED", numero: 2 });

    const ledger = await admin.$queryRawUnsafe<Array<{ numero: number; estado: string; focusRef: string | null; classe: string | null }>>(
      `SELECT r."numero", r."estado", t."focusRef", t."classe" FROM "NfeNumeroReserva" r JOIN "NfeNumeroTentativa" t ON t."reservaId"=r."id" WHERE r."nfeId"=$1 ORDER BY r."numero"`, id);
    expect(ledger).toEqual([
      { numero: 1, estado: "CONSUMIDO_EXTERNO", focusRef: id, classe: "DENEGADA_NA_BASE" },
      { numero: 2, estado: "AUTORIZADO", focusRef: `${id}n2`, classe: "AUTORIZADA" },
    ]);
    h.calls = [];
    return { cfc, user: USER, id };
  }

  async function cancelar(user: string, id: string) {
    let resultado: unknown;
    try { resultado = await new mods.NfeCancelamentoUseCase().cancel(user, id, JUSTIFICATIVA); } catch (e) { resultado = { erro: (e as Error).message }; }
    const nota = await admin.nfeEmitida.findUnique({ where: { id }, select: { status: true, numero: true } });
    const reserva = await admin.$queryRawUnsafe<Array<{ estado: string }>>(`SELECT "estado" FROM "NfeNumeroReserva" WHERE "nfeId"=$1 AND "numero"=2`, id);
    return { deletes: h.calls.filter((c) => c.metodo === "DELETE").map((c) => `DELETE ${c.ref} → ${c.http}`), resultado, nota, reserva: reserva[0]?.estado };
  }

  it("CONTROLE: com o canário ainda ligado, o cancelamento usa a ref autorizada `${id}n2` e cancela", async () => {
    const w = await notaRenumeradaAutorizada();
    const obs = await cancelar(w.user, w.id);
    expect(obs).toMatchObject({
      deletes: [`DELETE ${w.id}n2 → 200`],
      resultado: { success: true, status: "CANCELLED" },
      nota: { status: "CANCELLED", numero: 2 },
      reserva: "CANCELADO",
    });
  }, 180000);

  it.each([
    ["config retirada da allowlist (roteiro 'Retorno ao estado anterior')", { NFE_NUMERACAO_V2_CONFIG_IDS: "" }],
    ["sub-flag Focus desligada", { NFE_NUMERACAO_V2_FOCUS_ENABLED: "false" }],
  ])("rollback do canário — %s: o cancelamento deve usar a ref autorizada `${id}n2`", async (_nome, env) => {
    const w = await notaRenumeradaAutorizada();
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const obs = await cancelar(w.user, w.id);
    // A Focus só conhece a autorização na ref `${id}n2`; o DELETE vai para ela e o ledger acompanha.
    expect(obs).toMatchObject({
      deletes: [`DELETE ${w.id}n2 → 200`],
      resultado: { success: true, status: "CANCELLED" },
      nota: { status: "CANCELLED", numero: 2 },
      reserva: "CANCELADO",
    });
  }, 180000);

  // I8: com a flag GLOBAL desligada nenhuma consulta ao ledger é feita — o cancelamento volta
  // ao V1 (ref = nfeId). Por isso o rollback de notas renumeradas deve ser pela allowlist ou
  // pela sub-flag, não pela flag global (limitação documentada, não regressão).
  it("flag GLOBAL desligada: V1 puro (ref = nfeId, sem ledger) — a nota renumerada não cancela pela UI", async () => {
    const w = await notaRenumeradaAutorizada();
    vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", "false");
    const obs = await cancelar(w.user, w.id);
    expect(obs).toMatchObject({
      deletes: [`DELETE ${w.id} → 422`],
      resultado: { success: false, status: "AUTHORIZED" },
      nota: { status: "AUTHORIZED", numero: 2 },
      reserva: "AUTORIZADO",
    });
  }, 180000);
});
