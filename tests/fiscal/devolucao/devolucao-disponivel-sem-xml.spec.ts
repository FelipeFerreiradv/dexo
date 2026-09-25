/**
 * N-completude-6: "Devolver total/parcial" aparecia em 447 notas históricas da DLS que não
 * têm o XML autorizado guardado (histórico importado, SEFAZ direto — sem a Focus para
 * buscá-lo), e o clique só respondia "use a devolução manual". Agora `devolucaoDisponivel`
 * só marca a nota que o botão consegue devolver; as outras ganham `devolucaoPelaChave`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  configs: [] as Array<{ id: string; providerName: string; isDefault: boolean; temToken: boolean }>,
  comXml: new Set<string>(),
  consultas: [] as Array<{ sql: string; args: unknown[] }>,
}));
vi.mock("../../../app/lib/prisma", () => ({
  default: {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      h.consultas.push({ sql, args });
      if (sql.includes(`FROM "CompanyFiscalConfig"`)) return h.configs;
      if (sql.includes(`FROM "NfeNumeroReserva"`)) return [];
      if (sql.includes(`FROM "NfeEmitida"`)) return (args[1] as string[]).filter((id) => h.comXml.has(id)).map((id) => ({ id }));
      throw new Error("consulta inesperada: " + sql);
    },
  },
}));

import { attachFiscalLista } from "../../../app/fiscal/numeracao/metadata";

const CFC = "cfg-dls";
beforeEach(() => {
  vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", "true");
  vi.stubEnv("NFE_NUMERACAO_V2_CONFIG_IDS", CFC);
  vi.stubEnv("NFE_NUMERACAO_V2_MODELOS", "55");
  vi.stubEnv("NFE_DEVOLUCAO_ENABLED", "true");
  vi.stubEnv("NFE_DEVOLUCAO_CONFIG_IDS", CFC);
  h.configs = [{ id: CFC, providerName: "SEFAZ_DIRECT", isDefault: true, temToken: false }];
  h.comXml = new Set();
  h.consultas = [];
});
afterEach(() => { vi.unstubAllEnvs(); });

const venda = (id: string, over: Record<string, unknown> = {}) => ({ id, companyFiscalConfigId: CFC, modelo: "55", status: "AUTHORIZED", tipoOperacao: "SAIDA", finalidade: "NORMAL", ...over });

describe("attachFiscalLista: o botão 'Devolver' só onde ele funciona", () => {
  it("venda autorizada COM o XML guardado: devolucaoDisponivel", async () => {
    h.comXml.add("com-xml");
    const [n] = await attachFiscalLista("tenant", [venda("com-xml")]);
    expect(n).toMatchObject({ devolucaoDisponivel: true });
    expect(n).not.toHaveProperty("devolucaoPelaChave");
  });

  it("venda autorizada SEM o XML (histórico importado, SEFAZ direto): devolucaoPelaChave, sem o botão que só dava erro", async () => {
    const [n] = await attachFiscalLista("tenant", [venda("sem-xml")]);
    expect(n).toMatchObject({ devolucaoPelaChave: true });
    expect(n).not.toHaveProperty("devolucaoDisponivel");
  });

  it("uma consulta só, pelos ids que precisam — e nenhuma quando a linha já traz a coluna (GET /nfe/:id)", async () => {
    h.comXml.add("a");
    await attachFiscalLista("tenant", [venda("a"), venda("b"), venda("rascunho", { status: "DRAFT" })]);
    const doXml = h.consultas.filter((c) => c.sql.includes(`"xmlAutorizadoPath" IS NOT NULL`));
    expect(doXml).toHaveLength(1);
    expect(doXml[0].args[1]).toEqual(["a", "b"]);

    h.consultas = [];
    const [comColuna, semColuna] = await attachFiscalLista("tenant", [venda("c", { xmlAutorizadoPath: "xml/c.xml" }), venda("d", { xmlAutorizadoPath: null })]);
    expect(h.consultas.filter((c) => c.sql.includes(`"xmlAutorizadoPath" IS NOT NULL`))).toHaveLength(0);
    expect(comColuna).toMatchObject({ devolucaoDisponivel: true });
    expect(semColuna).toMatchObject({ devolucaoPelaChave: true });
  });

  it("Focus com token busca o XML na hora: devolucaoDisponivel mesmo sem o arquivo guardado", async () => {
    h.configs = [{ id: CFC, providerName: "FOCUS_NFE", isDefault: true, temToken: true }];
    const [n] = await attachFiscalLista("tenant", [venda("focus")]);
    expect(n).toMatchObject({ devolucaoDisponivel: true });
    expect(n).not.toHaveProperty("devolucaoPelaChave");
  });

  it("o resto não muda: rascunho, entrada e a própria devolução seguem com devolucaoDisponivel (a tela filtra por status)", async () => {
    const notas = await attachFiscalLista("tenant", [
      venda("r", { status: "DRAFT" }), venda("e", { tipoOperacao: "ENTRADA" }), venda("dv", { finalidade: "DEVOLUCAO" }),
    ]);
    for (const n of notas) {
      expect(n).toMatchObject({ devolucaoDisponivel: true });
      expect(n).not.toHaveProperty("devolucaoPelaChave");
    }
  });

  it("empresa com a devolução desligada: nenhum dos dois", async () => {
    vi.stubEnv("NFE_DEVOLUCAO_CONFIG_IDS", "outra");
    const [n] = await attachFiscalLista("tenant", [venda("x")]);
    expect(n).not.toHaveProperty("devolucaoDisponivel");
    expect(n).not.toHaveProperty("devolucaoPelaChave");
  });

  it("o token da empresa nunca é lido: a consulta só pergunta SE existe", async () => {
    await attachFiscalLista("tenant", [venda("x")]);
    const cfg = h.consultas.find((c) => c.sql.includes(`FROM "CompanyFiscalConfig"`))!;
    expect(cfg.sql).toContain(`("providerToken" IS NOT NULL AND "providerToken"<>'') AS "temToken"`);
    expect(cfg.sql).not.toMatch(/SELECT[^()]*"providerToken"\s*,/);
  });
});
