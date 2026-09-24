import { beforeEach, describe, expect, it, vi } from "vitest";

// Ajuste MANUAL do próximo número da série (NfeSequenceAjusteUseCase).
//
// É a saída do 409 SEQUENCIA_ATRAS_DA_SEFAZ para o cliente migrado de outro
// sistema fiscal: o contador do Dexo nasce atrás da numeração que o CNPJ já
// usou e a SEFAZ recusa tudo com 539/562/613. Até 09/2026 mover
// `NfeSequence.proximoNumero` era SQL em produção, na mão.
//
// O que estes testes guardam (as invariantes que tornam o botão seguro):
//  (a) avança e deixa rastro — quem, quando, de quanto para quanto, onde, por quê;
//  (b) NUNCA retrocede, e igualdade também é recusada (reajustar para o valor
//      atual não corrige nada e não destravaria o guard da V2);
//  (c) sem confirmação explícita, responde 409 e NÃO escreve — o efeito é
//      irreversível (número pulado vira lacuna que pode exigir inutilização);
//  (d) escopo por EMITENTE: com dois CNPJs no mesmo tenant, move o pedido e só
//      ele — mover o contador do CNPJ errado é o pior erro possível aqui;
//  (e) config de OUTRO tenant é invisível (findByIdForUser é escopado).
//
// O teste usa o `NfeSequenceService` e o `CompanyFiscalRepository` REAIS sobre
// um prisma em memória — o que está sob teste é a composição (escopo, guarda,
// confirmação, auditoria), não um dublê do serviço de numeração.

const h = vi.hoisted(() => {
  interface SeqRow {
    id: string;
    userId: string;
    ambiente: string;
    serie: number;
    modelo: string;
    proximoNumero: number;
    companyFiscalConfigId: string | null;
  }
  const state = {
    configs: [] as Array<Record<string, unknown>>,
    sequences: [] as SeqRow[],
    logs: [] as Array<Record<string, any>>,
    seq: 0,
    /** Gancho da corrida: roda DEPOIS de cada leitura de sequência, sobre a
     *  linha real — o findFirst devolve uma cópia, então o valor já lido não
     *  muda retroativamente (senão o teste exercitaria a pré-checagem, não a
     *  corrida). */
    aposLerSequencia: null as null | ((linha: SeqRow) => void),
  };

  const escalaresBatem = (row: any, where: any): boolean =>
    Object.entries(where).every(([campo, valor]) =>
      campo === "OR" ? true : row[campo] === valor,
    );

  const prisma = {
    companyFiscalConfig: {
      findFirst: async ({ where }: any) => {
        // `findByUserId` ordena "padrão primeiro"; reproduzimos só o essencial.
        const achados = state.configs.filter((c) => escalaresBatem(c, where));
        return (
          achados.find((c) => c.isDefault === true) ?? achados[0] ?? null
        );
      },
    },
    nfeSequence: {
      findFirst: async ({ where }: any) => {
        const permitidos: Array<string | null> = (where.OR ?? []).map(
          (o: any) => o.companyFiscalConfigId,
        );
        const achados = state.sequences.filter(
          (s) =>
            escalaresBatem(s, where) &&
            (where.OR === undefined ||
              permitidos.includes(s.companyFiscalConfigId)),
        );
        // orderBy companyFiscalConfigId asc = NULLS LAST no Postgres: a linha
        // já adotada vem antes da legada (é o que o serviço real espera).
        achados.sort((a, b) =>
          a.companyFiscalConfigId === b.companyFiscalConfigId
            ? 0
            : a.companyFiscalConfigId === null
              ? 1
              : b.companyFiscalConfigId === null
                ? -1
                : a.companyFiscalConfigId.localeCompare(b.companyFiscalConfigId),
        );
        const achado = achados[0] ?? null;
        if (!achado) return null;
        // Cópia: o chamador leva o valor DESTE instante. Só depois o gancho
        // mexe na linha real, simulando a emissão que passou na frente.
        const lido = { ...achado };
        if (state.aposLerSequencia) state.aposLerSequencia(achado);
        return lido;
      },
      update: async ({ where, data }: any) => {
        const row = state.sequences.find((s) => s.id === where.id);
        if (!row) throw new Error("NfeSequence não encontrada");
        Object.assign(row, data);
        return row;
      },
      create: async ({ data }: any) => {
        const row = {
          id: `seq-${++state.seq}`,
          companyFiscalConfigId: null,
          ...data,
        };
        state.sequences.push(row);
        return row;
      },
    },
    systemLog: {
      create: async ({ data }: any) => {
        state.logs.push(data);
        return { id: `log-${state.logs.length}`, ...data };
      },
    },
  };
  return { state, prisma };
});

vi.mock("../../../app/lib/prisma", () => ({ default: h.prisma }));
vi.mock("@/app/lib/prisma", () => ({ default: h.prisma }));

import { NumeracaoError } from "../../../app/fiscal/numeracao/numeracao.errors";
import { NfeSequenceAjusteUseCase } from "../../../app/usecases/nfe-sequence-ajuste.usecase";

const TENANT = "tenant-mk2";
const MOTIVO = "cliente informou que o ultimo numero no sistema anterior foi 4999";

function config(over: Record<string, unknown> = {}) {
  return {
    id: "cfg-matriz",
    userId: TENANT,
    cnpj: "11222333000181",
    razaoSocial: "MK2 Auto Pecas LTDA",
    ambiente: "PRODUCAO",
    regimeTributario: "SIMPLES",
    isDefault: true,
    serieNfe: 1,
    ...over,
  };
}

function sequencia(over: Record<string, unknown> = {}) {
  return {
    id: `seq-fixa-${h.state.sequences.length + 1}`,
    userId: TENANT,
    ambiente: "PRODUCAO",
    serie: 1,
    modelo: "55",
    proximoNumero: 100,
    companyFiscalConfigId: "cfg-matriz",
    ...over,
  } as any;
}

const contadorDe = (cfc: string | null) =>
  h.state.sequences.find((s) => s.companyFiscalConfigId === cfc)?.proximoNumero;

const entrada = (over: Record<string, unknown> = {}) => ({
  ambiente: "PRODUCAO",
  modelo: "55",
  serie: 1,
  proximoNumero: 5000,
  motivo: MOTIVO,
  ...over,
});

const usecase = () => new NfeSequenceAjusteUseCase();

beforeEach(() => {
  h.state.configs.length = 0;
  h.state.sequences.length = 0;
  h.state.logs.length = 0;
  h.state.seq = 0;
  h.state.aposLerSequencia = null;
});

describe("ajuste do próximo número da série", () => {
  it("(a) avança o contador e grava a auditoria com quem/quando/de-para/escopo/motivo", async () => {
    h.state.configs.push(config());
    h.state.sequences.push(sequencia({ proximoNumero: 100 }));

    const r = await usecase().ajustar(
      TENANT,
      entrada({ confirmar: true }),
      { atorUserId: "colaborador-1", ipAddress: "10.0.0.7", userAgent: "vitest" },
    );

    expect(r).toMatchObject({
      companyFiscalConfigId: "cfg-matriz",
      emitenteDocumento: "11222333000181",
      ambiente: "PRODUCAO",
      modelo: "55",
      serie: 1,
      proximoNumeroAnterior: 100,
      proximoNumero: 5000,
      numerosPulados: 4900,
      motivo: MOTIVO,
    });
    expect(contadorDe("cfg-matriz")).toBe(5000);

    expect(h.state.logs).toHaveLength(1);
    const log = h.state.logs[0];
    expect(log.action).toBe("ADJUST_NFE_SEQUENCE");
    expect(log.level).toBe("WARNING");
    expect(log.resource).toBe("NfeSequence");
    expect(log.resourceId).toBe("cfg-matriz");
    // QUEM: o usuário que clicou (colaborador tem id próprio), com o tenant ao lado.
    expect(log.userId).toBe("colaborador-1");
    expect(log.ipAddress).toBe("10.0.0.7");
    expect(log.details).toMatchObject({
      tenantUserId: TENANT,
      atorUserId: "colaborador-1",
      companyFiscalConfigId: "cfg-matriz",
      emitenteDocumento: "11222333000181",
      ambiente: "PRODUCAO",
      modelo: "55",
      serie: 1,
      proximoNumeroAnterior: 100,
      proximoNumero: 5000,
      numerosPulados: 4900,
      motivo: MOTIVO,
      requerInutilizacao: true,
    });
    // QUANDO: carimbo próprio no registro (o createdAt do SystemLog é o do banco).
    expect(typeof log.details.ajustadoEm).toBe("string");
    // Nomes de campo escolhidos para não colidirem com o `sanitizeDeep`, que
    // redige por substring — um campo chamado "cnpj" sairia [REDACTED].
    expect(Object.keys(log.details).some((k) => /cnpj|cpf|token|senha/i.test(k))).toBe(false);
  });

  it("(b) recusa retroceder — e recusa também a igualdade", async () => {
    h.state.configs.push(config());
    h.state.sequences.push(sequencia({ proximoNumero: 100 }));

    for (const numero of [50, 100]) {
      const erro = await usecase()
        .ajustar(TENANT, entrada({ proximoNumero: numero, confirmar: true }))
        .then(() => null, (e: unknown) => e as NumeracaoError);

      expect(erro).toBeInstanceOf(NumeracaoError);
      expect(erro!.code).toBe("SEQUENCIA_NAO_RETROCEDE");
      expect(erro!.httpStatus).toBe(409);
      expect(erro!.detalhes).toMatchObject({
        proximoNumeroAtual: 100,
        proximoNumeroSolicitado: numero,
      });
      // Nada escrito, nada auditado.
      expect(contadorDe("cfg-matriz")).toBe(100);
      expect(h.state.logs).toHaveLength(0);
    }
  });

  it("(c) sem confirmação: 409 dizendo quantos números serão pulados — e NÃO escreve", async () => {
    h.state.configs.push(config());
    h.state.sequences.push(sequencia({ proximoNumero: 100 }));

    const erro = await usecase()
      .ajustar(TENANT, entrada())
      .then(() => null, (e: unknown) => e as NumeracaoError);

    expect(erro).toBeInstanceOf(NumeracaoError);
    expect(erro!.code).toBe("NUMERACAO_CONFIRMAR_AJUSTE");
    expect(erro!.httpStatus).toBe(409);
    expect(erro!.detalhes).toMatchObject({
      proximoNumeroAtual: 100,
      proximoNumeroSolicitado: 5000,
      numerosPulados: 4900,
      requerInutilizacao: true,
    });
    // A mensagem diz o efeito antes de ele acontecer: quantos ficam sem uso e
    // que a lacuna pode exigir inutilização junto à SEFAZ.
    expect(erro!.message).toContain("4900");
    expect(erro!.message).toContain("inutilização");
    expect(contadorDe("cfg-matriz")).toBe(100);
    expect(h.state.logs).toHaveLength(0);

    // Com a confirmação, o MESMO pedido aplica.
    await usecase().ajustar(TENANT, entrada({ confirmar: true }));
    expect(contadorDe("cfg-matriz")).toBe(5000);
    expect(h.state.logs).toHaveLength(1);
  });

  it("(d) escopo por emitente: move o contador do CNPJ pedido e não o do outro", async () => {
    h.state.configs.push(config());
    h.state.configs.push(
      config({
        id: "cfg-filial",
        cnpj: "11222333000262",
        razaoSocial: "MK2 Auto Pecas Filial LTDA",
        isDefault: false,
      }),
    );
    // MESMO (ambiente, série, modelo) nos dois CNPJs — é exatamente o caso em
    // que ignorar o escopo moveria a numeração da empresa errada.
    h.state.sequences.push(sequencia({ proximoNumero: 100 }));
    h.state.sequences.push(
      sequencia({ companyFiscalConfigId: "cfg-filial", proximoNumero: 700 }),
    );

    const r = await usecase().ajustar(
      TENANT,
      entrada({
        companyFiscalConfigId: "cfg-filial",
        proximoNumero: 900,
        confirmar: true,
      }),
    );

    expect(r.companyFiscalConfigId).toBe("cfg-filial");
    expect(r.proximoNumeroAnterior).toBe(700);
    expect(contadorDe("cfg-filial")).toBe(900);
    expect(contadorDe("cfg-matriz")).toBe(100);
    expect(h.state.logs[0].resourceId).toBe("cfg-filial");
    expect(h.state.logs[0].details.emitenteDocumento).toBe("11222333000262");

    // E a volta: mover a MATRIZ não pode encostar na filial. Os dois sentidos
    // importam — um ajuste que ignore o escopo acerta por sorte em um deles,
    // dependendo de qual linha o banco devolve primeiro.
    const rMatriz = await usecase().ajustar(
      TENANT,
      entrada({
        companyFiscalConfigId: "cfg-matriz",
        proximoNumero: 5000,
        confirmar: true,
      }),
    );
    expect(rMatriz.proximoNumeroAnterior).toBe(100);
    expect(contadorDe("cfg-matriz")).toBe(5000);
    expect(contadorDe("cfg-filial")).toBe(900);
  });

  it("(d2) a linha legada (configId NULL) é do CNPJ PADRÃO — emitente secundário não a move", async () => {
    h.state.configs.push(config());
    h.state.configs.push(config({ id: "cfg-filial", cnpj: "11222333000262", isDefault: false }));
    h.state.sequences.push(
      sequencia({ companyFiscalConfigId: null, proximoNumero: 100 }),
    );

    // Secundário não enxerga a linha legada: parte de 1 e ganha linha PRÓPRIA.
    await usecase().ajustar(
      TENANT,
      entrada({ companyFiscalConfigId: "cfg-filial", proximoNumero: 50, confirmar: true }),
    );
    expect(contadorDe("cfg-filial")).toBe(50);
    expect(contadorDe(null)).toBe(100);

    // O padrão adota a legada (grava o configId) e move o contador certo.
    await usecase().ajustar(TENANT, entrada({ proximoNumero: 5000, confirmar: true }));
    expect(contadorDe("cfg-matriz")).toBe(5000);
    expect(h.state.sequences.filter((s) => s.companyFiscalConfigId === null)).toHaveLength(0);
    expect(contadorDe("cfg-filial")).toBe(50);
  });

  it("(e) usuário de outro tenant não alcança a config — nem pelo id explícito", async () => {
    h.state.configs.push(config());
    h.state.sequences.push(sequencia({ proximoNumero: 100 }));

    const erro = await usecase()
      .ajustar("tenant-intruso", entrada({ companyFiscalConfigId: "cfg-matriz", confirmar: true }))
      .then(() => null, (e: unknown) => e as NumeracaoError);

    expect(erro).toBeInstanceOf(NumeracaoError);
    expect(erro!.code).toBe("EMITENTE_NAO_ENCONTRADO");
    expect(erro!.httpStatus).toBe(404);
    expect(contadorDe("cfg-matriz")).toBe(100);
    expect(h.state.logs).toHaveLength(0);

    // Sem id explícito, o intruso não tem config nenhuma: 409, e nada é criado.
    await expect(
      usecase().ajustar("tenant-intruso", entrada({ confirmar: true })),
    ).rejects.toMatchObject({ code: "CONFIG_FISCAL_AUSENTE", httpStatus: 409 });
    expect(h.state.sequences).toHaveLength(1);
    expect(contadorDe("cfg-matriz")).toBe(100);
  });

  it("entrada inválida é recusada antes de qualquer leitura de emitente", async () => {
    h.state.configs.push(config());
    h.state.sequences.push(sequencia({ proximoNumero: 100 }));

    const casos: Array<[string, Record<string, unknown>]> = [
      ["ambiente", { ambiente: "PROD" }],
      ["ambiente", { ambiente: undefined }],
      ["modelo", { modelo: "57" }],
      ["serie", { serie: 1000 }],
      ["serie", { serie: 1.5 }],
      ["proximoNumero", { proximoNumero: 0 }],
      ["proximoNumero", { proximoNumero: 1_000_000_000 }],
      ["motivo", { motivo: "migrou" }],
      ["motivo", { motivo: "x".repeat(501) }],
    ];

    for (const [campo, over] of casos) {
      const erro = await usecase()
        .ajustar(TENANT, entrada({ ...over, confirmar: true }) as any)
        .then(() => null, (e: unknown) => e as NumeracaoError);
      expect(erro, `${campo}: ${JSON.stringify(over)}`).toBeInstanceOf(NumeracaoError);
      expect(erro!.code).toBe("AJUSTE_ENTRADA_INVALIDA");
      expect(erro!.httpStatus).toBe(400);
      expect(erro!.detalhes).toMatchObject({ campo });
    }
    expect(contadorDe("cfg-matriz")).toBe(100);
    expect(h.state.logs).toHaveLength(0);
  });

  it("ambiente e modelo são contadores SEPARADOS — o ajuste não vaza entre eles", async () => {
    h.state.configs.push(config());
    h.state.sequences.push(sequencia({ proximoNumero: 100 }));
    h.state.sequences.push(
      sequencia({ id: "seq-homolog", ambiente: "HOMOLOGACAO", proximoNumero: 30 }),
    );
    h.state.sequences.push(
      sequencia({ id: "seq-nfce", modelo: "65", proximoNumero: 8 }),
    );

    await usecase().ajustar(TENANT, entrada({ proximoNumero: 5000, confirmar: true }));

    const valor = (ambiente: string, modelo: string) =>
      h.state.sequences.find((s) => s.ambiente === ambiente && s.modelo === modelo)
        ?.proximoNumero;
    expect(valor("PRODUCAO", "55")).toBe(5000);
    expect(valor("HOMOLOGACAO", "55")).toBe(30);
    expect(valor("PRODUCAO", "65")).toBe(8);
  });
});

describe("corrida entre a revisão e o Confirmar", () => {
  // O usecase lê o contador para montar a mensagem; quem escreve relê e recusa
  // `novo <= atual`. Se uma nota for emitida nesse intervalo, o serviço lança um
  // Error cru — que a rota devolveria como 500 sem `code`, e a tela cairia no
  // aviso genérico em vez de dizer ao operador o que aconteceu. Nada é escrito
  // nos dois casos; o que se afirma aqui é o CONTRATO do erro.
  it("devolve o 409 do contrato com o contador relido, e não escreve nada", async () => {
    h.state.configs.push(config());
    h.state.sequences.push(sequencia({ proximoNumero: 100 }));
    // Primeira leitura devolve 100 (a do usecase); a partir daí o contador já
    // está em 5200 — uma emissão passou na frente do número pedido (5000).
    let leituras = 0;
    h.state.aposLerSequencia = (linha) => {
      leituras += 1;
      // Depois da leitura do usecase (que viu 100), o contador vai para 5200:
      // é a nota emitida enquanto o operador lia o diálogo de confirmação.
      if (leituras === 1) linha.proximoNumero = 5200;
    };

    const erro = await usecase()
      .ajustar(TENANT, entrada({ confirmar: true }), { atorUserId: TENANT })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(NumeracaoError);
    const n = erro as InstanceType<typeof NumeracaoError>;
    expect(n.code).toBe("SEQUENCIA_NAO_RETROCEDE");
    expect(n.httpStatus).toBe(409);
    expect(n.message).toContain("5200");
    expect(n.detalhes).toMatchObject({
      proximoNumeroAtual: 5200,
      proximoNumeroSolicitado: 5000,
      companyFiscalConfigId: "cfg-matriz",
    });
    // O contador continua onde a emissão o deixou: o ajuste não escreveu.
    expect(contadorDe("cfg-matriz")).toBe(5200);
    expect(h.state.logs).toHaveLength(0);
  });
});
