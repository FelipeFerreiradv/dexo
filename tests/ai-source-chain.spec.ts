import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ORDEM_DAS_FONTES,
  resolverNaOrdem,
  respondeu,
  type Degrau,
} from "../app/ai/advisory/source-chain";
import type { AiSource } from "../app/ai/core/types";

// ===========================================================================
// ⭐ A hierarquia de fontes.
//
// A pergunta que este arquivo responde: a ordem das fontes é uma PROMESSA ou um
// FATO? Um prompt bem escrito é uma promessa — o modelo cumpre quando quer, e
// ninguém consegue provar que cumpriu. Aqui a ordem é execução, e por isso dá
// para observar: os espiões registram quem foi chamado, e o que importa não é
// só o resultado final, é QUEM NÃO FOI CHAMADO.
//
// A diferença entre "a fonte externa não respondeu" e "a fonte externa nem foi
// consultada" é a decisão inteira desta fase. Um teste que olhasse só o valor
// devolvido não distinguiria as duas.
// ===========================================================================

const fonteProprio: AiSource = {
  kind: "proprio",
  label: "Peças do seu catálogo",
  count: 3,
};
const fontePlataforma: AiSource = {
  kind: "plataforma",
  sampleSize: 12,
  confidence: "alta",
  matchKey: "farol|fiat|palio|*",
};
const fonteExterna: AiSource = {
  kind: "externa",
  provider: "mercado-livre",
};
const fonteRegra: AiSource = { kind: "regra", rule: "Título do ML: 60 chars" };

/** Um degrau que registra a chamada e responde (ou não). */
function espiao(
  nivel: Degrau<string>["nivel"],
  chamadas: string[],
  resposta: { valor: string; fonte: AiSource } | null,
): Degrau<string> {
  return {
    nivel,
    buscar: async () => {
      chamadas.push(nivel);
      return resposta;
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("a ordem é execução", () => {
  it("para no PRIMEIRO degrau que responde", async () => {
    const chamadas: string[] = [];
    const r = await resolverNaOrdem<string>([
      espiao("proprio", chamadas, { valor: "do cliente", fonte: fonteProprio }),
      espiao("plataforma", chamadas, {
        valor: "da base",
        fonte: fontePlataforma,
      }),
    ]);

    expect(r.valor).toBe("do cliente");
    expect(r.nivel).toBe("proprio");
    expect(r.fonte).toEqual(fonteProprio);
    // A segunda fonte NÃO foi consultada.
    expect(chamadas).toEqual(["proprio"]);
  });

  it("degrau vazio passa a vez para o seguinte", async () => {
    const chamadas: string[] = [];
    const r = await resolverNaOrdem<string>([
      espiao("proprio", chamadas, null),
      espiao("plataforma", chamadas, {
        valor: "da base",
        fonte: fontePlataforma,
      }),
    ]);

    expect(r.valor).toBe("da base");
    expect(chamadas).toEqual(["proprio", "plataforma"]);
    expect(r.trilha).toEqual([
      { nivel: "proprio", status: "vazio", ms: expect.any(Number) },
      { nivel: "plataforma", status: "respondeu", ms: expect.any(Number) },
    ]);
  });

  it("ninguém responde: valor null, e a trilha mostra que todos foram tentados", async () => {
    const chamadas: string[] = [];
    const r = await resolverNaOrdem<string>([
      espiao("proprio", chamadas, null),
      espiao("plataforma", chamadas, null),
    ]);

    expect(respondeu(r)).toBe(false);
    expect(r.valor).toBeNull();
    expect(r.fonte).toBeNull();
    expect(r.nivel).toBeNull();
    expect(r.trilha.map((p) => p.status)).toEqual(["vazio", "vazio"]);
  });

  it("dois degraus do MESMO nível são permitidos, na ordem declarada", async () => {
    // É o caso de `sugerir_descricao`: o texto padrão da loja vem antes das
    // descrições soltas, e os dois são `proprio`.
    const chamadas: string[] = [];
    const r = await resolverNaOrdem<string>([
      espiao("proprio", chamadas, null),
      espiao("proprio", chamadas, { valor: "segundo", fonte: fonteProprio }),
    ]);
    expect(r.valor).toBe("segundo");
    expect(chamadas).toEqual(["proprio", "proprio"]);
  });
});

describe("⭐ a pesquisa externa", () => {
  it("NÃO é consultada quando uma fonte interna respondeu", async () => {
    // Mesmo com a flag LIGADA: quem decide não é a flag, é a ordem.
    vi.stubEnv("AI_EXTERNAL_LOOKUP_ENABLED", "true");
    const chamadas: string[] = [];

    const r = await resolverNaOrdem<string>([
      espiao("proprio", chamadas, { valor: "do cliente", fonte: fonteProprio }),
      espiao("externa", chamadas, { valor: "do ML", fonte: fonteExterna }),
    ]);

    expect(r.valor).toBe("do cliente");
    expect(chamadas).not.toContain("externa");
    // E nem aparece na trilha: não foi tentada, não foi pulada — a cadeia
    // simplesmente acabou antes.
    expect(r.trilha.map((p) => p.nivel)).toEqual(["proprio"]);
  });

  it("é PULADA quando a flag está desligada, e a trilha diz isso", async () => {
    vi.stubEnv("AI_EXTERNAL_LOOKUP_ENABLED", "");
    const chamadas: string[] = [];

    const r = await resolverNaOrdem<string>([
      espiao("proprio", chamadas, null),
      espiao("externa", chamadas, { valor: "do ML", fonte: fonteExterna }),
    ]);

    expect(chamadas).toEqual(["proprio"]);
    expect(respondeu(r)).toBe(false);
    expect(r.trilha).toEqual([
      { nivel: "proprio", status: "vazio", ms: expect.any(Number) },
      { nivel: "externa", status: "pulado_por_flag", ms: 0 },
    ]);
  });

  it("a flag nasce desligada: qualquer valor que não seja 'true' pula", async () => {
    for (const valor of ["", "false", "1", "sim", "TRUE"]) {
      vi.stubEnv("AI_EXTERNAL_LOOKUP_ENABLED", valor);
      const chamadas: string[] = [];
      await resolverNaOrdem<string>([
        espiao("externa", chamadas, { valor: "x", fonte: fonteExterna }),
      ]);
      expect(chamadas, `valor "${valor}" não deveria habilitar`).toEqual([]);
    }
  });

  it("roda quando a flag está ligada e nada interno respondeu", async () => {
    vi.stubEnv("AI_EXTERNAL_LOOKUP_ENABLED", "true");
    const chamadas: string[] = [];

    const r = await resolverNaOrdem<string>([
      espiao("proprio", chamadas, null),
      espiao("plataforma", chamadas, null),
      espiao("externa", chamadas, { valor: "do ML", fonte: fonteExterna }),
    ]);

    expect(chamadas).toEqual(["proprio", "plataforma", "externa"]);
    expect(r.valor).toBe("do ML");
    expect(r.fonte).toEqual(fonteExterna);
  });
});

describe("falha de fonte não derruba a cadeia", () => {
  it("degrau que lança vira `falhou` e o seguinte é tentado", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const chamadas: string[] = [];

    const r = await resolverNaOrdem<string>([
      {
        nivel: "proprio",
        buscar: async () => {
          chamadas.push("proprio");
          throw new Error("banco fora");
        },
      },
      espiao("plataforma", chamadas, {
        valor: "da base",
        fonte: fontePlataforma,
      }),
    ]);

    expect(r.valor).toBe("da base");
    expect(chamadas).toEqual(["proprio", "plataforma"]);
    expect(r.trilha[0]).toEqual({
      nivel: "proprio",
      status: "falhou",
      ms: expect.any(Number),
    });
  });

  it("o erro cru fica no log do servidor, não no resultado", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const r = await resolverNaOrdem<string>([
      {
        nivel: "proprio",
        buscar: async () => {
          throw new Error("TOKEN=segredo123 expirado");
        },
      },
    ]);

    // O resultado da cadeia vira contexto do modelo e sai para o provedor.
    expect(JSON.stringify(r)).not.toContain("segredo123");
    expect(respondeu(r)).toBe(false);
    // Mas o operador do Dexo consegue investigar.
    expect(log).toHaveBeenCalled();
  });
});

describe("⭐ erros de PROGRAMAÇÃO falham alto", () => {
  it("cadeia fora da ordem canônica lança", async () => {
    await expect(
      resolverNaOrdem<string>([
        { nivel: "externa", buscar: async () => null },
        { nivel: "proprio", buscar: async () => null },
      ]),
    ).rejects.toThrow(/fora de ordem/);
  });

  it("a validação da ordem acontece ANTES de executar qualquer coisa", async () => {
    const chamadas: string[] = [];
    await expect(
      resolverNaOrdem<string>([
        espiao("regra", chamadas, { valor: "x", fonte: fonteRegra }),
        espiao("proprio", chamadas, null),
      ]),
    ).rejects.toThrow();
    expect(chamadas).toEqual([]);
  });

  it("nível desconhecido lança", async () => {
    await expect(
      resolverNaOrdem<string>([
        { nivel: "chute" as any, buscar: async () => null },
      ]),
    ).rejects.toThrow(/nível de fonte desconhecido/);
  });

  it("⭐ um degrau NÃO pode reportar procedência mais FORTE que a dele", async () => {
    // Seria a mentira mais perigosa do card: dizer "veio do seu catálogo"
    // quando a resposta veio do catálogo público do Mercado Livre.
    vi.stubEnv("AI_EXTERNAL_LOOKUP_ENABLED", "true");
    await expect(
      resolverNaOrdem<string>([
        {
          nivel: "externa",
          buscar: async () => ({ valor: "x", fonte: fonteProprio }),
        },
      ]),
    ).rejects.toThrow(/mais forte/);
  });

  it("reportar procedência mais FRACA é permitido", async () => {
    // É o caso real do motor de categorias: um degrau `plataforma` que se
    // declara `regra` porque o mapa curado é que venceu.
    const r = await resolverNaOrdem<string>([
      {
        nivel: "plataforma",
        buscar: async () => ({ valor: "x", fonte: fonteRegra }),
      },
    ]);
    expect(r.fonte).toEqual(fonteRegra);
    expect(r.nivel).toBe("plataforma");
  });

  it("procedência com kind inexistente lança", async () => {
    await expect(
      resolverNaOrdem<string>([
        {
          nivel: "proprio",
          buscar: async () => ({
            valor: "x",
            fonte: { kind: "adivinhei" } as any,
          }),
        },
      ]),
    ).rejects.toThrow(/kind desconhecido/);
  });
});

describe("a ordem canônica", () => {
  it("é do mais específico para o mais genérico", () => {
    expect([...ORDEM_DAS_FONTES]).toEqual([
      "proprio",
      "plataforma",
      "conhecimento",
      "regra",
      "externa",
      "estimativa",
    ]);
  });

  it("cobre exatamente os tipos de fonte que a UI sabe desenhar", () => {
    // Se alguém acrescentar um `kind` em AiSource sem pôr na ordem, a cadeia
    // lança em runtime. Este teste faz a falta aparecer no lugar certo.
    const kinds: Array<AiSource["kind"]> = [
      "proprio",
      "plataforma",
      "conhecimento",
      "regra",
      "externa",
      "estimativa",
    ];
    expect(new Set(ORDEM_DAS_FONTES)).toEqual(new Set(kinds));
  });
});
