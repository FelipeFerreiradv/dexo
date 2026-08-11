import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const postMock = vi.fn();
vi.mock("axios", () => ({
  default: { post: (...args: any[]) => postMock(...args) },
}));

import {
  DeepSeekProvider,
  toDeepSeekMessages,
  toDeepSeekTools,
} from "../app/ai/core/deepseek.provider";
import type { AiMessage } from "../app/ai/core/types";

// ===========================================================================
// Provedor DeepSeek — API no formato da OpenAI.
//
// O invariante que atravessa o arquivo é o mesmo dos outros provedores:
// `chat`/`chatStream` NUNCA lançam. Fora do ar, timeout, 4xx/5xx, resposta
// malformada — tudo vira `{ ok:false, reason }`, e o ERP não sente nada.
//
// Os dois pontos que este spec vigia com mais cuidado, porque são os que
// diferenciam este dialeto do Gemini e é onde um erro seria silencioso:
//
//   1. `tool_call_id` — o Gemini casa pedido e resposta pelo NOME; a OpenAI
//      casa pelo ID e recusa (400) um `role:"tool"` sem ele.
//   2. Montagem de tool_call no STREAMING — id e nome vêm no primeiro
//      fragmento, os argumentos vêm fatiados, e só o `index` amarra os
//      pedaços. Concatenar por ordem de chegada embaralha os argumentos de
//      duas tools pedidas no mesmo turno.
// ===========================================================================

const CHAVE = "sk-chave-secreta-do-cliente";

function provedor(model = "modelo-x") {
  return new DeepSeekProvider({
    apiKey: CHAVE,
    model,
    baseUrl: "https://api.exemplo",
  });
}

/** Stream SSE de mentira: os pedaços chegam como a rede entregaria. */
async function* pedacos(...partes: string[]) {
  for (const p of partes) yield p;
}

beforeEach(() => {
  postMock.mockReset();
  vi.stubEnv("AI_TIMEOUT_MS", "30000");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("configuração ausente — degrada antes de tocar a rede", () => {
  it("sem chave: sem_api_key, e nenhuma requisição sai", async () => {
    const p = new DeepSeekProvider({ model: "m" });
    const r = await p.chat({ messages: [] });
    expect(!r.ok && r.reason).toBe("sem_api_key");
    expect(postMock).not.toHaveBeenCalled();
  });

  it("sem modelo: sem_modelo, e nenhuma requisição sai", async () => {
    const p = new DeepSeekProvider({ apiKey: CHAVE });
    const r = await p.chat({ messages: [] });
    expect(!r.ok && r.reason).toBe("sem_modelo");
    expect(postMock).not.toHaveBeenCalled();
  });
});

describe("a chamada", () => {
  it("⭐ a chave vai no header Authorization, NUNCA na URL", async () => {
    postMock.mockResolvedValue({
      data: { choices: [{ message: { content: "oi" } }] },
    });

    await provedor().chat({ messages: [{ role: "user", content: "oi" }] });

    const [url, , config] = postMock.mock.calls[0];
    // URL em log de proxy, em stack trace e em histórico de shell é lugar por
    // onde chave vaza sem ninguém perceber.
    expect(String(url)).not.toContain(CHAVE);
    expect(String(url)).toBe("https://api.exemplo/chat/completions");
    expect(config.headers.authorization).toBe(`Bearer ${CHAVE}`);
  });

  it("manda modelo, mensagens e tools no formato da OpenAI", async () => {
    postMock.mockResolvedValue({
      data: { choices: [{ message: { content: "ok" } }] },
    });

    await provedor("ds-1").chat({
      messages: [{ role: "user", content: "quanto vendi?" }],
      tools: [
        { name: "relatorio_vendas", description: "vendas", parameters: {} },
      ],
    });

    const corpo = postMock.mock.calls[0][1];
    expect(corpo.model).toBe("ds-1");
    expect(corpo.messages).toEqual([
      { role: "user", content: "quanto vendi?" },
    ]);
    expect(corpo.tools[0]).toEqual({
      type: "function",
      function: {
        name: "relatorio_vendas",
        description: "vendas",
        parameters: {},
      },
    });
    // `chat` não é streaming: mandar `stream:true` aqui devolveria SSE onde o
    // parser espera JSON.
    expect(corpo.stream).toBeUndefined();
  });

  it("resposta simples: conteúdo e uso", async () => {
    postMock.mockResolvedValue({
      data: {
        choices: [{ message: { content: "Você vendeu R$ 10." } }],
        usage: { prompt_tokens: 120, completion_tokens: 8 },
      },
    });

    const r = await provedor().chat({ messages: [] });

    expect(r.ok && r.content).toBe("Você vendeu R$ 10.");
    expect(r.ok && r.usage).toEqual({ inputTokens: 120, outputTokens: 8 });
  });

  it("uso ausente vira null, nunca zero", async () => {
    // "não sei quanto custou" e "custou zero" não são a mesma coisa, e tratar
    // um como o outro é o que produz relatório de custo enganoso.
    postMock.mockResolvedValue({
      data: { choices: [{ message: { content: "x" } }] },
    });
    const r = await provedor().chat({ messages: [] });
    expect(r.ok && r.usage).toEqual({ inputTokens: null, outputTokens: null });
  });

  it("content null com tool_calls: conteúdo vazio e as chamadas", async () => {
    // É o caso NORMAL de um turno que só pede consulta.
    postMock.mockResolvedValue({
      data: {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  index: 0,
                  id: "call_abc",
                  type: "function",
                  function: {
                    name: "buscar_produto",
                    arguments: '{"termo":"farol"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    });

    const r = await provedor().chat({ messages: [] });

    expect(r.ok && r.content).toBe("");
    expect(r.ok && r.toolCalls).toEqual([
      { id: "call_abc", name: "buscar_produto", args: { termo: "farol" } },
    ]);
  });

  it("⭐ argumento que não é JSON válido NÃO vira objeto vazio", async () => {
    // Devolver `{}` seria falhar ABERTO: uma tool cujos argumentos são todos
    // opcionais executaria sem filtro nenhum — consulta ampla disparada por um
    // argumento corrompido. Passando a string crua, o `.strict()` do
    // tool-runner rejeita e nada roda.
    postMock.mockResolvedValue({
      data: {
        choices: [
          {
            message: {
              tool_calls: [
                { function: { name: "buscar_produto", arguments: "{termo:" } },
              ],
            },
          },
        ],
      },
    });

    const r = await provedor().chat({ messages: [] });
    expect(r.ok && r.toolCalls[0].args).toBe("{termo:");
    expect(r.ok && r.toolCalls[0].args).not.toEqual({});
  });

  it("tool_call sem nome é descartada (não vira chamada anônima)", async () => {
    postMock.mockResolvedValue({
      data: {
        choices: [
          // Com texto: sem ele, a guarda de resposta vazia (abaixo) dispararia
          // e este teste passaria a medir outra coisa.
          { message: { content: "segue o texto", tool_calls: [{ function: {} }] } },
        ],
      },
    });
    const r = await provedor().chat({ messages: [] });
    expect(r.ok && r.toolCalls).toEqual([]);
    expect(r.ok && r.content).toBe("segue o texto");
  });

  it("⭐ sem texto E sem tool_call é resposta VAZIA — vira falha, não bolha em branco", async () => {
    // Não é hipotético: nos modelos de raciocínio do DeepSeek o `max_tokens`
    // cobre o raciocínio E a resposta, então uma pergunta difícil pode gastar o
    // teto inteiro pensando e voltar com `content` vazio e
    // `finish_reason:"length"`. Com `ok:true` o orquestrador gravaria uma
    // mensagem em branco e cobraria a cota do cliente. Mesma guarda do Gemini.
    postMock.mockResolvedValue({
      data: {
        choices: [{ message: { content: "" }, finish_reason: "length" }],
        usage: { prompt_tokens: 2000, completion_tokens: 2048 },
      },
    });

    const r = await provedor().chat({ messages: [] });

    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("resposta_invalida");
    expect(!r.ok && r.detail).toBe("resposta vazia");
  });

  it("espaço em branco não conta como resposta", async () => {
    postMock.mockResolvedValue({
      data: { choices: [{ message: { content: "   \n  " } }] },
    });
    expect((await provedor().chat({ messages: [] })).ok).toBe(false);
  });

  it("shape inesperado: resposta_invalida, não crash", async () => {
    postMock.mockResolvedValue({ data: { choices: "isto não é uma lista" } });
    const r = await provedor().chat({ messages: [] });
    expect(!r.ok && r.reason).toBe("resposta_invalida");
  });

  it("sem choices: resposta_invalida", async () => {
    postMock.mockResolvedValue({ data: {} });
    const r = await provedor().chat({ messages: [] });
    expect(!r.ok && r.reason).toBe("resposta_invalida");
  });
});

describe("falhas de rede — nunca lançam, nunca vazam", () => {
  it.each([
    [429, "rate_limit_provedor"],
    [500, "erro_provedor"],
    [400, "erro_provedor"],
  ])("HTTP %i vira %s", async (status, esperado) => {
    postMock.mockRejectedValue({
      response: { status, data: { error: { message: "detalhe do provedor" } } },
    });

    const r = await provedor().chat({ messages: [] });

    expect(!r.ok && r.reason).toBe(esperado);
  });

  it("timeout do axios vira timeout", async () => {
    postMock.mockRejectedValue({ code: "ECONNABORTED" });
    const r = await provedor().chat({ messages: [] });
    expect(!r.ok && r.reason).toBe("timeout");
  });

  it("⭐ o `detail` persistido não carrega chave nem prompt", async () => {
    postMock.mockRejectedValue({
      response: {
        status: 400,
        // O corpo do erro de uma API costuma ECOAR o que foi enviado.
        data: { error: { message: `pedido inválido: ${CHAVE} / "quanto vendi"` } },
      },
    });

    const r = await provedor().chat({
      messages: [{ role: "user", content: "quanto vendi" }],
    });

    expect(!r.ok && r.detail).toBe("HTTP 400");
    expect(JSON.stringify(r)).not.toContain(CHAVE);
    expect(JSON.stringify(r)).not.toContain("quanto vendi");
  });

  it("erro sem response nenhuma (DNS, socket) ainda degrada", async () => {
    postMock.mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));
    const r = await provedor().chat({ messages: [] });
    expect(r.ok).toBe(false);
  });
});

describe("⭐ tradução das mensagens — o tool_call_id", () => {
  it("papéis simples passam direto", () => {
    const msgs: AiMessage[] = [
      { role: "system", content: "persona" },
      { role: "user", content: "oi" },
      { role: "assistant", content: "olá" },
    ];
    expect(toDeepSeekMessages(msgs)).toEqual([
      { role: "system", content: "persona" },
      { role: "user", content: "oi" },
      { role: "assistant", content: "olá" },
    ]);
  });

  it("o id do pedido volta no tool_call_id da resposta", () => {
    const msgs: AiMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "buscar_produto", args: { a: 1 } }],
      },
      {
        role: "tool",
        content: "resultado",
        toolName: "buscar_produto",
        toolCallId: "call_1",
      },
    ];

    const saida = toDeepSeekMessages(msgs);

    expect(saida[0].tool_calls?.[0]).toEqual({
      id: "call_1",
      type: "function",
      function: { name: "buscar_produto", arguments: '{"a":1}' },
    });
    expect(saida[1]).toEqual({
      role: "tool",
      content: "resultado",
      tool_call_id: "call_1",
    });
  });

  it("⭐ sem toolCallId, o id é reconstruído pelo NOME do pedido anterior", () => {
    // Histórico antigo, provedor novo, teste: quem chega sem id não pode
    // simplesmente falhar com 400.
    const msgs: AiMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_9", name: "relatorio_vendas", args: {} }],
      },
      { role: "tool", content: "r", toolName: "relatorio_vendas" },
    ];
    expect(toDeepSeekMessages(msgs)[1].tool_call_id).toBe("call_9");
  });

  it("⭐ duas chamadas da MESMA tool recebem ids diferentes, em ordem", () => {
    // Cada id é consumido uma vez. Sem isso, as duas respostas apontariam para
    // o mesmo pedido e o modelo casaria errado.
    const msgs: AiMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_a", name: "buscar_produto", args: { t: "farol" } },
          { id: "call_b", name: "buscar_produto", args: { t: "cubo" } },
        ],
      },
      { role: "tool", content: "farol", toolName: "buscar_produto" },
      { role: "tool", content: "cubo", toolName: "buscar_produto" },
    ];

    const saida = toDeepSeekMessages(msgs);
    expect(saida[1].tool_call_id).toBe("call_a");
    expect(saida[2].tool_call_id).toBe("call_b");
  });

  it("resposta de tool sem pedido correspondente ainda produz um id", () => {
    // Melhor um id sintético que um 400 que mata o turno inteiro.
    const saida = toDeepSeekMessages([
      { role: "tool", content: "r", toolName: "orfa" },
    ]);
    expect(saida[0].tool_call_id).toBeTruthy();
  });

  it("toDeepSeekTools embrulha no formato {type:function}", () => {
    expect(
      toDeepSeekTools([{ name: "x", description: "d", parameters: { a: 1 } }]),
    ).toEqual([
      { type: "function", function: { name: "x", description: "d", parameters: { a: 1 } } },
    ]);
  });
});

describe("streaming", () => {
  it("pede o uso explicitamente — senão o custo do turno some", async () => {
    postMock.mockResolvedValue({ data: pedacos("data: [DONE]\n\n") });
    await provedor().chatStream({ messages: [] }, () => {});

    const corpo = postMock.mock.calls[0][1];
    expect(corpo.stream).toBe(true);
    expect(corpo.stream_options).toEqual({ include_usage: true });
  });

  it("os deltas remontam exatamente o texto final", async () => {
    postMock.mockResolvedValue({
      data: pedacos(
        'data: {"choices":[{"delta":{"content":"Você "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"vendeu "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"R$ 10."}}]}\n\n',
        'data: {"usage":{"prompt_tokens":9,"completion_tokens":4}}\n\n',
        "data: [DONE]\n\n",
      ),
    });

    const vistos: string[] = [];
    const r = await provedor().chatStream({ messages: [] }, (d) =>
      vistos.push(d),
    );

    expect(vistos.join("")).toBe("Você vendeu R$ 10.");
    expect(r.ok && r.content).toBe("Você vendeu R$ 10.");
    expect(r.ok && r.usage).toEqual({ inputTokens: 9, outputTokens: 4 });
  });

  it("chunk de rede cortado no meio de um JSON não perde o evento", async () => {
    postMock.mockResolvedValue({
      data: pedacos('data: {"choices":[{"delta":{"con', 'tent":"ok"}}]}\n\n'),
    });

    const r = await provedor().chatStream({ messages: [] }, () => {});
    expect(r.ok && r.content).toBe("ok");
  });

  it("⭐ tool_call fatiado é remontado pelo index, não pela ordem de chegada", async () => {
    // O cenário que quebra implementação ingênua: DUAS tools no mesmo turno,
    // com os fragmentos de argumento intercalados. Concatenar por ordem de
    // chegada entrega para uma tool o filtro da outra.
    postMock.mockResolvedValue({
      data: pedacos(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c0","function":{"name":"buscar_produto","arguments":"{\\"termo\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c1","function":{"name":"buscar_sucata","arguments":"{\\"placa\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"\\"ABC1D23\\"}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"farol\\"}"}}]}}]}\n\n',
        "data: [DONE]\n\n",
      ),
    });

    const r = await provedor().chatStream({ messages: [] }, () => {});

    expect(r.ok && r.toolCalls).toEqual([
      { id: "c0", name: "buscar_produto", args: { termo: "farol" } },
      { id: "c1", name: "buscar_sucata", args: { placa: "ABC1D23" } },
    ]);
  });

  it("evento de shape inesperado no meio do stream é ruído, não fim de turno", async () => {
    postMock.mockResolvedValue({
      data: pedacos(
        'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
        "data: {isto não é json}\n\n",
        'data: {"choices":"lixo"}\n\n',
        'data: {"choices":[{"delta":{"content":"b"}}]}\n\n',
        "data: [DONE]\n\n",
      ),
    });

    const r = await provedor().chatStream({ messages: [] }, () => {});
    expect(r.ok && r.content).toBe("ab");
  });

  it("falha ao ABRIR o stream degrada como qualquer outra", async () => {
    postMock.mockRejectedValue({ response: { status: 503 } });
    const r = await provedor().chatStream({ messages: [] }, () => {});
    expect(!r.ok && r.reason).toBe("erro_provedor");
  });

  it("stream que estoura no meio da leitura degrada, não lança", async () => {
    async function* quebrado() {
      yield 'data: {"choices":[{"delta":{"content":"a"}}]}\n\n';
      throw new Error("socket morreu");
    }
    postMock.mockResolvedValue({ data: quebrado() });

    const r = await provedor().chatStream({ messages: [] }, () => {});
    expect(r.ok).toBe(false);
  });

  it("sem chave, o streaming degrada antes da rede", async () => {
    const semChave = new DeepSeekProvider({ model: "m" });
    const r = await semChave.chatStream({ messages: [] }, () => {});
    expect(!r.ok && r.reason).toBe("sem_api_key");
    expect(postMock).not.toHaveBeenCalled();
  });

  it("sem modelo, o streaming degrada antes da rede", async () => {
    // O ramo `sem_modelo` do streaming não era exercido: o teste anterior
    // prometia "sem chave nem modelo" e só cobria a chave, porque a checagem
    // da chave vem primeiro e mascarava a outra.
    const semModelo = new DeepSeekProvider({ apiKey: CHAVE });
    const r = await semModelo.chatStream({ messages: [] }, () => {});
    expect(!r.ok && r.reason).toBe("sem_modelo");
    expect(postMock).not.toHaveBeenCalled();
  });
});

describe("200 com envelope de erro no corpo", () => {
  it("⭐ vira erro_provedor, não o genérico de shape", async () => {
    // Modo de falha real de API — o repositório já levou isso da Shopee. Sem
    // distinguir, a investigação começaria pelo lugar errado.
    postMock.mockResolvedValue({
      data: { error: { message: "insufficient balance" } },
    });

    const r = await provedor().chat({ messages: [] });

    expect(!r.ok && r.reason).toBe("erro_provedor");
    expect(!r.ok && r.detail).toBe("erro no corpo (HTTP 200)");
    // E o texto do provedor NÃO entra no que é persistido.
    expect(JSON.stringify(r)).not.toContain("insufficient balance");
  });
});

describe("o endpoint padrão", () => {
  it("⭐ sem baseUrl injetada, chama api.deepseek.com", async () => {
    // Todos os outros testes injetam `baseUrl`, então a constante que de fato
    // vai para produção nunca era exercida: um typo nela passaria a suíte
    // inteira e só apareceria na primeira chamada real.
    postMock.mockResolvedValue({
      data: { choices: [{ message: { content: "ok" } }] },
    });

    await new DeepSeekProvider({ apiKey: CHAVE, model: "m" }).chat({
      messages: [],
    });

    expect(postMock.mock.calls[0][0]).toBe(
      "https://api.deepseek.com/chat/completions",
    );
  });
});
