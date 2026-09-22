import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { makeConfig, makeDraft } from "../../__helpers__/test-draft";

// REGRESSÃO (revisão V2, achado inutil-cancel-pdv-1): cancelamento Focus com HTTP 200 +
// status "erro_cancelamento" (SEFAZ recusou o evento) NÃO pode virar CANCELLED/CANCELADO.
// O ramo V2 usa FocusNfeV2Client.cancelar (sucesso só com "cancelado" + cStat 135/155);
// o V1 (flag global desligada) fica byte a byte igual — golden focus-v1-cancelar.
// Postgres REAL (mesmo harness de tests/fiscal/numeracao/orquestrador-v2-postgres.spec.ts):
// NfeEmitida, NfeNumeroReserva/NfeNumeroTentativa e NfeAuditLog de verdade; clientes
// Focus REAIS (V2 e, com a flag desligada, o V1 via createNfeProvider) e só o `fetch` é
// simulado. O único double é o CompanyFiscalRepository (a config não existe no banco de teste).
//
// Opt-in: NFE_TEST_DATABASE_URL=postgresql://postgres:<senha>@127.0.0.1:<porta>/nfe_test

const raw = process.env.NFE_TEST_DATABASE_URL;
const schema = `nfe_vc_${randomUUID().replace(/-/g, "")}`;

const h = vi.hoisted(() => ({ configs: new Map<string, unknown>() }));
vi.mock("../../../../app/repositories/company-fiscal.repository", () => ({
  CompanyFiscalRepository: class {
    findByIdForUser = async (id: string) => h.configs.get(id) ?? null;
    findByUserId = async () => null;
  },
}));

const ERRO_CANCELAMENTO = {
  status: "erro_cancelamento",
  status_sefaz: "501",
  mensagem_sefaz: "Rejeicao: Prazo de cancelamento superior ao previsto na Legislacao",
};
const CANCELADO = {
  status: "cancelado",
  status_sefaz: "135",
  mensagem_sefaz: "Evento registrado e vinculado a NF-e",
  protocolo: "135260000000009",
};
const JUSTIFICATIVA = "Cancelamento por erro de digitacao no pedido";

const describePg = describe.skipIf(!raw);
describePg("regressão inutil-cancel-pdv-1: cancelamento Focus V2 com erro_cancelamento — PostgreSQL real", () => {
  let admin: PrismaClient;
  let mods: {
    Cancel: typeof import("../../../../app/usecases/nfe-cancelamento.usecase").NfeCancelamentoUseCase;
    prisma: PrismaClient;
    montarChave: typeof import("../../../../app/fiscal/sefaz/chave-acesso").montarChave;
    chaveToString: typeof import("../../../../app/fiscal/sefaz/chave-acesso").chaveToString;
  };
  const chamadas: Array<{ url: string; metodo: string }> = [];
  let resposta: { status: number; json: unknown } = { status: 200, json: ERRO_CANCELAMENTO };

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
    mods = {
      Cancel: (await import("../../../../app/usecases/nfe-cancelamento.usecase")).NfeCancelamentoUseCase,
      prisma: (await import("../../../../app/lib/prisma")).default,
      montarChave: chave.montarChave,
      chaveToString: chave.chaveToString,
    };
  }, 120000);

  afterAll(async () => {
    if (mods?.prisma) await mods.prisma.$disconnect();
    if (admin) {
      await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.$disconnect();
    }
  });

  beforeEach(() => {
    chamadas.length = 0;
    resposta = { status: 200, json: ERRO_CANCELAMENTO };
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string }) => {
      chamadas.push({ url: String(url), metodo: init?.method ?? "GET" });
      return new Response(JSON.stringify(resposta.json), { status: resposta.status, headers: { "content-type": "application/json" } });
    }));
    // Canário: Kiko na allowlist, Focus ligada, modelo 55, devolução/RT desligados.
    vi.stubEnv("NFE_DEVOLUCAO_ENABLED", "false");
    vi.stubEnv("NFE_RESP_TEC_EMPRESA_ENABLED", "false");
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  function ligarV2(cfc: string) {
    vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", "true");
    vi.stubEnv("NFE_NUMERACAO_V2_CONFIG_IDS", cfc);
    vi.stubEnv("NFE_NUMERACAO_V2_MODELOS", "55");
    vi.stubEnv("NFE_NUMERACAO_V2_FOCUS_ENABLED", "true");
  }

  /** Nota Focus AUTHORIZED emitida pela V2: reserva AUTORIZADO + tentativa FECHADA/AUTORIZADA com focusRef. */
  async function notaAutorizadaV2(comReserva = true) {
    const cfc = `cfg-${randomUUID().slice(0, 8)}`;
    const config = makeConfig({ id: cfc, userId: "tenant", providerName: "FOCUS_NFE", providerToken: "TOKEN-KIKO", isDefault: true } as never);
    h.configs.set(cfc, config);
    const base = makeDraft({ userId: "tenant", companyFiscalConfigId: cfc });
    const numero = 7;
    const cNF = String(Math.floor(Math.random() * 1e8)).padStart(8, "0"); // chaveAcesso é UNIQUE global
    const chaveAcesso = mods.chaveToString(mods.montarChave({ uf: "SP", ano: 2026, mes: 9, cnpj: config.cnpj, modelo: "55", serie: 1, numero, tpEmis: 1, cNF }));
    const n = await admin.nfeEmitida.create({
      data: {
        userId: "tenant", companyFiscalConfigId: cfc, ambiente: "HOMOLOGACAO", modelo: "55", serie: 1, numero, status: "AUTHORIZED",
        tipoOperacao: base.tipoOperacao, finalidade: base.finalidade, destinoOperacao: base.destinoOperacao,
        naturezaOperacao: base.naturezaOperacao, indPresenca: base.indPresenca, destinatarioJson: base.destinatarioJson as object,
        emittedByUserId: "tenant", chaveAcesso, protocoloAutorizacao: "135260000000100",
        dataAutorizacao: new Date(Date.now() - 60 * 60 * 1000), // 1h atrás: dentro da janela local de 24h
        itens: { create: [{ numero: 1, codigo: "P1", descricao: "PECA TESTE", ncm: "87089990", cfop: "5102", origem: 0, unidade: "UN", quantidade: 1, valorUnitario: 100, valorTotal: 100 }] },
      },
    });
    const focusRef = `${n.id}n${numero}`; // formato da ref de reemissão (só alfanumérico)
    if (comReserva) {
      const [r] = await admin.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO "NfeNumeroReserva" ("userId","companyFiscalConfigId","ambiente","modelo","serie","numero","nfeId","estado","origem","cNF","consumidoEm")
         VALUES ('tenant',$1,'HOMOLOGACAO','55',1,$2,$3,'AUTORIZADO','CONTADOR',$4,NOW()) RETURNING "id"`, cfc, numero, n.id, cNF);
      await admin.$executeRawUnsafe(
        `INSERT INTO "NfeNumeroTentativa" ("reservaId","nfeId","userId","seq","provedor","ambiente","chaveAcesso","cNF","conteudoSha256","focusRef","fase","classe","prova","protocolo","transmitidaEm","respondidaEm")
         VALUES ($1,$2,'tenant',1,'FOCUS_NFE','HOMOLOGACAO',$3,$6,$4,$5,'FECHADA','AUTORIZADA','RESPOSTA_CONCLUSIVA','135260000000100',NOW()-interval '1 hour',NOW()-interval '1 hour')`,
        r.id, n.id, chaveAcesso, "a".repeat(64), focusRef, cNF);
    }
    const estado = async () => {
      const nota = (await admin.nfeEmitida.findUnique({ where: { id: n.id }, select: { status: true } }))!;
      const reservas = await admin.$queryRawUnsafe<Array<{ estado: string }>>(`SELECT "estado" FROM "NfeNumeroReserva" WHERE "nfeId"=$1`, n.id);
      const logs = await admin.$queryRawUnsafe<Array<{ evento: string }>>(`SELECT "evento" FROM "NfeAuditLog" WHERE "nfeId"=$1 ORDER BY "createdAt"`, n.id);
      return { status: nota.status, reservas: reservas.map((x) => x.estado), eventos: logs.map((x) => x.evento) };
    };
    return { cfc, id: n.id, focusRef, estado };
  }

  it("controle: 200 'cancelado' (cStat 135) cancela, reserva vai a CANCELADO e usa o focusRef da tentativa autorizada", async () => {
    const w = await notaAutorizadaV2();
    ligarV2(w.cfc);
    resposta = { status: 200, json: CANCELADO };
    const r = await new mods.Cancel().cancel("tenant", w.id, JUSTIFICATIVA);
    expect(r).toMatchObject({ success: true, status: "CANCELLED", protocolo: "135260000000009" });
    expect(chamadas).toEqual([{ url: `https://homologacao.focusnfe.com.br/v2/nfe/${encodeURIComponent(w.focusRef)}`, metodo: "DELETE" }]);
    expect(await w.estado()).toEqual({ status: "CANCELLED", reservas: ["CANCELADO"], eventos: ["CANCELADA"] });
  }, 60000);

  it("V2 ligada (canário Kiko): 200 'erro_cancelamento' (SEFAZ 501) NÃO pode virar CANCELLED/CANCELADO", async () => {
    const w = await notaAutorizadaV2();
    ligarV2(w.cfc);
    const r = await new mods.Cancel().cancel("tenant", w.id, JUSTIFICATIVA);
    const depois = await w.estado();
    // Evidência bruta (impressa para o relatório do verificador).
    console.log("[verify] resultado=", JSON.stringify(r), "banco=", JSON.stringify(depois), "fetch=", JSON.stringify(chamadas));
    expect(chamadas).toHaveLength(1); // chegou à Focus uma única vez, com o ref V2
    // Comportamento correto: a SEFAZ recusou o evento; a nota continua autorizada.
    expect(r).toMatchObject({ success: false, status: "AUTHORIZED" });
    expect(depois.status).toBe("AUTHORIZED");
    expect(depois.reservas).toEqual(["AUTORIZADO"]);
    expect(depois.eventos).toEqual(["CANCELAMENTO_REJEITADO"]);
  }, 60000);

  it("depois de um erro_cancelamento, novo cancelamento chega à Focus e conclui (sem estado terminal falso)", async () => {
    const w = await notaAutorizadaV2();
    ligarV2(w.cfc);
    await new mods.Cancel().cancel("tenant", w.id, JUSTIFICATIVA);
    // A nota continua válida na SEFAZ; o usuário tenta de novo e desta vez a SEFAZ aceita (135).
    // O correto: a segunda tentativa chega à Focus e conclui o cancelamento.
    resposta = { status: 200, json: CANCELADO };
    let segunda: unknown;
    try { segunda = await new mods.Cancel().cancel("tenant", w.id, JUSTIFICATIVA); }
    catch (e) { segunda = { lancou: (e as Error).message }; }
    console.log("[verify] segunda tentativa=", JSON.stringify(segunda), "fetch=", chamadas.length, "banco=", JSON.stringify(await w.estado()));
    expect(segunda).toMatchObject({ success: true, status: "CANCELLED" });
    expect(chamadas).toHaveLength(2);
  }, 60000);

  it("200 'cancelado' com cStat 155 (fora do prazo, homologado) também é sucesso", async () => {
    const w = await notaAutorizadaV2();
    ligarV2(w.cfc);
    resposta = { status: 200, json: { ...CANCELADO, status_sefaz: "155", mensagem_sefaz: "Cancelamento homologado fora de prazo" } };
    const r = await new mods.Cancel().cancel("tenant", w.id, JUSTIFICATIVA);
    expect(r).toMatchObject({ success: true, status: "CANCELLED" });
    expect(await w.estado()).toEqual({ status: "CANCELLED", reservas: ["CANCELADO"], eventos: ["CANCELADA"] });
  }, 60000);

  it.each([
    ["200 sem status reconhecido", { status: 200, json: { status: "processando_cancelamento" } }],
    ["200 'cancelado' com cStat 136 (evento não vinculado)", { status: 200, json: { ...CANCELADO, status_sefaz: "136" } }],
    ["422 requisicao_invalida", { status: 422, json: { codigo: "requisicao_invalida", mensagem: "Nota fiscal não autorizada" } }],
  ])("V2: %s ⇒ falha, nota segue AUTHORIZED e reserva AUTORIZADO", async (_nome, resp) => {
    const w = await notaAutorizadaV2();
    ligarV2(w.cfc);
    resposta = resp as typeof resposta;
    const r = await new mods.Cancel().cancel("tenant", w.id, JUSTIFICATIVA);
    expect(r).toMatchObject({ success: false, status: "AUTHORIZED", protocolo: null });
    expect(await w.estado()).toEqual({ status: "AUTHORIZED", reservas: ["AUTORIZADO"], eventos: ["CANCELAMENTO_REJEITADO"] });
  }, 60000);

  it("rollback (config fora da allowlist) com ledger V2: 200 'erro_cancelamento' também é falha (cliente V2 pelo ledger)", async () => {
    const w = await notaAutorizadaV2();
    ligarV2(w.cfc);
    vi.stubEnv("NFE_NUMERACAO_V2_CONFIG_IDS", "");
    const r = await new mods.Cancel().cancel("tenant", w.id, JUSTIFICATIVA);
    expect(chamadas).toEqual([{ url: `https://homologacao.focusnfe.com.br/v2/nfe/${encodeURIComponent(w.focusRef)}`, metodo: "DELETE" }]);
    expect(r).toMatchObject({ success: false, status: "AUTHORIZED" });
    expect(await w.estado()).toEqual({ status: "AUTHORIZED", reservas: ["AUTORIZADO"], eventos: ["CANCELAMENTO_REJEITADO"] });
  }, 60000);

  // DECISÃO PENDENTE DO USUÁRIO: o V1 trata QUALQUER HTTP 200 como sucesso, inclusive
  // "erro_cancelamento". Fixado pelo golden focus-v1-cancelar ('200-erro-cancelamento' ⇒
  // success:true) e mantido (I8: flag global desligada ⇒ comportamento idêntico ao atual).
  it("V2 desligada (V1, sem reserva): comportamento V1 inalterado — 200 'erro_cancelamento' grava CANCELLED (defeito V1 conhecido)", async () => {
    const w = await notaAutorizadaV2(false);
    const r = await new mods.Cancel().cancel("tenant", w.id, JUSTIFICATIVA);
    expect(chamadas).toEqual([{ url: `https://homologacao.focusnfe.com.br/v2/nfe/${w.id}`, metodo: "DELETE" }]);
    expect(r).toMatchObject({ success: true, status: "CANCELLED" });
    expect(await w.estado()).toEqual({ status: "CANCELLED", reservas: [], eventos: ["CANCELADA"] });
  }, 60000);
});
