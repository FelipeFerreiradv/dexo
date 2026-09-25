import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { makeConfig, makeDraft } from "../../__helpers__/test-draft";
import { criarSchemaNfe, urlTestePostgres, type SchemaNfe } from "../../__harness__/pg-nfe-schema";

// BLOQ-1 da prontidão V2 — inutilização × número preso em nota não autorizada, PostgreSQL REAL.
//
// O V1 inutiliza sem guarda e deixa a linha como está. Em produção, 3 das 9 inutilizações ACEITAS
// cobriram nº preso em nota REJECTED (Mesquita série 4 nº 1-2 e série 2 nº 99; Centro Jotabê
// série 4 nº 92-95). A V2 as recusava com FAIXA_COM_NUMERO_VIVO ("exclua o rascunho" — botão que
// a tela não tem para NF-e comum), e a DLS só inutilizou o nº 712 depois de um descarte por script.
//
//  (a) linha REJECTED legada (sem reserva) ⇒ inutiliza, linha intacta, e reemitir essa nota NÃO
//      reusa o número inutilizado (decidirAdocaoLegado recusa NUMERO_INUTILIZADO);
//  (b) reserva REJEITADO ⇒ 409 NUMERACAO_CONFIRMAR_DESCARTE sem confirmação; confirmada, vira
//      ABANDONADO → INUTILIZADO, a nota volta a rascunho e o contador vai a GREATEST(fim+1);
//  (c) reserva INCERTO e linha SENDING continuam barrando;
//  (d) config fora da V2 segue o V1 (sem guarda, confirmação ignorada, ledger intocado).
//
// Repositórios, NfeInutilizacaoUseCase e orquestrador REAIS; só o transporte SEFAZ e a leitura de
// CompanyFiscalConfig são simulados. Opt-in: NFE_TEST_DATABASE_URL (localhost, banco nfe_test).

const raw = urlTestePostgres();

const h = vi.hoisted(() => ({
  code: 100,
  inutSucesso: true,
  calls: [] as number[],
  inutilizacoes: [] as Array<{ ini: number; fim: number }>,
  configs: new Map<string, any>(),
}));

vi.mock("../../../../app/fiscal/providers/sefaz-direct.provider", async () => {
  const { montarChave, chaveToString } = await import("../../../../app/fiscal/sefaz/chave-acesso");
  const XMOTIVO: Record<number, string> = { 225: "Rejeicao: Falha no Schema XML", 613: "Rejeicao: Chave de Acesso difere da existente em BD" };
  class SefazDirectProvider {
    static montarNfeProc() { return "<nfeProc/>"; }
    prepararEmissao(p: { config: { cnpj: string }; draft: { serie: number }; numero: number; cNF: string; dhEmi: Date }) {
      const chaveAcesso = chaveToString(montarChave({ uf: "SP", ano: 2026, mes: 9, cnpj: p.config.cnpj, modelo: "55", serie: p.draft.serie, numero: p.numero, tpEmis: 1, cNF: p.cNF }));
      return { numero: p.numero, cNF: p.cNF, dhEmi: p.dhEmi, chaveAcesso, signedXml: "<signed/>", digestValue: "digest", modelo: "55", tpEmis: 1 };
    }
    async transmitirPreparada(p: { numero: number; chaveAcesso: string }) {
      h.calls.push(p.numero);
      if (h.code === 0) return { transporte: "TIMEOUT", httpStatus: null, loteCStat: null, loteXMotivo: null, protCStat: null, protXMotivo: null, nProt: null, dhRecbto: null, nRec: null, chNFe: null, protNFeXml: null, xmlAutorizado: null };
      return { transporte: null, httpStatus: 200, loteCStat: 104, loteXMotivo: "Lote processado", protCStat: h.code, protXMotivo: h.code === 100 ? "Autorizado o uso da NF-e" : XMOTIVO[h.code] ?? "Rejeicao: campo invalido", nProt: h.code === 100 ? "135260000000001" : null, dhRecbto: new Date(), nRec: null, chNFe: p.chaveAcesso, protNFeXml: null, xmlAutorizado: h.code === 100 ? "<nfeProc/>" : null };
    }
    async consultarDetalhado(chave: string) {
      return { transporte: null, httpStatus: 200, cStat: 217, xMotivo: "Rejeicao: NF-e nao consta na base de dados da SEFAZ", nProt: null, dhRecbto: new Date(), digVal: null, chNFe: chave, protNFeXml: null };
    }
    async inutilizar(p: { numeroInicial: number; numeroFinal: number }) {
      h.inutilizacoes.push({ ini: p.numeroInicial, fim: p.numeroFinal });
      return h.inutSucesso
        ? { success: true, protocolo: "135260000000099", mensagem: "Inutilizacao de numero homologado" }
        : { success: false, protocolo: null, mensagem: "Rejeicao: NF-e ja autorizada na faixa" };
    }
  }
  return { SefazDirectProvider };
});
vi.mock("../../../../app/fiscal/providers/provider-factory", async () => {
  const { SefazDirectProvider } = await import("../../../../app/fiscal/providers/sefaz-direct.provider");
  return {
    createNfeProviderFromConfig: async () => new SefazDirectProvider({} as never),
    createNfeProvider: () => { throw new Error("createNfeProvider não deveria ser chamado"); },
  };
});
vi.mock("../../../../app/repositories/company-fiscal.repository", () => ({
  CompanyFiscalRepository: class {
    findByIdForUser = async (id: string, userId: string) => { const c = h.configs.get(id); return c && c.userId === userId ? c : null; };
    findByUserId = async (userId: string) => [...h.configs.values()].find((c) => c.userId === userId && c.isDefault) ?? null;
  },
}));
vi.mock("../../../../app/usecases/company-fiscal-resp-tec.usecase", () => ({ resolverRespTecEmpresa: async () => ({ origem: "OMITIR" }) }));

const JUSTIFICATIVA = "Numero nao utilizado por erro de sistema";

describe.skipIf(!raw)("BLOQ-1: inutilização V2 de número preso em nota não autorizada — PostgreSQL real", () => {
  let db: SchemaNfe;
  let mods: {
    Orchestrator: typeof import("../../../../app/usecases/nfe-emissao-v2.orchestrator").NfeEmissaoV2Orchestrator;
    NfeRepository: typeof import("../../../../app/repositories/nfe.repository").NfeRepository;
    NfeInutilizacaoUseCase: typeof import("../../../../app/usecases/nfe-inutilizacao.usecase").NfeInutilizacaoUseCase;
    prisma: import("@prisma/client").PrismaClient;
    montarChave: typeof import("../../../../app/fiscal/sefaz/chave-acesso").montarChave;
    chaveToString: typeof import("../../../../app/fiscal/sefaz/chave-acesso").chaveToString;
  };

  beforeAll(async () => {
    db = await criarSchemaNfe(raw!, "nfe_g1inut");
    // O singleton app/lib/prisma lê DATABASE_URL no import: aponta para o schema descartável ANTES.
    process.env.DATABASE_URL = db.url;
    const chave = await import("../../../../app/fiscal/sefaz/chave-acesso");
    mods = {
      Orchestrator: (await import("../../../../app/usecases/nfe-emissao-v2.orchestrator")).NfeEmissaoV2Orchestrator,
      NfeRepository: (await import("../../../../app/repositories/nfe.repository")).NfeRepository,
      NfeInutilizacaoUseCase: (await import("../../../../app/usecases/nfe-inutilizacao.usecase")).NfeInutilizacaoUseCase,
      prisma: (await import("../../../../app/lib/prisma")).default,
      montarChave: chave.montarChave,
      chaveToString: chave.chaveToString,
    };
  }, 180000);

  afterAll(async () => {
    if (mods?.prisma) await mods.prisma.$disconnect();
    if (db) await db.destruir();
  });

  afterEach(() => { vi.unstubAllEnvs(); });

  function cenario(ambiente: "HOMOLOGACAO" | "PRODUCAO" = "HOMOLOGACAO") {
    h.code = 100; h.inutSucesso = true; h.calls = []; h.inutilizacoes = [];
    const userId = `tenant-${randomUUID().slice(0, 8)}`;
    const cfc = `cfg-${randomUUID().slice(0, 8)}`;
    const config = makeConfig({ id: cfc, userId, providerName: "SEFAZ_DIRECT", ambiente, isDefault: true, serieNfe: 1 } as never);
    h.configs.set(cfc, config);
    const allowlist = (ids: string, global = "true") => {
      vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", global);
      vi.stubEnv("NFE_NUMERACAO_V2_CONFIG_IDS", ids);
      vi.stubEnv("NFE_NUMERACAO_V2_MODELOS", "55");
      vi.stubEnv("NFE_NUMERACAO_V2_FOCUS_ENABLED", "false");
      vi.stubEnv("NFE_DEVOLUCAO_ENABLED", "false");
      vi.stubEnv("NFE_RESP_TEC_EMPRESA_ENABLED", "false");
    };
    allowlist(cfc);

    const base = makeDraft({ userId, companyFiscalConfigId: cfc });
    const storage = { saveXmlTentativa: async () => "/tmp/assinado.xml", readFile: async () => Buffer.from("<signed/>") };
    const repo = new mods.NfeRepository();
    const orq = new mods.Orchestrator({ validar: () => {}, snapshot: () => ({}), autorizado: async () => ({}) as never }, undefined, repo, storage as never);
    const inutUc = new mods.NfeInutilizacaoUseCase();
    const cnfFixo = String(Math.floor(Math.random() * 1e8)).padStart(8, "0"); // chaveAcesso é UNIQUE no schema inteiro
    const chaveDe = (numero: number) => mods.chaveToString(mods.montarChave({ uf: "SP", ano: 2026, mes: 9, cnpj: config.cnpj, modelo: "55", serie: 1, numero, tpEmis: 1, cNF: cnfFixo }));
    const criar = async (status = "DRAFT", numero = -1, extra: Record<string, unknown> = {}) => {
      const n = await db.admin.nfeEmitida.create({
        data: {
          userId, companyFiscalConfigId: cfc, ambiente, modelo: "55", serie: 1, numero, status,
          tipoOperacao: base.tipoOperacao, finalidade: base.finalidade, destinoOperacao: base.destinoOperacao,
          naturezaOperacao: base.naturezaOperacao, indPresenca: base.indPresenca, destinatarioJson: base.destinatarioJson as object,
          emittedByUserId: userId, ...extra,
          itens: { create: [{ numero: 1, codigo: "P1", descricao: "PECA TESTE", ncm: "87089990", cfop: "5102", origem: 0, unidade: "UN", quantidade: 1, valorUnitario: 100, valorTotal: 100 }] },
        },
      });
      return n.id;
    };
    const emitir = async (id: string) => orq.emitir(userId, (await repo.findNfeById(userId, id))!, config);
    const inutilizar = async (ini: number, fim: number, extra: Record<string, unknown> = {}) => {
      try {
        const r = await inutUc.inutilizar(userId, { serie: 1, numeroInicial: ini, numeroFinal: fim, justificativa: JUSTIFICATIVA, companyFiscalConfigId: cfc, ...extra } as never);
        return { ok: true as const, status: r.status };
      } catch (e) {
        const err = e as { code?: string; httpStatus?: number; message?: string; detalhes?: unknown };
        return { ok: false as const, code: err.code ?? null, httpStatus: err.httpStatus ?? null, detalhes: err.detalhes ?? null, mensagem: err.message ?? String(e) };
      }
    };
    const nota = async (id: string) => (await db.admin.nfeEmitida.findUnique({
      where: { id }, select: { status: true, numero: true, cStatRejeicao: true, motivoRejeicao: true, chaveAcesso: true },
    }))!;
    const reservas = () => db.admin.$queryRawUnsafe<Array<{ numero: number; estado: string; nfeId: string | null; requerInutilizacao: boolean; motivo: string | null }>>(
      `SELECT "numero","estado","nfeId","requerInutilizacao","motivo" FROM "NfeNumeroReserva" WHERE "companyFiscalConfigId"=$1 ORDER BY "numero"`, cfc);
    const inutilizacoes = () => db.admin.$queryRawUnsafe<Array<{ numeroInicial: number; numeroFinal: number; status: string }>>(
      `SELECT "numeroInicial","numeroFinal","status" FROM "NfeInutilizacao" WHERE "userId"=$1 ORDER BY "createdAt"`, userId);
    const contador = async () => (await db.admin.$queryRawUnsafe<Array<{ proximoNumero: number }>>(
      `SELECT "proximoNumero" FROM "NfeSequence" WHERE "userId"=$1 AND "companyFiscalConfigId"=$2`, userId, cfc))[0]?.proximoNumero ?? null;
    const eventos = (id: string) => db.admin.$queryRawUnsafe<Array<{ evento: string; detalhes: Record<string, unknown> | null }>>(
      `SELECT "evento","detalhes" FROM "NfeAuditLog" WHERE "nfeId"=$1 ORDER BY "createdAt","id"`, id);
    /** Nota emitida pela V2 e rejeitada (225) no nº 7 (nº 6 já autorizado). */
    const rejeitadaNo7 = async () => {
      await criar("AUTHORIZED", 6, { chaveAcesso: chaveDe(6), protocoloAutorizacao: "135250000000006" });
      const x = await criar();
      h.code = 225;
      expect(await emitir(x)).toMatchObject({ success: false, status: "REJECTED", numero: 7 });
      expect((await reservas()).map(({ numero, estado }) => ({ numero, estado }))).toEqual([{ numero: 7, estado: "REJEITADO" }]);
      h.calls = [];
      return x;
    };
    /**
     * Nota LEGADA do V1: REJECTED no nº 5 pela SEFAZ direta, com a trilha que a V2 aceitaria como
     * evidência de adoção (NUMERADA → ENVIADA SEFAZ → REJEITADA, cStat 225) e o contador do V1 em 6.
     */
    const legadaRejeitadaNo5 = async () => {
      await criar("AUTHORIZED", 4, { chaveAcesso: chaveDe(4), protocoloAutorizacao: "135250000000004" });
      const id = await criar("REJECTED", 5, { cStatRejeicao: 225, motivoRejeicao: "Rejeicao: Falha no Schema XML" });
      const t0 = Date.now() - 60 * 60 * 1000;
      const trilha = [
        { evento: "NUMERADA", detalhes: { numero: 5, serie: 1 } },
        { evento: "ENVIADA", detalhes: { providerName: "SEFAZ_DIRECT" } },
        { evento: "REJEITADA", detalhes: { mensagem: "Rejeicao: Falha no Schema XML" } },
      ];
      for (const [i, ev] of trilha.entries()) {
        await db.admin.nfeAuditLog.create({ data: { nfeId: id, userId, evento: ev.evento, detalhes: ev.detalhes, createdAt: new Date(t0 + i * 1000) } });
      }
      await db.admin.nfeSequence.create({ data: { userId, ambiente, serie: 1, modelo: "55", proximoNumero: 6, companyFiscalConfigId: cfc } });
      return id;
    };
    return { userId, cfc, config, allowlist, chaveDe, criar, emitir, inutilizar, nota, reservas, inutilizacoes, contador, eventos, rejeitadaNo7, legadaRejeitadaNo5 };
  }

  describe("(a) linha REJECTED legada do V1 (sem reserva)", () => {
    it("CONTROLE: sem inutilizar, a V2 adotaria o nº 5 dessa nota (o cenário é adotável)", async () => {
      const w = cenario();
      const legada = await w.legadaRejeitadaNo5();
      expect(await w.emitir(legada)).toMatchObject({ success: true, status: "AUTHORIZED", numero: 5 });
      expect(h.calls).toEqual([5]);
    }, 60000);

    it("inutilizar 5..5 ⇒ ACEITA sem pedir confirmação, a linha fica intacta; reemitir a nota recebe número ≠ 5", async () => {
      const w = cenario();
      const legada = await w.legadaRejeitadaNo5();
      const antes = await w.nota(legada);

      expect(await w.inutilizar(5, 5)).toEqual({ ok: true, status: "ACEITA" });
      expect(h.inutilizacoes).toEqual([{ ini: 5, fim: 5 }]);
      expect(await w.inutilizacoes()).toEqual([{ numeroInicial: 5, numeroFinal: 5, status: "ACEITA" }]);
      // Como no V1: a linha não é tocada e nenhuma reserva nasce.
      expect(await w.nota(legada)).toEqual(antes);
      expect(await w.reservas()).toEqual([]);

      // decidirAdocaoLegado recusa NUMERO_INUTILIZADO: o contador decide, nunca o 5 inutilizado.
      const emitida = await w.emitir(legada);
      expect(emitida).toMatchObject({ success: true, status: "AUTHORIZED" });
      expect(emitida.numero).not.toBe(5);
      expect(emitida.numero).toBe(6);
      expect(h.calls).toEqual([6]);
    }, 60000);

    it("rascunho DRAFT legado com número (wizard rebaixou o REJECTED) também não barra", async () => {
      const w = cenario();
      await w.criar("DRAFT", 3, { cStatRejeicao: 225 });
      expect(await w.inutilizar(3, 3)).toEqual({ ok: true, status: "ACEITA" });
    }, 60000);
  });

  describe("(b) reserva REJEITADO: descarte confirmado", () => {
    it("SEM confirmação ⇒ 409 NUMERACAO_CONFIRMAR_DESCARTE {numeros, serie}; nada chega à SEFAZ nem ao banco", async () => {
      const w = cenario();
      const x = await w.rejeitadaNo7();
      const notaAntes = await w.nota(x);

      const r = await w.inutilizar(7, 9);
      expect(r).toMatchObject({ ok: false, code: "NUMERACAO_CONFIRMAR_DESCARTE", httpStatus: 409, detalhes: { numeros: [7], serie: 1 } });
      expect((r as { mensagem: string }).mensagem).not.toMatch(/exclua|excluir/i);
      expect(h.inutilizacoes).toEqual([]);
      expect(await w.inutilizacoes()).toEqual([]);
      expect((await w.reservas())[0].estado).toBe("REJEITADO");
      expect(await w.nota(x)).toEqual(notaAntes);
    }, 60000);

    it("COM confirmação ⇒ ABANDONADO → INUTILIZADO, nota volta a DRAFT (placeholder, cStat/motivo preservados), contador GREATEST(fim+1)", async () => {
      const w = cenario();
      const x = await w.rejeitadaNo7();
      const antes = await w.nota(x);
      expect(await w.contador()).toBe(8);

      expect(await w.inutilizar(7, 9, { confirmarDescarteNumeros: true, actorUserId: "colab-9" })).toEqual({ ok: true, status: "ACEITA" });
      expect(h.inutilizacoes).toEqual([{ ini: 7, fim: 9 }]);
      expect((await w.reservas()).map(({ numero, estado, requerInutilizacao, motivo }) => ({ numero, estado, requerInutilizacao, motivo })))
        .toEqual([{ numero: 7, estado: "INUTILIZADO", requerInutilizacao: false, motivo: "INUTILIZACAO_CONFIRMADA" }]);
      const depois = await w.nota(x);
      expect(depois.status).toBe("DRAFT");
      expect(depois.numero).toBeLessThan(0);
      expect(depois.cStatRejeicao).toBe(antes.cStatRejeicao);
      expect(depois.motivoRejeicao).toBe(antes.motivoRejeicao);
      expect(depois.chaveAcesso).toBeNull();
      expect(await w.contador()).toBe(10);
      // Mesmo evento de auditoria do descarte já existente.
      const descarte = (await w.eventos(x)).filter((e) => e.evento === "NUMERACAO_DESCARTADA");
      expect(descarte).toHaveLength(1);
      expect(descarte[0].detalhes).toMatchObject({ actorUserId: "colab-9", numero: 7, serie: 1, motivo: "INUTILIZACAO_CONFIRMADA", confirmado: true });

      // "Emitir" de novo: número novo do contador, nunca o 7 inutilizado.
      h.code = 100;
      expect(await w.emitir(x)).toMatchObject({ success: true, status: "AUTHORIZED", numero: 10 });
      expect(h.calls).toEqual([10]);
    }, 60000);

    it("PRODUÇÃO + SEFAZ recusa a inutilização ⇒ REJEITADA, reserva ABANDONADO com requerInutilizacao, o nº não volta ao pool", async () => {
      const w = cenario("PRODUCAO");
      const x = await w.rejeitadaNo7();
      h.inutSucesso = false;

      expect(await w.inutilizar(7, 7, { confirmarDescarteNumeros: true })).toEqual({ ok: true, status: "REJEITADA" });
      expect(await w.inutilizacoes()).toEqual([{ numeroInicial: 7, numeroFinal: 7, status: "REJEITADA" }]);
      expect((await w.reservas()).map(({ numero, estado, requerInutilizacao }) => ({ numero, estado, requerInutilizacao })))
        .toEqual([{ numero: 7, estado: "ABANDONADO", requerInutilizacao: true }]);
      expect((await w.nota(x)).status).toBe("DRAFT");
      expect(await w.contador()).toBe(8);

      h.code = 100;
      expect(await w.emitir(x)).toMatchObject({ success: true, status: "AUTHORIZED", numero: 8 });
      // Nova tentativa de inutilizar o 7: a reserva ABANDONADO não barra nem pede confirmação.
      h.inutSucesso = true;
      expect(await w.inutilizar(7, 7)).toEqual({ ok: true, status: "ACEITA" });
      expect((await w.reservas()).find((r) => r.numero === 7)).toMatchObject({ estado: "INUTILIZADO", requerInutilizacao: false });
    }, 60000);
  });

  describe("(c) o que pode estar na SEFAZ continua barrando", () => {
    it("reserva INCERTO (envio sem resposta) ⇒ FAIXA_COM_NUMERO_VIVO mesmo confirmando; nada chega à SEFAZ", async () => {
      const w = cenario();
      await w.criar("AUTHORIZED", 6, { chaveAcesso: w.chaveDe(6), protocoloAutorizacao: "135250000000006" });
      const x = await w.criar();
      h.code = 0;
      await w.emitir(x);
      const [r] = await w.reservas();
      expect(r.estado).toBe("INCERTO");
      expect((await w.nota(x)).status).toBe("SENDING");

      for (const extra of [{}, { confirmarDescarteNumeros: true }]) {
        expect(await w.inutilizar(r.numero, r.numero, extra)).toMatchObject({ ok: false, code: "FAIXA_COM_NUMERO_VIVO", httpStatus: 400 });
      }
      expect(h.inutilizacoes).toEqual([]);
      expect((await w.reservas())[0].estado).toBe("INCERTO");
    }, 60000);

    it("linha SENDING legada (sem reserva) ⇒ FAIXA_COM_NUMERO_VIVO", async () => {
      const w = cenario();
      await w.criar("SENDING", 12);
      expect(await w.inutilizar(12, 12, { confirmarDescarteNumeros: true })).toMatchObject({ ok: false, code: "FAIXA_COM_NUMERO_VIVO", httpStatus: 400 });
      expect(h.inutilizacoes).toEqual([]);
    }, 60000);
  });

  describe("(d) config fora da V2: caminho V1 intocado", () => {
    it.each([
      ["allowlist sem a config", (w: ReturnType<typeof cenario>) => w.allowlist("")],
      ["flag global desligada", (w: ReturnType<typeof cenario>) => w.allowlist(w.cfc, "false")],
    ])("%s: inutiliza sem guarda, ignora confirmarDescarteNumeros e não toca no ledger nem na nota", async (_nome, desligar) => {
      const w = cenario();
      const x = await w.rejeitadaNo7(); // reserva REJEITADO de quando a config estava na V2
      const antes = { nota: await w.nota(x), reservas: await w.reservas() };
      desligar(w);

      expect(await w.inutilizar(7, 7, { confirmarDescarteNumeros: true })).toEqual({ ok: true, status: "ACEITA" });
      expect(h.inutilizacoes).toEqual([{ ini: 7, fim: 7 }]);
      expect(await w.inutilizacoes()).toEqual([{ numeroInicial: 7, numeroFinal: 7, status: "ACEITA" }]);
      expect(await w.nota(x)).toEqual(antes.nota);
      expect(await w.reservas()).toEqual(antes.reservas);
      expect((await w.eventos(x)).filter((e) => e.evento === "NUMERACAO_DESCARTADA")).toEqual([]);
    }, 60000);
  });
});
