import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { makeConfig } from "../../__helpers__/test-draft";

// G3 (achados A3/F2/D1/B7): com a devolução ligada para a config, o cancelamento chama o
// provedor DENTRO de prisma.$transaction (lock da original + saldo das devoluções). Em
// produção o papel `postgres` tem idle_in_transaction_session_timeout=120s: enquanto a SEFAZ
// responde, a conexão da transação fica "idle in transaction" e o Postgres a derruba. A nota
// é cancelada na SEFAZ e gravada CANCELLED pela OUTRA conexão (prisma global), mas o COMMIT
// falha ⇒ o usuário recebe erro com a nota já cancelada, e o lock cai no meio da chamada.
// Correção: `SET LOCAL idle_in_transaction_session_timeout = '11min'` como 1ª instrução
// (cobre o timeout de 600 s da transação) e maxWait 30 s (= pool_timeout do Prisma).
//
// PostgreSQL REAL. O papel da aplicação é criado aqui com o timeout de ociosidade em 2 s no
// próprio papel (rolconfig, o MESMO mecanismo de produção) e a URL leva pgbouncer=true (modo
// do Supavisor em produção). Provedor simulado com atraso de 8 s (> 2 s, com folga para os
// saltos do relógio da VM do Docker).
//
// Opt-in: NFE_TEST_DATABASE_URL=postgresql://nfe:<senha>@127.0.0.1:<porta>/nfe_test

const raw = process.env.NFE_TEST_DATABASE_URL;
const sufixo = randomUUID().replace(/-/g, "");
const schema = `nfe_g3_tx_${sufixo}`;
const papel = `g3_ocioso_${sufixo.slice(0, 12)}`;
const senha = `s${sufixo.slice(12, 28)}`;

const h = vi.hoisted(() => ({
  configs: new Map<string, any>(),
  cancelCalls: [] as any[],
  atrasoMs: 0,
}));

vi.mock("../../../../app/repositories/company-fiscal.repository", () => ({
  CompanyFiscalRepository: class {
    findByIdForUser = async (id: string) => h.configs.get(id) ?? null;
    findByUserId = async () => [...h.configs.values()].find((c) => c.isDefault) ?? null;
  },
}));
vi.mock("../../../../app/fiscal/providers/provider-factory", () => {
  const p = {
    cancelar: async (i: any) => {
      h.cancelCalls.push(i);
      await new Promise((r) => setTimeout(r, h.atrasoMs));
      return { success: true, protocolo: "135260000000777", mensagem: "Evento registrado e vinculado a NF-e" };
    },
  };
  return { createNfeProvider: () => p, createNfeProviderFromConfig: async () => p };
});

const JUSTIFICATIVA = "Cancelamento de teste por erro de digitacao";
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

const describePg = describe.skipIf(!raw);
describePg("G3: cancelamento com a devolução ligada × idle_in_transaction_session_timeout (Postgres real)", () => {
  let admin: PrismaClient;
  let M: any;

  beforeAll(async () => {
    const url = new URL(raw!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !url.pathname.includes("nfe_test")) {
      throw new Error("NFE_TEST_DATABASE_URL deve apontar a banco nfe_test em localhost");
    }
    url.searchParams.set("schema", schema);
    admin = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const diff = execFileSync("npx", ["prisma", "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/schema.prisma", "--script"], { encoding: "utf8", shell: true, env: process.env });
    const doDdl = /"(NfeNumeroReserva|NfeNumeroTentativa|CompanyFiscalRespTec|NfeDevolucao|NfeDevolucaoItem)"/;
    const stmts = diff.split(/;\s*(?:\r?\n|$)/).map((s) => s.replace(/^\s*--[^\n]*\n/gm, "").trim()).filter((s) => s && !/FOREIGN KEY/.test(s) && !doDdl.test(s));
    for (const sql of stmts) await admin.$executeRawUnsafe(sql);
    for (const arq of ["prisma/ddl/2026-09-18-nfe-numeracao-v2.sql", "prisma/ddl/2026-09-18-nfe-devolucao.sql"]) {
      const ddl = readFileSync(arq, "utf8").replace(/--[^\r\n]*/g, "");
      for (const sql of ddl.split(";").map((s) => s.trim()).filter((s) => s && !["BEGIN", "COMMIT"].includes(s))) await admin.$executeRawUnsafe(sql);
    }
    // O papel da aplicação, como o `postgres` de produção: timeout de ociosidade NO PAPEL.
    await admin.$executeRawUnsafe(`CREATE ROLE "${papel}" LOGIN PASSWORD '${senha}'`);
    await admin.$executeRawUnsafe(`ALTER ROLE "${papel}" SET idle_in_transaction_session_timeout = '2s'`);
    await admin.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${schema}" TO "${papel}"`);
    await admin.$executeRawUnsafe(`GRANT ALL ON ALL TABLES IN SCHEMA "${schema}" TO "${papel}"`);
    await admin.$executeRawUnsafe(`GRANT ALL ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${papel}"`);

    const app = new URL(url.toString());
    app.username = papel;
    app.password = senha;
    app.searchParams.set("pgbouncer", "true");
    process.env.DATABASE_URL = app.toString();
    // Pool pequeno para o caso do maxWait (app/lib/prisma.ts lê na importação).
    process.env.PRISMA_CONNECTION_LIMIT = "3";
    M = {
      Cancel: (await import("../../../../app/usecases/nfe-cancelamento.usecase")).NfeCancelamentoUseCase,
      prisma: (await import("../../../../app/lib/prisma")).default,
    };
  }, 180000);

  afterAll(async () => {
    // Conexão derrubada pelo servidor pode fazer o $disconnect falhar: a limpeza roda assim mesmo.
    if (M?.prisma) await M.prisma.$disconnect().catch(() => undefined);
    if (admin) {
      await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.$executeRawUnsafe(`DROP OWNED BY "${papel}"`).catch(() => undefined);
      await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS "${papel}"`).catch(() => undefined);
      await admin.$disconnect();
    }
  }, 60000);

  let cfc: string;
  beforeEach(async () => {
    cfc = `cfg-${randomUUID().slice(0, 8)}`;
    h.configs.clear(); h.cancelCalls = []; h.atrasoMs = 0;
    h.configs.set(cfc, makeConfig({ id: cfc, userId: "tenant", providerName: "SEFAZ_DIRECT", isDefault: true } as any));
    // Devolução ligada para a config (é o que leva o cancelamento para dentro da transação).
    vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", "true");
    vi.stubEnv("NFE_NUMERACAO_V2_CONFIG_IDS", cfc);
    vi.stubEnv("NFE_NUMERACAO_V2_MODELOS", "55");
    vi.stubEnv("NFE_NUMERACAO_V2_FOCUS_ENABLED", "false");
    vi.stubEnv("NFE_DEVOLUCAO_ENABLED", "true");
    vi.stubEnv("NFE_DEVOLUCAO_CONFIG_IDS", cfc);
    await admin.$executeRawUnsafe(`DELETE FROM "NfeAuditLog"`);
    await admin.$executeRawUnsafe(`DELETE FROM "NfeItem"`);
    await admin.$executeRawUnsafe(`DELETE FROM "NfeEmitida"`);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    // Conexão derrubada pelo servidor não pode contaminar o caso seguinte.
    if (M?.prisma) await M.prisma.$disconnect().catch(() => undefined);
  });

  /** Original 55 SEFAZ direto autorizada há 1 h (sem reserva V2 e sem devolução). */
  async function criarOriginal(): Promise<string> {
    const cNF = String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
    const n = await admin.nfeEmitida.create({
      data: {
        userId: "tenant", companyFiscalConfigId: cfc, ambiente: "HOMOLOGACAO", modelo: "55", serie: 1, numero: 1, status: "AUTHORIZED",
        tipoOperacao: "SAIDA", finalidade: "NORMAL", destinoOperacao: "INTERNA", naturezaOperacao: "VENDA DE MERCADORIA", indPresenca: "PRESENCIAL",
        destinatarioJson: { nome: "CLIENTE TESTE LTDA", cpfCnpj: "00000000000100" } as object,
        emittedByUserId: "tenant",
        chaveAcesso: `352609112223330001815500100000000111${cNF}`.slice(0, 44), protocoloAutorizacao: "135260000000001",
        dataAutorizacao: new Date(Date.now() - 60 * 60 * 1000),
        itens: { create: [{ numero: 1, codigo: "PROD-001", descricao: "PRODUTO TESTE", ncm: "87089990", cfop: "5102", origem: 0, unidade: "UN", quantidade: 1, valorUnitario: 100, valorTotal: 100 }] },
      } as any,
    });
    return n.id;
  }
  async function estado(id: string) {
    return (await admin.nfeEmitida.findUnique({ where: { id }, select: { status: true } }))!.status;
  }
  async function eventos(id: string) {
    return (await admin.$queryRawUnsafe<Array<{ evento: string }>>(`SELECT "evento" FROM "NfeAuditLog" WHERE "nfeId"=$1 ORDER BY "createdAt"`, id)).map((e) => e.evento);
  }

  // Folga dos tempos: o relógio da VM do Docker dá saltos de alguns segundos, e os timers do
  // servidor (idle_in_transaction, pg_sleep) andam por ele — um salto para trás ATRASA o
  // disparo do timeout de ociosidade. Esperas que dependem do SERVIDOR têm margem larga (8 s de
  // ociosidade contra 2 s do papel: salto de até ~6 s não muda o resultado); as que só precisam
  // segurar conexão usam barreira (lock/JS), sem relógio.
  // LEITURA DO VERMELHO: se o "controle do ambiente" falhar, o ambiente NÃO reproduziu o
  // timeout nesta rodada e o resultado do ★ abaixo não vale nada (nem verde, nem vermelho) —
  // repita a rodada. Nunca é falso verde: o controle falha junto e a suíte fica vermelha.
  const OCIOSO_MS = 8000;
  it("controle do ambiente: neste papel uma transação ociosa por 8 s MORRE (reproduz o papel postgres de produção)", async () => {
    const [{ valor }] = await M.prisma.$queryRawUnsafe(`SELECT current_setting('idle_in_transaction_session_timeout') AS valor`);
    expect(valor).toBe("2s");
    const r = await M.prisma.$transaction(async (tx: any) => {
      await tx.$queryRawUnsafe(`SELECT 1 AS um`);
      await dormir(OCIOSO_MS);
      return "commit";
    }, { timeout: 20000, maxWait: 20000 }).catch((e: unknown) => `erro: ${String(e).slice(0, 200)}`);
    expect(r).not.toBe("commit");
  }, 30000);

  it("★ SEFAZ lenta (8 s > 2 s de ociosidade): o cancelamento termina com SUCESSO, nota CANCELLED — sem erro falso depois de cancelar", async () => {
    const original = await criarOriginal();
    h.atrasoMs = OCIOSO_MS;
    const r = await new M.Cancel().cancel("tenant", original, JUSTIFICATIVA).then(
      (v: unknown) => ({ ok: v }), (e: unknown) => ({ erro: String(e).slice(0, 300) }),
    );
    const diag = { resultado: r, provedor: h.cancelCalls.length, status: await estado(original), eventos: await eventos(original) };
    expect(diag, JSON.stringify(diag)).toEqual({
      resultado: { ok: { success: true, nfeId: original, status: "CANCELLED", protocolo: "135260000000777", mensagem: "NF-e cancelada com sucesso" } },
      provedor: 1,
      status: "CANCELLED",
      eventos: ["CANCELADA"],
    });
  }, 30000);

  it("o SET LOCAL não vaza: depois do cancelamento, toda conexão do pool volta ao valor do papel (seguro no pooler em modo transação)", async () => {
    const original = await criarOriginal();
    h.atrasoMs = 2500;
    await expect(new M.Cancel().cancel("tenant", original, JUSTIFICATIVA)).resolves.toMatchObject({ success: true, status: "CANCELLED" });
    // 3 transações ABERTAS AO MESMO TEMPO num pool de 3 ⇒ 3 conexões distintas (inclusive a do
    // cancelamento). Barreira em JS: cada uma só fecha quando as 3 já leram o valor.
    let chegaram = 0;
    let soltar!: () => void;
    const barreira = new Promise<void>((r) => { soltar = r; });
    const valores = await Promise.all([0, 1, 2].map(() => M.prisma.$transaction(async (tx: any) => {
      const [{ valor, pid }] = await tx.$queryRawUnsafe(`SELECT current_setting('idle_in_transaction_session_timeout') AS valor, pg_backend_pid() AS pid`);
      if (++chegaram === 3) soltar();
      await barreira;
      return { valor, pid };
    }, { timeout: 20000, maxWait: 20000 })));
    expect(new Set(valores.map((v: any) => v.pid)).size).toBe(3);
    expect(valores.map((v: any) => v.valor)).toEqual(["2s", "2s", "2s"]);
  }, 30000);

  it("★ pool cheio por ~7 s na hora de abrir a transação: o cancelamento ESPERA a conexão (maxWait 30 s) em vez de falhar aos 5 s", async () => {
    const original = await criarOriginal();
    // O pool só pode estar cheio no INSTANTE em que o cancelamento abre a transação (antes
    // disso, as consultas comuns esperariam pelo pool_timeout e mascarariam o maxWait). O
    // espião entra só nesse instante: prende as 3 conexões do pool esperando um lock que o
    // admin segura (espera de lock é consulta ATIVA, não ociosa, e não anda pelo relógio do
    // servidor), solta o lock ~7 s depois pelo relógio do teste e repassa a chamada ORIGINAL,
    // com as opções do código de produção.
    const LOCK = 7424242;
    let soltarPortao!: () => void;
    let portaoFechado = false;
    const portao = admin.$transaction(async (tx: any) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${LOCK})`);
      portaoFechado = true;
      await new Promise<void>((r) => { soltarPortao = r; });
    }, { timeout: 60000, maxWait: 10000 });
    while (!portaoFechado) await dormir(20);
    const transacaoReal = M.prisma.$transaction.bind(M.prisma);
    let ocupantes: Promise<unknown>[] = [];
    let opcoes: unknown;
    let presos = 0;
    const espiao = vi.spyOn(M.prisma, "$transaction").mockImplementationOnce(async (fn: any, opts: any) => {
      opcoes = opts;
      ocupantes = [0, 1, 2].map(() => transacaoReal(async (tx: any) => {
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${LOCK})`);
      }, { timeout: 30000, maxWait: 30000 }));
      // Só segue quando as 3 conexões do pool estão DE FATO presas no lock.
      for (let i = 0; i < 200 && presos < 3; i++) {
        presos = (await admin.$queryRawUnsafe<Array<{ n: number }>>(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'`, papel))[0].n;
        if (presos < 3) await dormir(50);
      }
      setTimeout(() => soltarPortao(), 7000);
      return transacaoReal(fn, opts);
    });
    const t0 = Date.now();
    const r = await new M.Cancel().cancel("tenant", original, JUSTIFICATIVA).then(
      (v: unknown) => ({ ok: v }), (e: unknown) => ({ erro: String(e).slice(0, 300) }),
    );
    const esperouMs = Date.now() - t0;
    soltarPortao();
    await Promise.all([portao, ...ocupantes]);
    espiao.mockRestore();
    expect(presos).toBe(3);
    const diag = { resultado: r, esperouMaisDe5s: esperouMs > 5000, status: await estado(original) };
    expect(diag, JSON.stringify({ ...diag, esperouMs, opcoes })).toEqual({
      resultado: { ok: expect.objectContaining({ success: true, status: "CANCELLED" }) },
      esperouMaisDe5s: true,
      status: "CANCELLED",
    });
  }, 40000);
});
