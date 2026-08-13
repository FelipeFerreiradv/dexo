import { beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// P3.2 — quanto cada cliente usou o Bitz.
//
// ⭐⭐ DUAS AFIRMAÇÕES, E AS DUAS SÃO SOBRE O QUE O RELATÓRIO **NÃO** FAZ:
//
//  1. ELE NÃO INVENTA DINHEIRO. Não existe tabela de preço por token no
//     sistema. Um valor em reais chumbado aqui ficaria errado no dia em que o
//     provedor mudasse o preço — em silêncio, sem teste que quebrasse — e seria
//     lido num painel usado para decidir PREÇO DE PLANO.
//
//  2. ELE NÃO LÊ CONVERSA. A equipe Dexo vê QUANTO o cliente usou; o que ele
//     perguntou é dele. O teste abaixo falha se alguém acoplar `content` à
//     projeção.
// ===========================================================================

const findManyUsersMock = vi.fn();
const findManyUsageMock = vi.fn();
const queryRawMock = vi.fn();

vi.mock("../app/lib/prisma", () => ({
  default: {
    user: { findMany: (...a: any[]) => findManyUsersMock(...a) },
    providerDailyUsage: { findMany: (...a: any[]) => findManyUsageMock(...a) },
    $queryRaw: (...a: any[]) => queryRawMock(...a),
  },
}));

import { consumoDeIaPorCliente } from "../app/ai/quota/ai-consumo.service";

const DONO = {
  id: "t1",
  name: "Desmanche 777",
  email: "dono@777.com",
  aiEnabledAt: new Date("2026-07-01"),
  aiDailyLimit: 200,
};

beforeEach(() => {
  findManyUsersMock.mockReset().mockResolvedValue([DONO]);
  findManyUsageMock.mockReset().mockResolvedValue([]);
  queryRawMock.mockReset().mockResolvedValue([]);
});

// ---------------------------------------------------------------------------

describe("⭐⭐ o relatório não inventa dinheiro", () => {
  it("não devolve campo nenhum de custo em reais", async () => {
    const r = await consumoDeIaPorCliente(30);
    const cru = JSON.stringify(r).toLowerCase();

    expect(cru).not.toMatch(/"custo|"valor|"reais|"brl|r\$/);
  });

  it("e diz POR QUE, para ninguém achar que foi esquecimento", async () => {
    const r = await consumoDeIaPorCliente(30);

    expect(r.observacao).toMatch(/não há tabela de preço/i);
    expect(r.observacao).toMatch(/multiplique pelo preço vigente/i);
  });
});

describe("⭐⭐ o relatório não lê conversa", () => {
  it("a consulta de usuários não pede nada além dos contadores", async () => {
    await consumoDeIaPorCliente(30);

    const select = findManyUsersMock.mock.calls[0][0].select;
    expect(Object.keys(select).sort()).toEqual([
      "aiDailyLimit",
      "aiEnabledAt",
      "email",
      "id",
      "name",
    ]);
  });

  it("⚠️ o SQL dos tokens não seleciona conteúdo nem título", async () => {
    await consumoDeIaPorCliente(30);

    // `$queryRaw` com template tagueado: o texto do SQL vem no primeiro arg.
    const sql = String(queryRawMock.mock.calls[0][0]).toLowerCase();
    expect(sql).not.toContain("content");
    expect(sql).not.toContain("title");
    expect(sql).not.toContain("sources");
  });

  it("nenhum conteúdo aparece no retorno, mesmo se o banco devolver a mais", async () => {
    queryRawMock.mockResolvedValue([
      {
        tenant: "t1",
        motivo: null,
        entrada: 100,
        saida: 10,
        respostas: 4,
        ultimo: new Date("2026-08-10"),
        // O banco não devolve isto — mas se um dia devolvesse, não pode passar.
        content: "quanto vendi em julho",
      },
    ]);

    const r = await consumoDeIaPorCliente(30);

    expect(JSON.stringify(r)).not.toContain("quanto vendi");
  });
});

describe("⭐ ele soma as três cotas separadas", () => {
  it("mensagens, áudios e anexos vêm de prefixos diferentes", async () => {
    findManyUsageMock.mockResolvedValue([
      { provider: "ai:tenant:t1", count: 40 },
      { provider: "ai:tenant:t1", count: 12 }, // outro dia da janela
      { provider: "ai:audio:t1", count: 7 },
      { provider: "ai:anexo:t1", count: 3 },
      // Ruído de outro consumidor da mesma tabela: NÃO pode entrar na conta.
      { provider: "rembg", count: 999 },
      { provider: "ai:global", count: 500 },
    ]);

    const r = await consumoDeIaPorCliente(30);
    const c = r.clientes[0];

    expect(c.mensagens).toBe(52);
    expect(c.audios).toBe(7);
    expect(c.anexos).toBe(3);
  });

  it("⚠️ contador de OUTRO tenant não vaza para este", async () => {
    findManyUsageMock.mockResolvedValue([
      { provider: "ai:tenant:t1", count: 5 },
      { provider: "ai:tenant:OUTRO", count: 900 },
    ]);

    const r = await consumoDeIaPorCliente(30);

    expect(r.clientes).toHaveLength(1);
    expect(r.clientes[0].mensagens).toBe(5);
    expect(r.totais.mensagens).toBe(5);
  });

  it("os tokens vêm do AiMessage e casam pelo tenant", async () => {
    queryRawMock.mockResolvedValue([
      {
        tenant: "t1",
        motivo: null,
        entrada: 59131,
        saida: 2915,
        respostas: 12,
        ultimo: null,
      },
      {
        tenant: "fantasma",
        motivo: null,
        entrada: 9,
        saida: 9,
        respostas: 9,
        ultimo: null,
      },
    ]);

    const r = await consumoDeIaPorCliente(30);

    expect(r.clientes[0].tokensEntrada).toBe(59131);
    expect(r.clientes[0].respostas).toBe(12);
    // Tenant sem Bitz liberado não vira linha do relatório.
    expect(r.clientes.map((c) => c.tenantId)).toEqual(["t1"]);
  });
});

// ---------------------------------------------------------------------------
// ⭐⭐ O DEFEITO QUE A PRIMEIRA MEDIÇÃO REAL PEGOU.
//
// A versão anterior punha `mensagens` (turnos reservados na COTA) ao lado de
// `turnosComErro` (linhas de `AiMessage`). Contra a produção isso saiu como
// "12 erros em 12 mensagens" — lido como 100% de falha. Os 12 erros eram de 27
// respostas. Dois denominadores diferentes lado a lado viram uma razão na
// cabeça de quem lê, e essa razão estava errada por mais que os dois números
// estivessem certos.
// ---------------------------------------------------------------------------

describe("⭐⭐ o erro anda junto do próprio denominador", () => {
  const linhas = [
    { tenant: "t1", motivo: null, entrada: 500, saida: 50, respostas: 12, ultimo: null },
    { tenant: "t1", motivo: "erro_provedor", entrada: 0, saida: 0, respostas: 8, ultimo: null },
    { tenant: "t1", motivo: "rate_limit_provedor", entrada: 0, saida: 0, respostas: 5, ultimo: null },
    { tenant: "t1", motivo: "quota_tenant", entrada: 0, saida: 0, respostas: 2, ultimo: null },
  ];

  it("a taxa de erro fecha sobre RESPOSTAS, não sobre a cota", async () => {
    queryRawMock.mockResolvedValue(linhas);
    findManyUsageMock.mockResolvedValue([
      { provider: "ai:tenant:t1", count: 12 },
    ]);

    const c = (await consumoDeIaPorCliente(30)).clientes[0];

    expect(c.respostas).toBe(27);
    expect(c.respostasComErro).toBe(15);
    // E o número da cota continua existindo, com o significado dele.
    expect(c.mensagens).toBe(12);
  });

  it("⭐ `quota_tenant` sai separado — é o teto do cliente, não falha nossa", async () => {
    queryRawMock.mockResolvedValue(linhas);

    const c = (await consumoDeIaPorCliente(30)).clientes[0];

    expect(c.errosPorMotivo).toEqual({
      erro_provedor: 8,
      rate_limit_provedor: 5,
      quota_tenant: 2,
    });
  });

  it("⚠️ o SQL conta só a RESPOSTA — senão o denominador dobra", async () => {
    await consumoDeIaPorCliente(30);

    const sql = String(queryRawMock.mock.calls[0][0]);
    expect(sql).toMatch(/role = 'assistant'/);
  });

  it("⚠️ todo agregado do SQL é castado — BigInt não serializa em JSON", async () => {
    // ⚠️ ESTA É A ÚNICA GUARDA POSSÍVEL AQUI, E VALE DIZER POR QUÊ. `$queryRaw`
    // está mockado: nada nesta suíte toca Postgres, então o BigInt nunca
    // aparece e nenhum teste de comportamento pode pegá-lo. Tirar um `::int`
    // passaria verde na suíte inteira e responderia 500 em produção — foi
    // exatamente o que uma mutação deliberada provou.
    //
    // O relatório foi conferido à mão contra o banco de produção; isto aqui é o
    // que impede a regressão de voltar sem ninguém ver.
    await consumoDeIaPorCliente(30);
    const sql = String(queryRawMock.mock.calls[0][0]);

    for (const linha of sql.split("\n")) {
      if (!/\b(COUNT|SUM)\s*\(/i.test(linha)) continue;
      expect(linha, `agregado sem ::int → 500 na rota: ${linha.trim()}`).toMatch(
        /::int/,
      );
    }
  });

  it("a observação avisa para não dividir um denominador pelo outro", async () => {
    const r = await consumoDeIaPorCliente(30);

    expect(r.observacao).toMatch(/denominadores diferentes/i);
    expect(r.observacao).toMatch(/quota_tenant/);
  });

  it("os motivos somam no total da plataforma", async () => {
    queryRawMock.mockResolvedValue(linhas);

    const t = (await consumoDeIaPorCliente(30)).totais;

    expect(t.respostas).toBe(27);
    expect(t.errosPorMotivo.erro_provedor).toBe(8);
  });
});

describe("⭐ só quem TEM o Bitz entra", () => {
  it("a consulta filtra por `aiEnabledAt` e por conta-mãe", async () => {
    await consumoDeIaPorCliente(30);

    expect(findManyUsersMock.mock.calls[0][0].where).toEqual({
      parentUserId: null,
      aiEnabledAt: { not: null },
    });
  });

  it("distingue 'tem o Bitz' de 'usou o Bitz'", async () => {
    findManyUsersMock.mockResolvedValue([DONO, { ...DONO, id: "t2" }]);
    findManyUsageMock.mockResolvedValue([
      { provider: "ai:tenant:t1", count: 4 },
    ]);

    const r = await consumoDeIaPorCliente(30);

    expect(r.totais.clientesComBitz).toBe(2);
    expect(r.totais.clientesQueUsaram).toBe(1);
  });
});

describe("⭐ a janela", () => {
  it("é rolante e diz o primeiro dia incluído", async () => {
    const r = await consumoDeIaPorCliente(7);

    expect(r.dias).toBe(7);
    expect(r.de).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // E o filtro do contador diário usa esse mesmo dia.
    expect(findManyUsageMock.mock.calls[0][0].where.day.gte).toBe(r.de);
  });

  it("⚠️ tem teto — 'dias=99999' não vira varredura da tabela inteira", async () => {
    expect((await consumoDeIaPorCliente(99999)).dias).toBe(365);
  });

  it("valor torto cai no padrão de 30 dias", async () => {
    expect((await consumoDeIaPorCliente(NaN as any)).dias).toBe(30);
    expect((await consumoDeIaPorCliente(0)).dias).toBe(30);
    expect((await consumoDeIaPorCliente(-5)).dias).toBe(1);
  });
});
