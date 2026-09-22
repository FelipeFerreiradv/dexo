import { describe, it, expect, afterEach, vi } from "vitest";

import {
  FocusNfeV2Client,
  parseRetryAfterMs,
  normalizarChaveFocus,
  FOCUS_V2_POST_TIMEOUT_MS_PADRAO,
  FOCUS_V2_GET_TIMEOUT_MS_PADRAO,
} from "../../../app/fiscal/providers/focus-nfe-v2.client";
import { normalizarCStat } from "../../../app/fiscal/numeracao/cstat";
import type { FocusV2Resposta } from "../../../app/fiscal/numeracao/tipos";

// Numeração V2 — cliente Focus: bruto fiel, nunca lança, token nunca vaza.
// Um caso por código da tabela §4.3 do plano (POST e GET) + inutilização.

const TOKEN = "tok_SEGREDO_focus_9f8e7d6c5b4a";
const TOKEN_B64 = Buffer.from(`${TOKEN}:`).toString("base64");
const CHAVE = "41260911386276000176550030000001011234567892";

type Chamada = { url: string; init: RequestInit };

function fakeFetch(
  responder: (url: string, init: RequestInit) => Response | Promise<Response>,
) {
  const chamadas: Chamada[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    chamadas.push({ url, init: init ?? {} });
    return responder(url, init ?? {});
  }) as typeof fetch;
  return { impl, chamadas };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function html(status: number, texto = "<html><body>HTTP Basic: Access denied.</body></html>"): Response {
  return new Response(texto, { status, headers: { "content-type": "text/html" } });
}

function cliente(
  responder: (url: string, init: RequestInit) => Response | Promise<Response>,
  opts: { ambiente?: "HOMOLOGACAO" | "PRODUCAO"; modelo?: "55" | "65"; postTimeoutMs?: number; getTimeoutMs?: number } = {},
) {
  const f = fakeFetch(responder);
  const c = new FocusNfeV2Client(opts.ambiente ?? "HOMOLOGACAO", opts.modelo ?? "55", {
    fetchImpl: f.impl,
    postTimeoutMs: opts.postTimeoutMs,
    getTimeoutMs: opts.getTimeoutMs,
  });
  return { c, chamadas: f.chamadas };
}

/** Todo resultado passa por aqui: o token (nem em base64) nunca aparece. */
function semToken<T>(r: T): T {
  const s = JSON.stringify(r);
  expect(s).not.toContain(TOKEN);
  expect(s).not.toContain(TOKEN_B64);
  expect(s.toLowerCase()).not.toContain("authorization");
  return r;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ─────────────────────────────── requisição ───────────────────────────────

describe("FocusNfeV2Client — requisição", () => {
  it("POST homologação /v2/nfe?ref= com Basic auth, JSON e AbortSignal", async () => {
    const { c, chamadas } = cliente(() => json(202, { status: "processando_autorizacao" }));
    const payload = { natureza_operacao: "VENDA", numero: "101", serie: "3" };
    await c.emitir(payload, "cmu4 gzo2/q0?&x", TOKEN);

    expect(chamadas).toHaveLength(1);
    const [{ url, init }] = chamadas;
    expect(url).toBe(
      `https://homologacao.focusnfe.com.br/v2/nfe?ref=${encodeURIComponent("cmu4 gzo2/q0?&x")}`,
    );
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${TOKEN_B64}`);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual(payload);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("PRODUÇÃO + modelo 65 ⇒ api.focusnfe.com.br/v2/nfce", async () => {
    const { c, chamadas } = cliente(() => json(202, {}), { ambiente: "PRODUCAO", modelo: "65" });
    await c.emitir({}, "ref-1", TOKEN);
    await c.consultar("ref-1", TOKEN);
    expect(chamadas[0].url).toBe("https://api.focusnfe.com.br/v2/nfce?ref=ref-1");
    expect(chamadas[1].url).toBe("https://api.focusnfe.com.br/v2/nfce/ref-1?completa=1");
  });

  it("GET /v2/nfe/{ref}?completa=1 sem corpo e sem Content-Type", async () => {
    const { c, chamadas } = cliente(() => json(200, { status: "autorizado" }));
    await c.consultar("nfe/1", TOKEN);
    const [{ url, init }] = chamadas;
    expect(url).toBe("https://homologacao.focusnfe.com.br/v2/nfe/nfe%2F1?completa=1");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${TOKEN_B64}`);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("timeouts padrão (POST 45 s, GET 15 s)", () => {
    expect(FOCUS_V2_POST_TIMEOUT_MS_PADRAO).toBe(45_000);
    expect(FOCUS_V2_GET_TIMEOUT_MS_PADRAO).toBe(15_000);
  });

  it("sem fetchImpl usa o fetch global resolvido na CHAMADA", async () => {
    const c = new FocusNfeV2Client("HOMOLOGACAO", "55");
    const global = vi.fn(async () => json(200, { status: "autorizado" }));
    vi.stubGlobal("fetch", global);
    const r = await c.consultar("ref-g", TOKEN);
    expect(global).toHaveBeenCalledTimes(1);
    expect(r.corpo?.status).toBe("autorizado");
  });
});

// ─────────────────────────────── POST (§4.3) ───────────────────────────────

describe("FocusNfeV2Client.emitir — códigos do POST", () => {
  async function post(res: () => Response | Promise<Response>): Promise<FocusV2Resposta> {
    const { c } = cliente(res);
    return semToken(await c.emitir({ a: 1 }, "ref-1", TOKEN));
  }

  it("201 autorizado: numero/serie/protocolo e chave sem prefixo NFe; extras descartados", async () => {
    const r = await post(() =>
      json(201, {
        cnpj_emitente: "11386276000176",
        ref: "ref-1",
        status: "autorizado",
        status_sefaz: "100",
        mensagem_sefaz: "Autorizado o uso da NF-e",
        chave_nfe: `NFe${CHAVE}`,
        numero: "101",
        serie: "3",
        protocolo: "141260000123456",
        caminho_xml_nota_fiscal: "/arquivos/x.xml",
        caminho_danfe: "/arquivos/x.pdf",
        token: TOKEN,
      }),
    );
    expect(r.httpStatus).toBe(201);
    expect(r.transporte).toBeNull();
    expect(r.retryAfterMs).toBeNull();
    expect(r.corpo).toEqual({
      status: "autorizado",
      status_sefaz: "100",
      mensagem_sefaz: "Autorizado o uso da NF-e",
      chave_nfe: CHAVE,
      numero: "101",
      serie: "3",
      protocolo: "141260000123456",
      caminho_xml_nota_fiscal: "/arquivos/x.xml",
    });
  });

  it("200 autorizado com numero/serie numéricos preservados", async () => {
    const r = await post(() => json(200, { status: "autorizado", numero: 12, serie: 3, chave_nfe: CHAVE }));
    expect(r.httpStatus).toBe(200);
    expect(r.corpo).toMatchObject({ status: "autorizado", numero: 12, serie: 3, chave_nfe: CHAVE });
  });

  it("202 processando_autorizacao", async () => {
    const r = await post(() => json(202, { status: "processando_autorizacao" }));
    expect(r.httpStatus).toBe(202);
    expect(r.corpo).toEqual({ status: "processando_autorizacao" });
  });

  it("200 erro_autorizacao com status_sefaz '974' (string mantida; normaliza para 974)", async () => {
    const r = await post(() =>
      json(200, {
        status: "erro_autorizacao",
        status_sefaz: "974",
        mensagem_sefaz: "Rejeicao: CNPJ do responsavel tecnico nao autorizado",
      }),
    );
    expect(r.corpo?.status).toBe("erro_autorizacao");
    expect(r.corpo?.status_sefaz).toBe("974");
    expect(normalizarCStat(r.corpo?.status_sefaz)).toBe(974);
    expect(r.corpo?.mensagem_sefaz).toMatch(/responsavel tecnico/);
  });

  it("200 denegado", async () => {
    const r = await post(() => json(200, { status: "denegado", status_sefaz: "302", mensagem_sefaz: "Uso Denegado" }));
    expect(r.corpo).toMatchObject({ status: "denegado", status_sefaz: "302" });
  });

  it.each([
    [400, "requisicao_invalida"],
    [400, "empresa_nao_habilitada"],
    [403, "permissao_negada"],
    [404, "nao_encontrado"],
    [415, "formato_invalido"],
    [422, "permissao_negada"],
    [422, "pending_operation"],
    [422, "em_processamento"],
    [422, "already_processed"],
    [422, "nfe_autorizada"],
  ])("%i %s ⇒ httpStatus e codigo/mensagem crus", async (status, codigo) => {
    const r = await post(() => json(status, { codigo, mensagem: `mensagem ${codigo}` }));
    expect(r.httpStatus).toBe(status);
    expect(r.transporte).toBeNull();
    expect(r.corpo).toEqual({ codigo, mensagem: `mensagem ${codigo}` });
  });

  it("422 erro_validacao_schema com erros[] (só campos conhecidos)", async () => {
    const r = await post(() =>
      json(422, {
        codigo: "erro_validacao_schema",
        mensagem: "Erro de validação do schema",
        erros: [
          { codigo: "campo_invalido", mensagem: "items[0].cfop inválido", campo: "items[0].cfop", extra: 1 },
          "lixo",
          null,
        ],
      }),
    );
    expect(r.httpStatus).toBe(422);
    expect(r.corpo).toEqual({
      codigo: "erro_validacao_schema",
      mensagem: "Erro de validação do schema",
      erros: [{ codigo: "campo_invalido", mensagem: "items[0].cfop inválido", campo: "items[0].cfop" }],
    });
  });

  it("401 com corpo HTML: não lança, corpo null", async () => {
    const r = await post(() => html(401));
    expect(r.httpStatus).toBe(401);
    expect(r.transporte).toBeNull();
    expect(r.corpo).toBeNull();
  });

  it("429 com Retry-After em segundos ⇒ retryAfterMs", async () => {
    const r = await post(() => json(429, { codigo: "limite_excedido" }, { "Retry-After": "30" }));
    expect(r.httpStatus).toBe(429);
    expect(r.retryAfterMs).toBe(30_000);
    expect(r.corpo?.codigo).toBe("limite_excedido");
  });

  it("429 com Retry-After em data HTTP ⇒ ms até a data", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("Wed, 16 Sep 2026 12:00:00 GMT"));
    const r = await post(
      () =>
        new Response("Too Many Requests", {
          status: 429,
          headers: { "Retry-After": "Wed, 16 Sep 2026 12:01:30 GMT" },
        }),
    );
    expect(r.retryAfterMs).toBe(90_000);
    expect(r.corpo).toBeNull();
  });

  it("500 com JSON e 502 com HTML ⇒ httpStatus, transporte null", async () => {
    const r500 = await post(() => json(500, { codigo: "erro_interno", mensagem: "Erro interno" }));
    expect([r500.httpStatus, r500.transporte, r500.corpo?.codigo]).toEqual([500, null, "erro_interno"]);
    const r502 = await post(() => html(502, "<html>Bad Gateway</html>"));
    expect([r502.httpStatus, r502.transporte, r502.corpo]).toEqual([502, null, null]);
  });

  it("2xx com corpo vazio, lista ou texto ⇒ corpo null", async () => {
    expect((await post(() => new Response("", { status: 200 }))).corpo).toBeNull();
    expect((await post(() => json(200, [1, 2]))).corpo).toBeNull();
    expect((await post(() => new Response("null", { status: 200 }))).corpo).toBeNull();
    expect((await post(() => new Response("ok", { status: 201 }))).corpo).toBeNull();
  });

  it("falha de rede (fetch failed / ECONNREFUSED) ⇒ REDE, não lança", async () => {
    const r = await post(() => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    });
    expect(r).toEqual({ httpStatus: null, transporte: "REDE", corpo: null, retryAfterMs: null });
  });

  it("fetchImpl que lança SÍNCRONO ⇒ REDE, não lança", async () => {
    const c = new FocusNfeV2Client("HOMOLOGACAO", "55", {
      fetchImpl: (() => {
        throw new Error(`boom ${TOKEN}`);
      }) as unknown as typeof fetch,
    });
    const r = semToken(await c.emitir({}, "r", TOKEN));
    expect(r.transporte).toBe("REDE");
  });

  it("abort por timeout do POST ⇒ TIMEOUT (AbortSignal.timeout)", async () => {
    const { c } = cliente(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
      { postTimeoutMs: 25 },
    );
    const inicio = Date.now();
    const r = semToken(await c.emitir({}, "r", TOKEN));
    expect(r).toEqual({ httpStatus: null, transporte: "TIMEOUT", corpo: null, retryAfterMs: null });
    expect(Date.now() - inicio).toBeLessThan(5_000);
  });

  it("AbortError genérico e undici headers timeout ⇒ TIMEOUT", async () => {
    const r1 = await post(() => {
      throw new DOMException("The operation was aborted", "AbortError");
    });
    expect(r1.transporte).toBe("TIMEOUT");
    const r2 = await post(() => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } });
    });
    expect(r2.transporte).toBe("TIMEOUT");
  });

  it("cabeçalho chegou mas o corpo abortou ⇒ TIMEOUT com httpStatus", async () => {
    const r = await post(
      () =>
        ({
          status: 201,
          headers: new Headers(),
          text: () => Promise.reject(new DOMException("aborted", "TimeoutError")),
        }) as unknown as Response,
    );
    expect(r).toEqual({ httpStatus: 201, transporte: "TIMEOUT", corpo: null, retryAfterMs: null });
  });

  it("mensagem que ecoa o token é mascarada", async () => {
    const r = await post(() =>
      json(422, { codigo: "permissao_negada", mensagem: `token ${TOKEN} sem permissao`, erros: [{ mensagem: TOKEN }] }),
    );
    expect(r.corpo?.mensagem).toBe("token [REDACTED] sem permissao");
    expect(r.corpo?.erros?.[0].mensagem).toBe("[REDACTED]");
  });

  it("chave_nfe inválida ⇒ null; null explícito ⇒ null", async () => {
    expect((await post(() => json(200, { status: "autorizado", chave_nfe: "NFe123" }))).corpo?.chave_nfe).toBeNull();
    expect((await post(() => json(200, { status: "autorizado", chave_nfe: null }))).corpo?.chave_nfe).toBeNull();
    expect((await post(() => json(200, { status: "autorizado", chave_nfe: 123 }))).corpo?.chave_nfe).toBeNull();
  });
});

// ─────────────────────────────── GET (§4.3) ───────────────────────────────

describe("FocusNfeV2Client.consultar — códigos do GET", () => {
  async function get(res: () => Response | Promise<Response>, getTimeoutMs?: number) {
    const { c } = cliente(res, { getTimeoutMs });
    return semToken(await c.consultar("ref-1", TOKEN));
  }

  it("200 autorizado com chave/numero/serie/protocolo", async () => {
    const r = await get(() =>
      json(200, { status: "autorizado", status_sefaz: "100", chave_nfe: `NFe${CHAVE}`, numero: "5", serie: "3", protocolo: "1412600", data_evento: "2026-09-16T10:00:00-03:00" }),
    );
    expect(r.httpStatus).toBe(200);
    expect(r.corpo).toMatchObject({ status: "autorizado", chave_nfe: CHAVE, numero: "5", serie: "3", data_evento: "2026-09-16T10:00:00-03:00" });
  });

  it("200 cancelado", async () => {
    const r = await get(() => json(200, { status: "cancelado", status_sefaz: "135", protocolo_sefaz: "141260000999" }));
    expect(r.corpo).toMatchObject({ status: "cancelado", protocolo_sefaz: "141260000999" });
  });

  it("200 erro_autorizacao com 539 e a chave no mensagem_sefaz", async () => {
    const msg = `Rejeicao: Duplicidade de NF-e, com diferenca na Chave de Acesso [chNFe:${CHAVE}]`;
    const r = await get(() => json(200, { status: "erro_autorizacao", status_sefaz: "539", mensagem_sefaz: msg }));
    expect(r.corpo).toMatchObject({ status: "erro_autorizacao", status_sefaz: "539", mensagem_sefaz: msg });
  });

  it("404 nao_encontrado ⇒ httpStatus 404 e codigo cru", async () => {
    const r = await get(() => json(404, { codigo: "nao_encontrado", mensagem: "Nota fiscal não encontrada" }));
    expect(r.httpStatus).toBe(404);
    expect(r.corpo?.codigo).toBe("nao_encontrado");
  });

  it.each([401, 403, 429, 500, 503])("%i com HTML ⇒ httpStatus, corpo null (nunca vira 'não encontrado')", async (status) => {
    const r = await get(() => html(status));
    expect(r.httpStatus).toBe(status);
    expect(r.corpo).toBeNull();
    expect(r.transporte).toBeNull();
  });

  it("timeout do GET (getTimeoutMs) ⇒ TIMEOUT", async () => {
    const { c } = cliente(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
      { getTimeoutMs: 20, postTimeoutMs: 60_000 },
    );
    const r = semToken(await c.consultar("ref-1", TOKEN));
    expect(r).toEqual({ httpStatus: null, transporte: "TIMEOUT", corpo: null, retryAfterMs: null });
  });
});

// ─────────────────────────────── inutilização ───────────────────────────────

describe("FocusNfeV2Client.inutilizar", () => {
  const INPUT = {
    cnpj: "11386276000176",
    serie: 3,
    numeroInicial: 8,
    numeroFinal: 10,
    justificativa: "Numeracao pulada por falha de integracao",
  };

  it("POST /v2/nfe/inutilizacao com números em string", async () => {
    const { c, chamadas } = cliente(() => json(200, { status: "autorizado", status_sefaz: "102", protocolo_sefaz: "141260000555" }));
    await c.inutilizar(INPUT, TOKEN);
    expect(chamadas[0].url).toBe("https://homologacao.focusnfe.com.br/v2/nfe/inutilizacao");
    expect(chamadas[0].init.method).toBe("POST");
    expect(JSON.parse(String(chamadas[0].init.body))).toEqual({
      cnpj: "11386276000176",
      serie: "3",
      numero_inicial: "8",
      numero_final: "10",
      justificativa: "Numeracao pulada por falha de integracao",
    });
  });

  it("modelo 65 ⇒ /v2/nfce/inutilizacao", async () => {
    const { c, chamadas } = cliente(() => json(200, {}), { modelo: "65" });
    await c.inutilizar(INPUT, TOKEN);
    expect(chamadas[0].url).toBe("https://homologacao.focusnfe.com.br/v2/nfce/inutilizacao");
  });

  it("200 autorizado + 102 ⇒ sucesso, protocolo = protocolo_sefaz", async () => {
    const { c } = cliente(() =>
      json(200, { status: "autorizado", status_sefaz: "102", mensagem_sefaz: "Inutilizacao de numero homologado", protocolo_sefaz: "141260000555", protocolo: "outro" }),
    );
    const r = semToken(await c.inutilizar(INPUT, TOKEN));
    expect(r.sucesso).toBe(true);
    expect(r.protocolo).toBe("141260000555");
    expect(r.httpStatus).toBe(200);
  });

  it("sem protocolo_sefaz ⇒ protocolo cai para `protocolo`", async () => {
    const { c } = cliente(() => json(200, { status: "autorizado", status_sefaz: 102, protocolo: "141260000777" }));
    const r = await c.inutilizar(INPUT, TOKEN);
    expect(r.sucesso).toBe(true);
    expect(r.protocolo).toBe("141260000777");
  });

  it("HTTP 200 com erro_autorizacao é FALHA (o V1 contaria como sucesso)", async () => {
    const { c } = cliente(() => json(200, { status: "erro_autorizacao", status_sefaz: "241", mensagem_sefaz: "Rejeicao: Um numero da faixa ja foi utilizado" }));
    const r = semToken(await c.inutilizar(INPUT, TOKEN));
    expect(r.sucesso).toBe(false);
    expect(r.protocolo).toBeNull();
    expect(r.corpo?.status_sefaz).toBe("241");
  });

  it("autorizado com cStat ≠ 102, ou 102 sem autorizado ⇒ FALHA", async () => {
    const a = await cliente(() => json(200, { status: "autorizado", status_sefaz: "563" })).c.inutilizar(INPUT, TOKEN);
    expect(a.sucesso).toBe(false);
    const b = await cliente(() => json(200, { status: "processando", status_sefaz: "102" })).c.inutilizar(INPUT, TOKEN);
    expect(b.sucesso).toBe(false);
    const d = await cliente(() => json(200, { status: "autorizado" })).c.inutilizar(INPUT, TOKEN);
    expect(d.sucesso).toBe(false);
  });

  it("401 HTML, rede e timeout ⇒ FALHA sem lançar", async () => {
    const h = semToken(await cliente(() => html(401)).c.inutilizar(INPUT, TOKEN));
    expect([h.sucesso, h.protocolo, h.httpStatus]).toEqual([false, null, 401]);
    const rede = semToken(
      await cliente(() => {
        throw new TypeError("fetch failed");
      }).c.inutilizar(INPUT, TOKEN),
    );
    expect([rede.sucesso, rede.transporte]).toEqual([false, "REDE"]);
    const lento = semToken(
      await cliente(
        (_u, init) =>
          new Promise<Response>((_r, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason))),
        { postTimeoutMs: 20 },
      ).c.inutilizar(INPUT, TOKEN),
    );
    expect([lento.sucesso, lento.transporte]).toEqual([false, "TIMEOUT"]);
  });
});

// ─────────────────────────────── helpers puros ───────────────────────────────

describe("parseRetryAfterMs / normalizarChaveFocus", () => {
  it("Retry-After: segundos, data HTTP, passado, inválido", () => {
    const agora = Date.parse("Wed, 16 Sep 2026 12:00:00 GMT");
    expect(parseRetryAfterMs("30", agora)).toBe(30_000);
    expect(parseRetryAfterMs(" 5 ", agora)).toBe(5_000);
    expect(parseRetryAfterMs("0", agora)).toBe(0);
    expect(parseRetryAfterMs("Wed, 16 Sep 2026 12:00:10 GMT", agora)).toBe(10_000);
    expect(parseRetryAfterMs("Wed, 16 Sep 2026 11:00:00 GMT", agora)).toBe(0);
    expect(parseRetryAfterMs("amanhã", agora)).toBeNull();
    expect(parseRetryAfterMs("-5", agora)).toBeNull();
    expect(parseRetryAfterMs("", agora)).toBeNull();
    expect(parseRetryAfterMs(null, agora)).toBeNull();
    expect(parseRetryAfterMs(undefined, agora)).toBeNull();
  });

  it("chave: remove 'NFe', aceita 44 dígitos, recusa o resto", () => {
    expect(normalizarChaveFocus(`NFe${CHAVE}`)).toBe(CHAVE);
    expect(normalizarChaveFocus(` nfe${CHAVE} `)).toBe(CHAVE);
    expect(normalizarChaveFocus(CHAVE)).toBe(CHAVE);
    expect(normalizarChaveFocus(`NFe${CHAVE}1`)).toBeNull();
    expect(normalizarChaveFocus("NFe")).toBeNull();
    expect(normalizarChaveFocus(null)).toBeNull();
    expect(normalizarChaveFocus(Number(CHAVE))).toBeNull();
  });
});
