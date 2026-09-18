import { describe, expect, it } from "vitest";

import {
  createInMemoryPrisma,
  ErroPrismaMemoria,
  SQL_NAO_TRATADO,
} from "./in-memory-prisma";
import { FakeAuthority } from "./fake-authority";
import { createScriptedProvider, passos } from "./scripted-provider";
import { createNumeracaoMemory } from "./numeracao-memory";
import { EmitWorld } from "./emit-world";

// Autoteste do harness: mantém os doubles honestos. Se um fake divergir do que
// o Prisma/SEFAZ fazem nos pontos que a numeração depende, os specs de emissão
// passariam por engano — este arquivo é a primeira linha de defesa.

function nota(over: Record<string, unknown> = {}) {
  return {
    userId: "u1",
    companyFiscalConfigId: "cfg-1",
    ambiente: "HOMOLOGACAO",
    serie: 1,
    numero: -1,
    tipoOperacao: "SAIDA",
    finalidade: "NORMAL",
    destinoOperacao: "INTERNA",
    naturezaOperacao: "VENDA",
    indPresenca: "PRESENCIAL",
    destinatarioJson: {},
    status: "DRAFT",
    emittedByUserId: "u1",
    ...over,
  };
}

describe("in-memory-prisma", () => {
  it("create aplica defaults do schema e ids determinísticos", async () => {
    const db = createInMemoryPrisma();
    const a = await db.client.nfeEmitida.create({ data: nota() });
    const b = await db.client.nfeEmitida.create({ data: nota({ numero: -2 }) });
    expect(a.id).toBe("nfe-0001");
    expect(b.id).toBe("nfe-0002");
    expect(a.modelo).toBe("55");
    expect(a.cStatRejeicao).toBeNull();
    expect(a.createdAt).toBeInstanceOf(Date);
  });

  it("R3: cStatRejeicao string em Int? lança PrismaClientValidationError; coluna inexistente também", async () => {
    const db = createInMemoryPrisma();
    const { id } = await db.client.nfeEmitida.create({ data: nota() });
    await expect(
      db.client.nfeEmitida.update({ where: { id }, data: { cStatRejeicao: "974" } }),
    ).rejects.toMatchObject({ name: "PrismaClientValidationError" });
    await expect(
      db.client.nfeEmitida.update({ where: { id }, data: { numeroReserva: 1 } }),
    ).rejects.toThrow(/Unknown argument `numeroReserva`/);
    await expect(
      db.client.nfeEmitida.create({ data: { ...nota(), status: undefined } }),
    ).rejects.toThrow(/`status` is missing/);
  });

  it("uniques parciais de produção: (cfc, amb, série, número>0, modelo), legado NULL e chaveAcesso", async () => {
    const db = createInMemoryPrisma();
    await db.client.nfeEmitida.create({ data: nota({ numero: 101 }) });
    // Mesmo número em outro emitente/modelo/ambiente: permitido.
    await db.client.nfeEmitida.create({ data: nota({ numero: 101, companyFiscalConfigId: "cfg-2" }) });
    await db.client.nfeEmitida.create({ data: nota({ numero: 101, modelo: "65" }) });
    // Placeholder negativo repetido com cfc: fora do índice parcial.
    await db.client.nfeEmitida.create({ data: nota({ numero: -1 }) });
    await db.client.nfeEmitida.create({ data: nota({ numero: -1 }) });
    await expect(db.client.nfeEmitida.create({ data: nota({ numero: 101 }) })).rejects.toMatchObject({
      code: "P2002",
    });
    // Legado (cfc NULL) não tem o filtro numero > 0.
    await db.client.nfeEmitida.create({ data: nota({ companyFiscalConfigId: null, numero: -1 }) });
    await expect(
      db.client.nfeEmitida.create({ data: nota({ companyFiscalConfigId: null, numero: -1 }) }),
    ).rejects.toMatchObject({ code: "P2002" });
    const chave = "3".repeat(44);
    await db.client.nfeEmitida.create({ data: nota({ numero: 7, chaveAcesso: chave }) });
    await expect(
      db.client.nfeEmitida.create({ data: nota({ numero: 8, chaveAcesso: chave }) }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("updateMany condicional é atômico e devolve count; update inexistente é P2025", async () => {
    const db = createInMemoryPrisma();
    const { id } = await db.client.nfeEmitida.create({ data: nota() });
    const claim = () =>
      db.client.nfeEmitida.updateMany({
        where: { id, userId: "u1", status: { in: ["DRAFT", "REJECTED"] } },
        data: { status: "VALIDATING" },
      });
    const [a, b] = await Promise.all([claim(), claim()]);
    expect([a.count, b.count].sort()).toEqual([0, 1]);
    await expect(
      db.client.nfeEmitida.update({ where: { id: "nao-existe" }, data: { status: "DRAFT" } }),
    ).rejects.toMatchObject({ code: "P2025" });
    await expect(db.client.nfeEmitida.update({ where: { userId: "u1" }, data: {} })).rejects.toThrow(
      /WhereUniqueInput/,
    );
  });

  it("filtros (in/not/lt/gt), orderBy com NULLS do Postgres, include/select e cascata", async () => {
    const db = createInMemoryPrisma();
    const n1 = await db.client.nfeEmitida.create({
      data: nota({ numero: 1, status: "AUTHORIZED", dataEmissao: new Date("2026-09-01T00:00:00Z") }),
    });
    const n2 = await db.client.nfeEmitida.create({ data: nota({ numero: 2, status: "CANCELLED" }) });
    await db.client.nfeItem.createMany({
      data: [
        { nfeId: n1.id, numero: 2, codigo: "B", descricao: "B", ncm: "1", cfop: "5102", origem: 0, unidade: "UN", quantidade: 1, valorUnitario: 1, valorTotal: 1 },
        { nfeId: n1.id, numero: 1, codigo: "A", descricao: "A", ncm: "1", cfop: "5102", origem: 0, unidade: "UN", quantidade: 1, valorUnitario: 1, valorTotal: 1 },
      ],
    });
    expect(
      (await db.client.nfeEmitida.findMany({ where: { status: { not: "CANCELLED" } } })).map((l: any) => l.id),
    ).toEqual([n1.id]);
    expect(
      await db.client.nfeEmitida.count({ where: { dataEmissao: { lt: new Date("2026-09-02T00:00:00Z") } } }),
    ).toBe(1);
    // ASC ⇒ NULLS LAST; DESC ⇒ NULLS FIRST.
    expect(
      (await db.client.nfeEmitida.findMany({ orderBy: { dataEmissao: "asc" } })).map((l: any) => l.id),
    ).toEqual([n1.id, n2.id]);
    expect(
      (await db.client.nfeEmitida.findMany({ orderBy: { dataEmissao: "desc" } })).map((l: any) => l.id),
    ).toEqual([n2.id, n1.id]);
    const comItens = await db.client.nfeEmitida.findUnique({
      where: { id: n1.id },
      include: { itens: { orderBy: { numero: "asc" } } },
    });
    expect(comItens.itens.map((i: any) => i.codigo)).toEqual(["A", "B"]);
    expect(await db.client.nfeEmitida.findFirst({ where: { id: n1.id }, select: { numero: true } })).toEqual({
      numero: 1,
    });
    await expect(
      db.client.nfeItem.create({
        data: { nfeId: "orfa", numero: 1, codigo: "X", descricao: "X", ncm: "1", cfop: "5102", origem: 0, unidade: "UN", quantidade: 1, valorUnitario: 1, valorTotal: 1 },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
    await db.client.nfeEmitida.delete({ where: { id: n1.id } });
    expect(db.tabela("nfeItem")).toHaveLength(0);
  });

  it("$transaction(fn) desfaz as escritas da transação — e só elas", async () => {
    const db = createInMemoryPrisma();
    const { id } = await db.client.nfeEmitida.create({ data: nota() });
    let liberarTx!: () => void;
    const pausa = new Promise<void>((r) => (liberarTx = r));
    const tx = db.client.$transaction(async (t: any) => {
      await t.nfeEmitida.update({ where: { id }, data: { status: "VALIDATING" } });
      await t.nfeAuditLog.create({ data: { nfeId: id, userId: "u1", evento: "DENTRO" } });
      await pausa;
      throw new Error("falhou no meio");
    });
    // Escrita concorrente pelo cliente raiz enquanto a transação está aberta.
    await db.client.nfeAuditLog.create({ data: { nfeId: id, userId: "u1", evento: "FORA" } });
    liberarTx();
    await expect(tx).rejects.toThrow(/falhou no meio/);
    expect(db.linha("nfeEmitida", id)!.status).toBe("DRAFT");
    expect(db.tabela("nfeAuditLog").map((l) => l.evento)).toEqual(["FORA"]);
    expect(await db.client.$transaction(async () => 42)).toBe(42);
  });

  it("SQL cru: sem handler lança claro; handler trata e desfaz junto com a transação", async () => {
    const db = createInMemoryPrisma();
    await expect(db.client.$queryRawUnsafe(`SELECT 1 FROM "NfeNumeroReserva"`)).rejects.toThrow(
      /sem handler registrado.*NfeNumeroReserva/,
    );
    const reservas: number[] = [];
    db.aoSqlCru((c) => {
      if (!c.sql.startsWith("INSERT INTO reserva")) return SQL_NAO_TRATADO;
      reservas.push(Number(c.params[0]));
      c.registrarDesfazer(() => reservas.pop());
      return 1;
    });
    await db.client.$executeRawUnsafe("INSERT INTO reserva VALUES ($1)", 101);
    await expect(
      db.client.$transaction(async (t: any) => {
        await t.$executeRawUnsafe("INSERT INTO reserva VALUES ($1)", 102);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(reservas).toEqual([101]);
    await expect(db.client.$queryRaw`SELECT ${1}`).rejects.toThrow(/SELECT \$1/);
  });

  it("falharProxima injeta erro só na chamada que casa o predicado; escritas ficam registradas", async () => {
    const db = createInMemoryPrisma();
    const { id } = await db.client.nfeEmitida.create({ data: nota() });
    db.falharProxima(
      "nfeEmitida.update",
      () => new ErroPrismaMemoria("PrismaClientKnownRequestError", "dup", "P2002"),
      (args) => args?.data?.numero !== undefined,
    );
    await db.client.nfeEmitida.update({ where: { id }, data: { status: "VALIDATING" } });
    await expect(db.client.nfeEmitida.update({ where: { id }, data: { numero: 5 } })).rejects.toMatchObject({
      code: "P2002",
    });
    await db.client.nfeEmitida.update({ where: { id }, data: { numero: 5 } });
    expect(db.escritas("nfeEmitida").map((e) => e.operacao)).toEqual(["create", "update", "update"]);
  });
});

describe("fake-authority", () => {
  it("autoriza uma vez; 204 mesma chave, 539 outra chave, 206 inutilizada, consulta 217/101", () => {
    const a = new FakeAuthority();
    const id = { cnpj: "11222333000181", ambiente: "HOMOLOGACAO" as const, modelo: "55" as const, serie: 1, numero: 101 };
    const r = a.autorizar(id, { nfeId: "nfe-1" });
    expect(r.cStat).toBe(100);
    expect(r.chave).toMatch(/^\d{44}$/);
    expect(r.chave!.slice(25, 34)).toBe("000000101");
    expect(a.autorizar(id, { chave: r.chave! }).cStat).toBe(204);
    expect(a.autorizar(id, { chave: a.montarChave(id, { cNF: "13572468" }) }).cStat).toBe(539);
    expect(a.inutilizar(id, 102, 103).cStat).toBe(102);
    expect(a.autorizar({ ...id, numero: 102 }).cStat).toBe(206);
    expect(a.inutilizar(id, 101, 101).cStat).toBe(241);
    expect(a.consultarPorChave("9".repeat(44)).cStat).toBe(217);
    expect(a.cancelar(r.chave!).cStat).toBe(135);
    expect(a.consultarPorChave(r.chave!).cStat).toBe(101);
    expect(a.numerosAutorizados({ serie: 1 })).toEqual([101]);
    expect(a.autorizacoesPorNfe("nfe-1")).toBe(1);
  });
});

describe("scripted-provider", () => {
  it("consome filas por operação, registra chamadas e lança sem roteiro", async () => {
    const p = createScriptedProvider();
    const input = { nfeData: { cnpj_emitente: "11222333000181", serie: "1", numero_nota: "7" }, token: "t", ref: "nfe-1" };
    p.fila("emitir", passos.rejeitar("974", "Rejeicao 974"), passos.erro("timeout"));
    expect(await p.emitir(input)).toMatchObject({ status: "rejeitada", codigoStatus: "974" });
    expect(await p.emitir(input)).toMatchObject({ status: "erro", mensagem: "timeout" });
    await expect(p.emitir(input)).rejects.toThrow(/nenhum passo roteirizado para emitir \(chamada #3\)/);
    expect(p.ops()).toEqual(["emitir", "emitir", "emitir"]);
  });

  it("autorizar com autoridade grava o número; segurar mantém a chamada em voo", async () => {
    const a = new FakeAuthority();
    const p = createScriptedProvider();
    const input = {
      nfeData: { cnpj_emitente: "11222333000181", serie: "1", numero_nota: "7", uf_emitente: "SP" },
      token: "t",
      ref: "nfe-1",
    };
    const h = passos.segurar();
    p.fila("emitir", h.passo, passos.autorizar({ autoridade: a }));
    const emVoo = p.emitir(input);
    await h.chegou;
    h.liberar(passos.autorizar({ autoridade: a }));
    const r = await emVoo;
    expect(r.status).toBe("autorizada");
    expect(a.numerosAutorizados()).toEqual([7]);
    // Segunda autorização do MESMO número com a mesma chave: 204 → processando.
    expect(await p.emitir(input)).toMatchObject({ status: "processando", codigoStatus: 204 });
  });
});

describe("numeracao-memory", () => {
  it("primeira reserva cria 1; com emitente padrão adota linha legada NULL; não-padrão não adota", async () => {
    const db = createInMemoryPrisma();
    const n = createNumeracaoMemory(db);
    expect(await n.reservarProximoNumero("u1", "HOMOLOGACAO", 1)).toBe(1);
    expect(await n.reservarProximoNumero("u1", "HOMOLOGACAO", 1)).toBe(2);
    // Linha legada (cfc NULL, próximo 3) adotada pelo padrão.
    expect(
      await n.reservarProximoNumero("u1", "HOMOLOGACAO", 1, "55", { companyFiscalConfigId: "cfg-a", isDefaultConfig: true }),
    ).toBe(3);
    expect(db.tabela("nfeSequence")).toHaveLength(1);
    expect(db.tabela("nfeSequence")[0].companyFiscalConfigId).toBe("cfg-a");
    // Emitente não-padrão começa do 1.
    expect(
      await n.reservarProximoNumero("u1", "HOMOLOGACAO", 1, "55", { companyFiscalConfigId: "cfg-b", isDefaultConfig: false }),
    ).toBe(1);
    expect(await n.consultarProximoNumero("u1", "HOMOLOGACAO", 1, "55", { companyFiscalConfigId: "cfg-b", isDefaultConfig: false })).toBe(2);
    await expect(
      n.ajustarProximoNumero("u1", "HOMOLOGACAO", 1, 2, "55", { companyFiscalConfigId: "cfg-b", isDefaultConfig: false }),
    ).rejects.toThrow(/deve ser maior que o atual/);
  });

  it("FOR UPDATE modelado: 20 reservas concorrentes intercaladas dão 1..20 sem repetição", async () => {
    for (const semente of [1, 7, 42]) {
      const db = createInMemoryPrisma({ intercalar: true, semente });
      const n = createNumeracaoMemory(db);
      const opts = { companyFiscalConfigId: "cfg-a", isDefaultConfig: true };
      const numeros = await Promise.all(
        Array.from({ length: 20 }, () => n.reservarProximoNumero("u1", "PRODUCAO", 3, "55", opts)),
      );
      expect([...numeros].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      expect(db.tabela("nfeSequence")[0].proximoNumero).toBe(21);
    }
  });
});

describe("emit-world", () => {
  it("reset limpa estado sem trocar os módulos entregues ao vi.mock", () => {
    const w = new EmitWorld();
    const modulos = w.modules;
    const prisma = w.prisma;
    const cfg = w.seedConfig();
    const id = w.seedAutorizada(100, { config: cfg });
    w.setProximoNumero(101, { config: cfg });
    expect(w.row(id)).toMatchObject({ status: "AUTHORIZED", numero: 100 });
    expect(w.proximoNumero({ config: cfg })).toBe(101);
    expect(w.checarInvariantes()).toEqual([]);
    w.reset();
    expect(w.modules).toBe(modulos);
    expect(w.prisma).toBe(prisma);
    expect(w.db.tabela("nfeEmitida")).toHaveLength(0);
    expect(w.authority.registros()).toHaveLength(0);
  });

  it("storage e factory fakes injetam falha uma vez", async () => {
    const w = new EmitWorld();
    const storage = new w.modules.storage.FiscalStorageService();
    w.storage.failNext("saveXmlOriginal");
    await expect(storage.saveXmlOriginal("u1", "n1", "{}")).rejects.toThrow(/falha injetada/);
    const caminho = await storage.saveXmlOriginal("u1", "n1", "{}");
    expect(w.storage.lerTexto(caminho)).toBe("{}");
    w.providerFactory.failNext();
    await expect(
      w.modules.providerFactory.createNfeProviderFromConfig({ providerName: "SEFAZ_DIRECT", ambiente: "HOMOLOGACAO" }),
    ).rejects.toThrow(/certificado/);
    expect(w.modules.providerFactory.createNfeProvider("FOCUS_NFE", "HOMOLOGACAO")).toBe(w.provider);
  });

  it("comTimersFalsos assenta promessas que dependem de setTimeout", async () => {
    const w = new EmitWorld();
    const valor = await w.comTimersFalsos(
      () => new Promise<string>((r) => setTimeout(() => r("ok"), 9000)),
    );
    expect(valor).toBe("ok");
  });
});
