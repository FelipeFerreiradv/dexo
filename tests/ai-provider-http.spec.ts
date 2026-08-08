import { afterEach, describe, expect, it, vi } from "vitest";

import {
  iterarSse,
  logarFalhaDoProvedor,
  redigirSegredos,
} from "../app/ai/core/provider-http";

// ===========================================================================
// As pecas de HTTP compartilhadas pelos provedores REST do Bitz.
//
// Este arquivo nasceu de dois achados de auditoria sobre codigo que ja rodava:
//
//   1. O log do servidor recebia ate 400 caracteres de texto 100% controlado
//      pelo provedor. Se o endpoint ecoar a credencial — e `AI_*_BASE_URL` e
//      apontavel para qualquer servidor compativel com o formato da OpenAI,
//      varios dos quais respondem `Invalid API key: sk-...` sem mascarar — a
//      chave ia inteira para o stdout do pm2, que fica retido em arquivo.
//      Nenhum teste olhava o console: o `ai-secret-leak.spec.ts` cobre erro,
//      corpo, SystemLog e bundle, e o console e um QUINTO canal.
//
//   2. O leitor SSE decodificava cada pacote isolado. Um caractere acentuado
//      partido entre dois pacotes TCP virava "�" no texto transmitido E no
//      que e gravado. Nao aparecia em teste porque nos specs os pedacos sao
//      `string`, e string nao passa por decodificacao — so aparece em
//      producao, e so em texto em portugues, ou seja em toda resposta.
// ===========================================================================

afterEach(() => {
  vi.restoreAllMocks();
});

describe("redigirSegredos", () => {
  it.each([
    ["sk-abc123DEF456ghi", "chave no formato OpenAI/DeepSeek"],
    ["AIzaSyD-1234567890abcdefg", "chave no formato Google"],
  ])("redige %s (%s)", (chave) => {
    const saida = redigirSegredos(`Invalid API key: ${chave} — tente de novo`);
    expect(saida).not.toContain(chave);
    expect(saida).toContain("[REDIGIDO]");
  });

  it("redige um header Authorization ecoado de volta", () => {
    const saida = redigirSegredos("recebido: Bearer xyz987segredo");
    expect(saida).not.toContain("xyz987segredo");
  });

  it("nao estraga texto legitimo", () => {
    // A mensagem de erro util tem que continuar util — redigir demais
    // devolveria o problema que a funcao de log existe para resolver.
    const texto = "model not found: verifique o nome do modelo configurado";
    expect(redigirSegredos(texto)).toBe(texto);
  });
});

describe("⭐ logarFalhaDoProvedor nao deixa a chave chegar ao console", () => {
  it("chave ecoada pelo provedor sai redigida", () => {
    const espiao = vi.spyOn(console, "error").mockImplementation(() => {});

    logarFalhaDoProvedor("deepseek", "chat/completions", {
      response: {
        status: 401,
        data: { error: { message: "Invalid API key: sk-abc123DEF456ghi" } },
      },
    });

    expect(espiao).toHaveBeenCalledTimes(1);
    const linha = String(espiao.mock.calls[0][0]);
    expect(linha).not.toContain("sk-abc123DEF456ghi");
    expect(linha).toContain("[REDIGIDO]");
    // E o diagnostico continua servindo para alguma coisa.
    expect(linha).toContain("HTTP 401");
    expect(linha).toContain("[bitz-deepseek]");
  });

  it("corpo cru sem `error.message` tambem passa pela redacao", () => {
    const espiao = vi.spyOn(console, "error").mockImplementation(() => {});

    logarFalhaDoProvedor("gemini", "generateContent", {
      response: { status: 400, data: { message: "bad key AIzaSyD-1234567890abcdefg" } },
    });

    expect(String(espiao.mock.calls[0][0])).not.toContain(
      "AIzaSyD-1234567890abcdefg",
    );
  });

  it("o texto e limitado — corpo gigante nao inunda o log", () => {
    const espiao = vi.spyOn(console, "error").mockImplementation(() => {});
    logarFalhaDoProvedor("deepseek", "x", {
      response: { status: 500, data: { error: { message: "a".repeat(5000) } } },
    });
    expect(String(espiao.mock.calls[0][0]).length).toBeLessThan(600);
  });
});

describe("⭐ iterarSse com bytes de verdade", () => {
  /** Fatia um texto em N pedacos de BYTES — como a rede entrega. */
  function emBytes(texto: string, corte: number) {
    const buf = Buffer.from(texto, "utf8");
    return (async function* () {
      for (let i = 0; i < buf.length; i += corte) {
        yield buf.subarray(i, i + corte);
      }
    })();
  }

  it("acento partido entre dois pacotes NAO vira caractere invalido", async () => {
    // "peças", "não", "orçamento" — o vocabulario do dia a dia do lojista.
    const payload = 'data: {"t":"peças, não, orçamento, você"}\n\n';
    const saida: any[] = [];

    // Corte de 1 byte garante que TODO caractere multibyte seja partido.
    for await (const e of iterarSse(emBytes(payload, 1))) saida.push(e);

    expect(saida).toEqual([{ t: "peças, não, orçamento, você" }]);
    expect(JSON.stringify(saida)).not.toContain("�");
  });

  it("mesmo texto, cortes diferentes, mesmo resultado", async () => {
    const payload = 'data: {"t":"cubo de roda dianteiro — R$ 1.234,00 à vista"}\n\n';

    for (const corte of [1, 2, 3, 5, 7, 13, 64]) {
      const saida: any[] = [];
      for await (const e of iterarSse(emBytes(payload, corte))) saida.push(e);
      expect(saida, `corte=${corte}`).toEqual([
        { t: "cubo de roda dianteiro — R$ 1.234,00 à vista" },
      ]);
    }
  });

  it("chunks em string continuam funcionando como antes", async () => {
    // O caminho que os outros specs exercitam nao pode ter mudado.
    async function* pedacos(...p: string[]) {
      for (const x of p) yield x;
    }
    const saida: any[] = [];
    for await (const e of iterarSse(pedacos('data: {"a', '":1}\n\n'))) {
      saida.push(e);
    }
    expect(saida).toEqual([{ a: 1 }]);
  });

  it("multiplos eventos em bytes, incluindo o [DONE]", async () => {
    const payload =
      'data: {"n":1}\n\ndata: {"n":2}\n\ndata: {"n":"três"}\n\ndata: [DONE]\n\n';
    const saida: any[] = [];
    for await (const e of iterarSse(emBytes(payload, 3))) saida.push(e);
    expect(saida).toEqual([{ n: 1 }, { n: 2 }, { n: "três" }]);
  });
});
