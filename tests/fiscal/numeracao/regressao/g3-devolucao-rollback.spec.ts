import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { makeConfig } from "../../__helpers__/test-draft";

// G3 / F7 — rollback POR CONFIG (tirar a empresa das duas allowlists; NFE_DEVOLUCAO_ENABLED e
// NFE_NUMERACAO_V2_ENABLED continuam "true", como no runbook) não pode deixar beco:
//  (a) rascunho GERENCIADO (com cabeçalho NfeDevolucao) e sem reserva cairia no V1 e sairia
//      finNFe 4 sem NFref ⇒ Rejeição 321 e número queimado. O V1 recusa ANTES do claim;
//  (b) a proteção de campos do updateDraft vale com cabeçalho, com ou sem a config na lista
//      (trocar a finalidade para NORMAL emitiria uma venda com a devolução pendurada) — e, com a
//      config fora da lista, recusa com a frase do ROLLBACK (a mesma do Emitir), nunca com o
//      "tente novamente" do RASCUNHO_ALTERADO: o /calculate cai no ramo comum e grava
//      `totaisJson`, e a tela repetia o mesmo 409 para sempre no botão "Tentar novamente";
//  (c) "Emitir NF-e" (findExistingDraft) nunca reaproveita o rascunho com cabeçalho;
//  (d) cancelar a ORIGINAL com devolução autorizada continua recusado, agora FORA de
//      transação (a config não emite devolução, então não há corrida a serializar).
// Controles: rascunho de devolução feito À MÃO (sem cabeçalho) e config que nunca teve
// devolução seguem o V1 exatamente como antes.
//
// PostgreSQL REAL, repositórios e casos de uso reais. Simulados: o transporte (provedor), o
// armazenamento de arquivo e o repositório de config (o schema descartável não tem a config).
//
// Opt-in: NFE_TEST_DATABASE_URL=postgresql://nfe:<senha>@127.0.0.1:<porta>/nfe_test

const raw = process.env.NFE_TEST_DATABASE_URL;
const schema = `nfe_g3_rb_${randomUUID().replace(/-/g, "")}`;

const h = vi.hoisted(() => ({
  configs: new Map<string, any>(),
  emitCalls: [] as string[],
  cancelCalls: [] as any[],
  xml: "",
}));

vi.mock("../../../../app/repositories/company-fiscal.repository", () => ({
  CompanyFiscalRepository: class {
    findByIdForUser = async (id: string) => h.configs.get(id) ?? null;
    findByUserId = async () => [...h.configs.values()].find((c) => c.isDefault) ?? null;
  },
}));
vi.mock("../../../../app/fiscal/providers/provider-factory", () => {
  const p = {
    // O que a SEFAZ responde a finNFe 4 sem NFref (as duas rejeições reais de produção).
    emitir: async (i: any) => {
      h.emitCalls.push(i.ref);
      return { success: false, status: "rejeitada", codigoStatus: 321, chaveAcesso: null, protocolo: null,
        mensagem: "Rejeicao: NF-e de devolucao de mercadoria nao possui documento fiscal referenciado" };
    },
    cancelar: async (i: any) => { h.cancelCalls.push(i); return { success: true, protocolo: "135CANC", mensagem: "ok" }; },
    buscarXml: async () => null,
  };
  return { createNfeProvider: () => p, createNfeProviderFromConfig: async () => p };
});
vi.mock("../../../../app/fiscal/storage/fiscal-storage.service", () => ({
  FiscalStorageService: class {
    saveXmlOriginal = async () => "/fiscal/tenant/original.json";
    saveXmlAutorizado = async () => "/fiscal/tenant/autorizado.xml";
    saveDanfePdf = async () => "/fiscal/tenant/danfe.pdf";
    saveXmlTentativa = async () => "/fiscal/tenant/tentativa.xml";
    readFile = async () => Buffer.from(h.xml, "utf8");
    deleteFile = async () => undefined;
  },
}));
vi.mock("../../../../app/usecases/company-fiscal-resp-tec.usecase", () => ({ resolverRespTecEmpresa: async () => ({ origem: "OMITIR" }) }));

const XML_ORIGINAL = readFileSync("tests/fiscal/golden/__fixtures__/nfe-proc-sample.xml", "utf8");
const CHAVE44 = "35260511222333000181550010000000011120100012"; // = chNFe do XML acima
const CHAVE_FOCUS_V1 = `NFe${CHAVE44}`;
const JUSTIFICATIVA = "Cancelamento de teste por erro de digitacao";
// Texto EXATO de propósito: é o que o lojista lê no passo Impostos, no autosave e no Emitir.
const MENSAGEM_ROLLBACK = "Este rascunho foi criado pela Devolução do Dexo, que foi desligada para esta empresa: ele não pode ser emitido nem alterado como nota comum. Fale com o suporte do Dexo para religar a devolução desta empresa (aí este rascunho volta a emitir) ou para excluir este rascunho.";

const describePg = describe.skipIf(!raw);
describePg("G3/F7: rollback por config com devolução no banco (Postgres real)", () => {
  let admin: PrismaClient;
  let M: any;

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
    for (const arq of ["prisma/ddl/2026-09-18-nfe-numeracao-v2.sql", "prisma/ddl/2026-09-18-nfe-devolucao.sql"]) {
      const ddl = readFileSync(arq, "utf8").replace(/--[^\r\n]*/g, "");
      for (const sql of ddl.split(";").map((s) => s.trim()).filter((s) => s && !["BEGIN", "COMMIT"].includes(s))) await admin.$executeRawUnsafe(sql);
    }
    M = {
      Cancel: (await import("../../../../app/usecases/nfe-cancelamento.usecase")).NfeCancelamentoUseCase,
      Emission: (await import("../../../../app/usecases/nfe-emission.usecase")).NfeEmissionUseCase,
      Devolucao: (await import("../../../../app/usecases/nfe-devolucao.usecase")).NfeDevolucaoUseCase,
      DevolucaoRepo: (await import("../../../../app/fiscal/devolucao/devolucao.repository")).NfeDevolucaoRepository,
      DevolucaoError: (await import("../../../../app/fiscal/devolucao/devolucao.errors")).DevolucaoError,
      NfeRepository: (await import("../../../../app/repositories/nfe.repository")).NfeRepository,
      prisma: (await import("../../../../app/lib/prisma")).default,
    };
  }, 180000);

  afterAll(async () => {
    if (M?.prisma) await M.prisma.$disconnect();
    if (admin) { await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); await admin.$disconnect(); }
  });

  let cfc: string;
  beforeEach(async () => {
    cfc = `cfg-${randomUUID().slice(0, 8)}`;
    h.configs.clear(); h.emitCalls = []; h.cancelCalls = []; h.xml = XML_ORIGINAL;
    // Mesmo CNPJ/ambiente/UF do XML de amostra (emit 11222333000181, tpAmb 2, SP).
    h.configs.set(cfc, makeConfig({ id: cfc, userId: "tenant", providerName: "SEFAZ_DIRECT", isDefault: true } as any));
    ligar(cfc);
    vi.stubEnv("NFE_NUMERACAO_V2_FOCUS_ENABLED", "false");
    vi.stubEnv("NFE_RESP_TEC_EMPRESA_ENABLED", "false");
    for (const t of ["NfeNumeroTentativa", "NfeNumeroReserva", "NfeDevolucaoItem", "NfeDevolucao", "NfeAuditLog", "NfeItem", "NfeEmitida", "NfeSequence"]) {
      await admin.$executeRawUnsafe(`DELETE FROM "${t}"`);
    }
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  function ligar(ids: string) {
    vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", "true");
    vi.stubEnv("NFE_NUMERACAO_V2_CONFIG_IDS", ids);
    vi.stubEnv("NFE_NUMERACAO_V2_MODELOS", "55");
    vi.stubEnv("NFE_DEVOLUCAO_ENABLED", "true");
    vi.stubEnv("NFE_DEVOLUCAO_CONFIG_IDS", ids);
  }
  /** Runbook: tira a config das DUAS listas; outra empresa segue ligada e os globais ficam "true". */
  function rollbackDaConfig() { ligar("cfg-outra-empresa"); }

  async function criarOriginal(chaveGravada: string, configId = cfc): Promise<string> {
    const n = await admin.nfeEmitida.create({
      data: {
        userId: "tenant", companyFiscalConfigId: configId, ambiente: "HOMOLOGACAO", modelo: "55", serie: 1, numero: 1, status: "AUTHORIZED",
        tipoOperacao: "SAIDA", finalidade: "NORMAL", destinoOperacao: "INTERNA", naturezaOperacao: "VENDA DE MERCADORIA", indPresenca: "PRESENCIAL",
        destinatarioJson: { nome: "CLIENTE TESTE LTDA", cpfCnpj: "00000000000100" } as object,
        emittedByUserId: "tenant",
        chaveAcesso: chaveGravada, protocoloAutorizacao: "135260000000001",
        dataAutorizacao: new Date(Date.now() - 60 * 60 * 1000), xmlAutorizadoPath: "/fiscal/tenant/orig.xml",
        itens: { create: [{ numero: 1, codigo: "PROD-001", descricao: "PRODUTO TESTE", ncm: "87089990", cfop: "5102", origem: 0, unidade: "UN", quantidade: 1, valorUnitario: 100, valorTotal: 100 }] },
      } as any,
    });
    return n.id;
  }
  /** "Devolver" pelo caso de uso REAL com a devolução ligada: rascunho DRAFT com cabeçalho, sem reserva. */
  async function rascunhoDeDevolucao(originalId: string): Promise<string> {
    const r = await new M.Devolucao().criar("tenant", "tenant", originalId, { escopo: "TOTAL" });
    expect(r.reutilizado).toBe(false);
    return r.draftId;
  }
  async function linha(id: string) {
    return admin.nfeEmitida.findUnique({ where: { id }, select: { status: true, numero: true, finalidade: true, companyFiscalConfigId: true, informacoesComplementares: true } });
  }
  async function eventos(id: string) {
    return (await admin.$queryRawUnsafe<Array<{ evento: string }>>(`SELECT "evento" FROM "NfeAuditLog" WHERE "nfeId"=$1 ORDER BY "createdAt"`, id)).map((e) => e.evento);
  }
  const resultado = (p: Promise<unknown>) => p.then((v) => ({ ok: v }), (e) => ({ erro: e }));
  const codigo = (r: any) => ("erro" in r ? { nome: r.erro?.name, code: r.erro?.code, http: r.erro?.httpStatus, msg: String(r.erro?.message).slice(0, 160) } : { ok: r.ok });

  describe("(a) emissão V1", () => {
    it("★ rascunho com cabeçalho e sem reserva: o V1 recusa ANTES do provedor (EXIGE_NUMERACAO_V2) — nenhum número tomado", async () => {
      const original = await criarOriginal(CHAVE44);
      const draftId = await rascunhoDeDevolucao(original);
      // A original fica fora do caminho do contador novo (nº 1 livre para o V1 tomar).
      await admin.$executeRawUnsafe(`UPDATE "NfeEmitida" SET "numero"=900 WHERE "id"=$1`, original);
      // O lojista completou o endereço do destinatário (campo livre): sem isso o V1 pararia
      // antes, na validação local, e o teste não mostraria o dano real (321 + nº queimado).
      await admin.$executeRawUnsafe(`UPDATE "NfeEmitida" SET "destinatarioJson"="destinatarioJson"||$2::jsonb WHERE "id"=$1`, draftId,
        JSON.stringify({ tipoPessoa: "JURIDICA", logradouro: "RUA A", numero: "1", bairro: "CENTRO", municipio: "SAO PAULO", codMunicipio: "3550308", uf: "SP", cep: "01000000" }));
      const antes = await linha(draftId);
      expect(antes).toMatchObject({ status: "DRAFT", finalidade: "DEVOLUCAO" });
      expect(antes!.numero).toBeLessThan(0);

      rollbackDaConfig();
      const r = await resultado(new M.Emission().emit("tenant", draftId));
      const seq = await admin.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM "NfeSequence"`);
      const diag = { r: codigo(r), provedor: h.emitCalls.length, nota: await linha(draftId), eventos: await eventos(draftId), sequencias: seq.length };
      expect(diag, JSON.stringify(diag)).toMatchObject({
        r: { nome: "DevolucaoError", code: "EXIGE_NUMERACAO_V2", http: 422 },
        provedor: 0,
        nota: { status: "DRAFT", numero: antes!.numero, finalidade: "DEVOLUCAO" },
        sequencias: 0,
      });
      expect(diag.eventos).not.toContain("NUMERADA");
      // A mensagem é a do rollback (a MESMA do updateDraft/calculate) e só promete o que existe:
      // depois do rollback não há botão de exclusão na tela para este rascunho (o quadro
      // "Devoluções em andamento" filtra pela devolução ligada) — quem religa ou exclui é o suporte.
      expect((r as any).erro.message).toBe(MENSAGEM_ROLLBACK);

      // Não é beco: o suporte exclui pela rota de sempre (DELETE /nfe/draft/:id), que leva o
      // cabeçalho e as linhas junto (FK em cascata) e libera a original.
      const { NfeDraftUseCase } = await import("../../../../app/usecases/nfe-draft.usecase");
      await new NfeDraftUseCase().delete("tenant", draftId);
      const sobras = await admin.$queryRawUnsafe<Array<{ n: number }>>(`SELECT (SELECT COUNT(*) FROM "NfeDevolucao" WHERE "nfeId"=$1)::int + (SELECT COUNT(*) FROM "NfeDevolucaoItem" WHERE "devolucaoNfeId"=$1)::int AS n`, draftId);
      expect({ nota: await linha(draftId), sobras: sobras[0].n }).toEqual({ nota: null, sobras: 0 });
    }, 60000);

    it("controle: rascunho de devolução feito À MÃO (sem cabeçalho) segue no V1 como sempre — chega ao provedor", async () => {
      rollbackDaConfig();
      const n = await admin.nfeEmitida.create({
        data: {
          userId: "tenant", companyFiscalConfigId: cfc, ambiente: "HOMOLOGACAO", modelo: "55", serie: 1, numero: -3, status: "DRAFT",
          tipoOperacao: "ENTRADA", finalidade: "DEVOLUCAO", destinoOperacao: "INTERNA", naturezaOperacao: "DEVOLUCAO DE VENDA", indPresenca: "NAO_SE_APLICA",
          destinatarioJson: { nome: "CLIENTE TESTE LTDA", cpfCnpj: "00000000000191", tipoPessoa: "JURIDICA", logradouro: "RUA A", numero: "1", bairro: "CENTRO", municipio: "SAO PAULO", codMunicipio: "3550308", uf: "SP", cep: "01000000" } as object,
          emittedByUserId: "tenant",
          itens: { create: [{ numero: 1, codigo: "PROD-001", descricao: "PRODUTO TESTE", ncm: "87089990", cfop: "1202", origem: 0, unidade: "UN", quantidade: 1, valorUnitario: 100, valorTotal: 100 }] },
        } as any,
      });
      const r = await resultado(new M.Emission().emit("tenant", n.id));
      const diag = { r: codigo(r), provedor: h.emitCalls };
      expect(diag, JSON.stringify(diag)).toMatchObject({ provedor: [n.id] });
      expect(await eventos(n.id)).toContain("NUMERADA");
    }, 60000);

    it("custo: venda comum não paga a consulta do cabeçalho; com o gate global desligado, nem a devolução (nenhuma consulta nova, como o I8)", async () => {
      rollbackDaConfig();
      const espiao = vi.spyOn(M.DevolucaoRepo.prototype, "temCabecalho");
      const nota = async (id: string, finalidade: string, cfop: string, tipoOperacao: string) => (await admin.nfeEmitida.create({
        data: {
          id, userId: "tenant", companyFiscalConfigId: cfc, ambiente: "HOMOLOGACAO", modelo: "55", serie: 1, numero: -Math.floor(Math.random() * 1e6) - 10, status: "DRAFT",
          tipoOperacao, finalidade, destinoOperacao: "INTERNA", naturezaOperacao: "OPERACAO TESTE", indPresenca: "NAO_SE_APLICA",
          destinatarioJson: { nome: "CLIENTE TESTE LTDA", cpfCnpj: "00000000000191", tipoPessoa: "JURIDICA", logradouro: "RUA A", numero: "1", bairro: "CENTRO", municipio: "SAO PAULO", codMunicipio: "3550308", uf: "SP", cep: "01000000" } as object,
          emittedByUserId: "tenant",
          itens: { create: [{ numero: 1, codigo: "PROD-001", descricao: "PRODUTO TESTE", ncm: "87089990", cfop, origem: 0, unidade: "UN", quantidade: 1, valorUnitario: 100, valorTotal: 100 }] },
        } as any,
      })).id;
      await resultado(new M.Emission().emit("tenant", await nota("venda-1", "NORMAL", "5102", "SAIDA")));
      expect(espiao).not.toHaveBeenCalled();
      vi.stubEnv("NFE_DEVOLUCAO_ENABLED", "false");
      await resultado(new M.Emission().emit("tenant", await nota("devolucao-a-mao-1", "DEVOLUCAO", "1202", "ENTRADA")));
      expect(espiao).not.toHaveBeenCalled();
      expect(h.emitCalls).toEqual(["venda-1", "devolucao-a-mao-1"]);
    }, 60000);
  });

  describe("(b) updateDraft", () => {
    /** Totais e itens como o banco os tem — para provar que a recusa não gravou nada. */
    async function conteudo(id: string) {
      const n = await admin.nfeEmitida.findUnique({ where: { id }, select: { totaisJson: true, finalidade: true, companyFiscalConfigId: true, status: true, itens: { select: { numero: true, codigo: true, quantidade: true, cfop: true }, orderBy: { numero: "asc" } } } });
      return JSON.parse(JSON.stringify(n));
    }
    const erroRollback = { nome: "DevolucaoError", code: "EXIGE_NUMERACAO_V2", http: 422, msg: MENSAGEM_ROLLBACK.slice(0, 160) };

    it("★ /calculate com cabeçalho e a config FORA da lista: updateDraft({totaisJson}) recusa com a mensagem do rollback — nunca o 'tente novamente' que repete o mesmo 409", async () => {
      const original = await criarOriginal(CHAVE44);
      const draftId = await rascunhoDeDevolucao(original);
      rollbackDaConfig();
      const antes = await conteudo(draftId);
      // Exatamente o que a rota do /calculate manda no ramo comum (fiscal.routes.ts: updateDraft
      // só com os totais do calculador V1) — o ramo em que o rascunho cai depois do rollback.
      const r = await resultado(new M.NfeRepository().updateDraft("tenant", draftId, {
        totaisJson: { valorProdutos: 100, valorTotal: 100, valorIcms: 18, valorPis: 0, valorCofins: 0 },
      }));
      const diag = { r: codigo(r), erro: (r as any).erro };
      expect(diag.r, JSON.stringify(diag.r)).toEqual(erroRollback);
      expect(diag.erro.message).toBe(MENSAGEM_ROLLBACK);
      expect(diag.erro.message).not.toMatch(/tente novamente/i);
      expect(diag.erro.draftId).toBe(draftId);
      expect(await conteudo(draftId)).toEqual(antes);
    }, 60000);

    it("★ com cabeçalho e a config FORA da lista: finalidade, empresa, itens e totais continuam protegidos (mesma mensagem); campo livre ainda salva", async () => {
      const original = await criarOriginal(CHAVE44);
      const draftId = await rascunhoDeDevolucao(original);
      rollbackDaConfig();
      const repo = new M.NfeRepository();
      const antes = await conteudo(draftId);
      expect(antes.itens.length).toBeGreaterThan(0);

      const tentativas = {
        finalidade: codigo(await resultado(repo.updateDraft("tenant", draftId, { finalidade: "NORMAL" }))),
        empresa: codigo(await resultado(repo.updateDraft("tenant", draftId, { companyFiscalConfigId: "cfg-outra-empresa" }))),
        // O autosave do passo 3 manda a lista inteira de itens (use-nfe-draft).
        itens: codigo(await resultado(repo.updateDraft("tenant", draftId, {
          itens: [{ numero: 1, codigo: "OUTRA-PECA", descricao: "OUTRA PECA", ncm: "87089990", cfop: "5102", origem: 0, unidade: "UN", quantidade: 5, valorUnitario: 10, valorTotal: 50 }],
        }))),
        totais: codigo(await resultado(repo.updateDraft("tenant", draftId, { totaisJson: { valorTotal: 1 } }))),
      };
      expect(tentativas, JSON.stringify(tentativas)).toEqual({ finalidade: erroRollback, empresa: erroRollback, itens: erroRollback, totais: erroRollback });
      expect(await conteudo(draftId)).toEqual(antes);
      // Campo que não é protegido segue o caminho de sempre — e o autosave não paga a consulta.
      const espiao = vi.spyOn(M.DevolucaoRepo.prototype, "empresaDoRascunhoGerenciado");
      await repo.updateDraft("tenant", draftId, { informacoesComplementares: "obs livre" });
      expect(await linha(draftId)).toMatchObject({ informacoesComplementares: "obs livre", finalidade: "DEVOLUCAO" });
      expect(espiao).not.toHaveBeenCalled();
    }, 60000);

    it("controle: com a devolução LIGADA para a config, a proteção é a de antes (RASCUNHO_ALTERADO 409, frase padrão)", async () => {
      const original = await criarOriginal(CHAVE44);
      const draftId = await rascunhoDeDevolucao(original);
      const antes = await conteudo(draftId);
      const r = await resultado(new M.NfeRepository().updateDraft("tenant", draftId, { totaisJson: { valorTotal: 1 } }));
      expect(codigo(r)).toEqual({ nome: "DevolucaoError", code: "RASCUNHO_ALTERADO", http: 409, msg: "A devolução foi alterada durante a emissão — tente novamente." });
      expect(await conteudo(draftId)).toEqual(antes);
    }, 60000);

    it("rascunho gerenciado SEM empresa gravada é da empresa PADRÃO (como no Emitir): padrão ligada ⇒ recusa de sempre; padrão fora da lista ⇒ a do rollback", async () => {
      const original = await criarOriginal(CHAVE44);
      const draftId = await rascunhoDeDevolucao(original);
      await admin.$executeRawUnsafe(`UPDATE "NfeEmitida" SET "companyFiscalConfigId"=NULL WHERE "id"=$1`, draftId);
      // A empresa padrão do tenant (o schema descartável não tem config: a consulta a procura
      // no banco, não no repositório simulado).
      await admin.$executeRawUnsafe(`INSERT INTO "CompanyFiscalConfig"("id","userId","cnpj","razaoSocial","inscricaoEstadual","regimeTributario","isDefault","createdAt","updatedAt")
        VALUES ($1,'tenant','11222333000181','EMPRESA TESTE','123456789','SIMPLES',true,NOW(),NOW())`, cfc);
      try {
        const repo = new M.NfeRepository();
        const ligada = codigo(await resultado(repo.updateDraft("tenant", draftId, { totaisJson: { valorTotal: 1 } })));
        rollbackDaConfig();
        const desligada = codigo(await resultado(repo.updateDraft("tenant", draftId, { totaisJson: { valorTotal: 1 } })));
        expect({ ligada: ligada.code, desligada: desligada.code }).toEqual({ ligada: "RASCUNHO_ALTERADO", desligada: "EXIGE_NUMERACAO_V2" });
      } finally {
        await admin.$executeRawUnsafe(`DELETE FROM "CompanyFiscalConfig" WHERE "id"=$1`, cfc);
      }
    }, 60000);

    it("controle: nota sem cabeçalho (venda comum) troca finalidade como sempre", async () => {
      rollbackDaConfig();
      const n = await admin.nfeEmitida.create({
        data: {
          userId: "tenant", companyFiscalConfigId: cfc, ambiente: "HOMOLOGACAO", modelo: "55", serie: 1, numero: -4, status: "DRAFT",
          tipoOperacao: "SAIDA", finalidade: "NORMAL", destinoOperacao: "INTERNA", naturezaOperacao: "VENDA DE MERCADORIA", indPresenca: "NAO_SE_APLICA",
          destinatarioJson: {} as object, emittedByUserId: "tenant",
        } as any,
      });
      await new M.NfeRepository().updateDraft("tenant", n.id, { finalidade: "COMPLEMENTAR" });
      expect(await linha(n.id)).toMatchObject({ finalidade: "COMPLEMENTAR" });
    }, 60000);
  });

  describe("(c) findExistingDraft", () => {
    it("★ 'Emitir NF-e' não reaproveita o rascunho com cabeçalho com a config FORA da lista; o normal volta", async () => {
      await admin.nfeEmitida.create({
        data: {
          id: "venda-aberta", userId: "tenant", companyFiscalConfigId: cfc, ambiente: "HOMOLOGACAO", modelo: "55", serie: 1, numero: -9, status: "DRAFT",
          tipoOperacao: "SAIDA", finalidade: "NORMAL", destinoOperacao: "INTERNA", naturezaOperacao: "VENDA DE MERCADORIA", indPresenca: "NAO_SE_APLICA",
          destinatarioJson: {} as object, emittedByUserId: "tenant", updatedAt: new Date(Date.now() - 60 * 60 * 1000),
        } as any,
      });
      const original = await criarOriginal(CHAVE44);
      const draftId = await rascunhoDeDevolucao(original);
      rollbackDaConfig();
      const repo = new M.NfeRepository();
      expect((await repo.findExistingDraft("tenant", "55"))?.id).toBe("venda-aberta");
      await admin.nfeEmitida.delete({ where: { id: "venda-aberta" } });
      expect(await repo.findExistingDraft("tenant", "55")).toBeNull();
      expect(await linha(draftId)).toMatchObject({ status: "DRAFT", finalidade: "DEVOLUCAO" });
    }, 60000);
  });

  describe("(d) cancelamento da original", () => {
    it.each([
      ["44 dígitos", CHAVE44],
      ["'NFe'+44 (Focus V1)", CHAVE_FOCUS_V1],
    ])("★ devolução AUTORIZADA e a config FORA da devolução (chave %s): cancelar é recusado, sem transação e sem provedor", async (_rotulo, chave) => {
      const original = await criarOriginal(chave);
      const dev = await rascunhoDeDevolucao(original);
      await admin.$executeRawUnsafe(`UPDATE "NfeEmitida" SET "status"='AUTHORIZED',"numero"=2,"chaveAcesso"=$2,"protocoloAutorizacao"='135260000000002',"dataAutorizacao"=NOW() WHERE "id"=$1`,
        dev, "35260511222333000181550010000000021120100019");
      rollbackDaConfig();
      const tx = vi.spyOn(M.prisma, "$transaction");
      const r = await resultado(new M.Cancel().cancel("tenant", original, JUSTIFICATIVA));
      const diag = { r: codigo(r), issues: (r as any).erro?.issues?.map((i: any) => i.code), provedor: h.cancelCalls.length, transacoes: tx.mock.calls.length, status: (await linha(original))!.status };
      expect(diag, JSON.stringify(diag)).toEqual({
        r: expect.objectContaining({ nome: "DevolucaoError", code: "ORIGINAL_COM_DEVOLUCAO", http: 409 }),
        issues: ["PARCIALMENTE_DEVOLVIDA"],
        provedor: 0,
        transacoes: 0,
        status: "AUTHORIZED",
      });
    }, 60000);

    it("★ devolução EM ENVIO e a config fora: também recusa (EMISSAO_EM_ANDAMENTO)", async () => {
      const original = await criarOriginal(CHAVE44);
      const dev = await rascunhoDeDevolucao(original);
      await admin.$executeRawUnsafe(`UPDATE "NfeEmitida" SET "status"='SENDING' WHERE "id"=$1`, dev);
      rollbackDaConfig();
      const r = await resultado(new M.Cancel().cancel("tenant", original, JUSTIFICATIVA));
      expect({ r: codigo(r), issues: (r as any).erro?.issues?.map((i: any) => i.code), provedor: h.cancelCalls.length })
        .toEqual({ r: expect.objectContaining({ code: "ORIGINAL_COM_DEVOLUCAO" }), issues: ["EMISSAO_EM_ANDAMENTO"], provedor: 0 });
    }, 60000);

    it("controle: config que NUNCA teve devolução (fora das listas) — cancelamento V1 intacto: sucesso, provedor 1× com a chave crua, sem transação", async () => {
      const outra = "cfg-sem-devolucao";
      h.configs.set(outra, makeConfig({ id: outra, userId: "tenant", providerName: "SEFAZ_DIRECT", isDefault: false } as any));
      const chave = "35260911222333000181550010000000051987654321";
      const original = await criarOriginal(chave, outra);
      const tx = vi.spyOn(M.prisma, "$transaction");
      const r = await new M.Cancel().cancel("tenant", original, JUSTIFICATIVA);
      expect(r).toEqual({ success: true, nfeId: original, status: "CANCELLED", protocolo: "135CANC", mensagem: "NF-e cancelada com sucesso" });
      expect(h.cancelCalls.map((c) => c.chaveAcesso)).toEqual([chave]);
      expect(tx).not.toHaveBeenCalled();
      expect((await linha(original))!.status).toBe("CANCELLED");
      expect(await eventos(original)).toEqual(["CANCELADA"]);
    }, 60000);

    it.each(["REJECTED", "CANCELLED"])("controle: devolução %s não trava a original (mesma regra da V2)", async (statusDevolucao) => {
      const original = await criarOriginal(CHAVE44);
      const dev = await rascunhoDeDevolucao(original);
      // CANCELLED de verdade: autorizada com chave/protocolo e depois cancelada.
      await admin.$executeRawUnsafe(`UPDATE "NfeEmitida" SET "status"=$2,"numero"=2,"chaveAcesso"=$3,"protocoloAutorizacao"='135260000000002',"dataAutorizacao"=NOW() WHERE "id"=$1`,
        dev, statusDevolucao, "35260511222333000181550010000000021120100019");
      rollbackDaConfig();
      const r = await new M.Cancel().cancel("tenant", original, JUSTIFICATIVA);
      expect(r).toMatchObject({ success: true, status: "CANCELLED" });
      expect(h.cancelCalls.map((c) => c.chaveAcesso)).toEqual([CHAVE44]);
      expect((await linha(original))!.status).toBe("CANCELLED");
    }, 60000);
  });
});
