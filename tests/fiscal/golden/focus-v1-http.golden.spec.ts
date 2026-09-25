import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FocusNfeProvider } from "../../../app/fiscal/providers/focus-nfe.provider";

// GOLDEN F0 — mapeamento HTTP do FocusNfeProvider V1 em 1549bc4 (o plano dizia
// "focus-nfe.provider.ts V1 não muda"; o cliente V2 é arquivo novo). Trava os
// defeitos conhecidos exatamente como estão, para que a V2 os corrija SEM
// tocar no V1 — com UMA exceção, decidida pelo dono em 25/09/2026 (último item):
//  - 200/201/202 viram "processando" (mesmo autorizado);
//  - 422 repassa `codigo` textual como codigoStatus (R3);
//  - 401 text/html estoura no res.json() e vira "erro" com a mensagem do parser;
//  - consulta 403/404 cai no default "processando" (V7);
//  - até 25/09/2026 o V1 tratava QUALQUER HTTP 200 como sucesso no cancelamento
//    e na inutilização, inclusive "erro_cancelamento" e "erro_autorizacao" (V6);
//    hoje esses dois são FALHA ('200-erro-cancelamento' / '200-erro-autorizacao'),
//    exceto os códigos de "já cancelada" (218/420) e "já inutilizada" (206/563),
//    que são sucesso idempotente (tests/fiscal/focus-v1-cancelamento-recusado.spec.ts).
//
// Respostas são `Response` reais (undici). A mensagem do SyntaxError de
// JSON.parse depende do motor JS: é trocada por {{JSON_PARSE_ERRO}} só quando
// bate EXATAMENTE com a do motor corrente para o mesmo corpo.

const TOKEN = "TOKEN-GOLDEN-FOCUS";
const CHAVE = "35260911222333000181550010000001011876543210";

interface Stub {
  status?: number;
  json?: unknown;
  texto?: string;
  contentType?: string;
  lancar?: Error;
  headers?: Record<string, string>;
}

interface Requisicao {
  metodo: string;
  url: string;
  headers: Record<string, string>;
  corpo: unknown;
}

let requisicoes: Requisicao[] = [];
let proximo: Stub = {};

function corpoTexto(s: Stub): string {
  return s.texto ?? (s.json === undefined ? "" : JSON.stringify(s.json));
}

beforeEach(() => {
  requisicoes = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      requisicoes.push({
        metodo: String(init?.method ?? "GET"),
        url: String(url),
        headers: { ...((init?.headers as Record<string, string>) ?? {}) },
        corpo: typeof init?.body === "string" ? JSON.parse(init.body) : (init?.body ?? null),
      });
      if (proximo.lancar) throw proximo.lancar;
      return new Response(corpoTexto(proximo), {
        status: proximo.status ?? 200,
        headers: {
          "content-type": proximo.contentType ?? "application/json; charset=utf-8",
          ...proximo.headers,
        },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function erroJsonParse(texto: string): string | null {
  try {
    JSON.parse(texto);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

function serializar(casos: Record<string, { stub: Stub; requisicao: Requisicao | null; resultado: unknown }>): string {
  let json = JSON.stringify(
    casos,
    (_k, v) => (v instanceof Date ? v.toISOString() : v instanceof Error ? `${v.name}: ${v.message}` : v),
    2,
  );
  for (const c of Object.values(casos)) {
    const msg = c.stub.lancar ? null : erroJsonParse(corpoTexto(c.stub));
    if (msg) json = json.split(JSON.stringify(msg).slice(1, -1)).join("{{JSON_PARSE_ERRO}}");
  }
  return json;
}

async function rodarCasos<T>(
  casos: Record<string, Stub>,
  chamar: (p: FocusNfeProvider) => Promise<T>,
): Promise<Record<string, { stub: Stub; requisicao: Requisicao | null; resultado: unknown }>> {
  const saida: Record<string, { stub: Stub; requisicao: Requisicao | null; resultado: unknown }> = {};
  for (const [nome, stub] of Object.entries(casos)) {
    proximo = stub;
    requisicoes = [];
    const provider = new FocusNfeProvider("homologacao");
    let resultado: unknown;
    try {
      resultado = await chamar(provider);
    } catch (e) {
      resultado = { lancou: `${(e as Error).name}: ${(e as Error).message}` };
    }
    saida[nome] = { stub, requisicao: requisicoes[0] ?? null, resultado };
  }
  return saida;
}

const HTML_401 = "<html><body>HTTP Basic: Access denied.\n</body></html>";
const HTML_500 = "<!DOCTYPE html><html><head><title>500</title></head><body>Internal Server Error</body></html>";

describe("golden F0 — FocusNfeProvider V1 (HTTP)", () => {
  it("emitir", async () => {
    const autorizado = {
      cnpj_emitente: "11222333000181",
      ref: "nfe-golden-1",
      status: "autorizado",
      status_sefaz: "100",
      mensagem_sefaz: "Autorizado o uso da NF-e",
      chave_nfe: `NFe${CHAVE}`,
      numero: "3",
      serie: "1",
      protocolo: "135260000000001",
      data_evento: "2026-09-17T10:31:00-03:00",
      caminho_xml_nota_fiscal: "/arquivos/xml.xml",
    };
    const casos = await rodarCasos(
      {
        "200-autorizado": { status: 200, json: autorizado },
        "201-autorizado": { status: 201, json: autorizado },
        "202-processando": {
          status: 202,
          json: { cnpj_emitente: "11222333000181", ref: "nfe-golden-1", status: "processando_autorizacao" },
        },
        "202-sem-status": { status: 202, json: {} },
        "400-requisicao-invalida": {
          status: 400,
          json: { codigo: "requisicao_invalida", mensagem: "Parâmetro ref não informado" },
        },
        "401-html-access-denied": { status: 401, texto: HTML_401, contentType: "text/html; charset=utf-8" },
        "403-permissao-negada": {
          status: 403,
          json: { codigo: "permissao_negada", mensagem: "Empresa não habilitada para emitir NFe" },
        },
        "404-nao-encontrado": { status: 404, json: { codigo: "nao_encontrado", mensagem: "Empresa não encontrada" } },
        "415-media-type": {
          status: 415,
          json: { codigo: "formato_invalido", mensagem: "Content-Type deve ser application/json" },
        },
        "422-erro-validacao-schema": {
          status: 422,
          json: {
            codigo: "erro_validacao_schema",
            mensagem: "Erro de validação do Schema XML",
            erros: [{ codigo: "schema", mensagem: "Element 'cMun': [facet 'pattern']", campo: "cMun" }],
          },
        },
        "422-permissao-negada": {
          status: 422,
          json: { codigo: "permissao_negada", mensagem: "CNPJ do emitente não autorizado" },
        },
        "422-already-processed": {
          status: 422,
          json: { codigo: "already_processed", mensagem: "Nota fiscal já autorizada com esta referência" },
        },
        "422-pending-operation": {
          status: 422,
          json: { codigo: "pending_operation", mensagem: "Existe uma operação pendente para esta referência" },
        },
        "422-status-sefaz-974": {
          status: 422,
          json: {
            status: "erro_autorizacao",
            status_sefaz: "974",
            mensagem_sefaz: "Rejeicao: CNPJ do responsavel tecnico nao autorizado a emitir para o contribuinte",
          },
        },
        "429-limite": {
          status: 429,
          json: { codigo: "limite_requisicoes_excedido", mensagem: "Limite de requisições excedido" },
          headers: { "retry-after": "60" },
        },
        "500-html": { status: 500, texto: HTML_500, contentType: "text/html" },
        "rede-lanca": { lancar: new TypeError("fetch failed") },
      },
      (p) => p.emitir({ nfeData: { natureza_operacao: "VENDA", numero_nota: "101", serie: "1" }, token: TOKEN, ref: "nfe-golden-1" }),
    );
    await expect(serializar(casos)).toMatchFileSnapshot("./__snapshots__/focus-v1-emitir.json");
  });

  it("consultar", async () => {
    const casos = await rodarCasos(
      {
        autorizado: {
          status: 200,
          json: {
            status: "autorizado",
            status_sefaz: "100",
            mensagem_sefaz: "Autorizado o uso da NF-e",
            chave_nfe: `NFe${CHAVE}`,
            numero: "3",
            serie: "1",
            protocolo: "135260000000001",
            data_evento: "2026-09-17T10:31:00-03:00",
          },
        },
        cancelado: {
          status: 200,
          json: {
            status: "cancelado",
            status_sefaz: "135",
            mensagem_sefaz: "Evento registrado e vinculado a NF-e",
            chave_nfe: `NFe${CHAVE}`,
            protocolo: "135260000000009",
          },
        },
        "erro-autorizacao-598": {
          status: 200,
          json: {
            status: "erro_autorizacao",
            status_sefaz: "598",
            mensagem_sefaz: "Rejeicao: NF-e emitida em ambiente de homologacao com Razao Social do destinatario diferente de NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL",
          },
        },
        "processando-autorizacao": { status: 200, json: { status: "processando_autorizacao" } },
        denegado: {
          status: 200,
          json: { status: "denegado", status_sefaz: "302", mensagem_sefaz: "Uso Denegado: Irregularidade fiscal do destinatario" },
        },
        "403-json": { status: 403, json: { codigo: "permissao_negada", mensagem: "Token não autorizado" } },
        "404-nao-encontrado": { status: 404, json: { codigo: "nao_encontrado", mensagem: "Nota fiscal não encontrada" } },
        "401-html": { status: 401, texto: HTML_401, contentType: "text/html" },
        "rede-lanca": { lancar: new TypeError("fetch failed") },
      },
      (p) => p.consultar("nfe-golden-1", TOKEN),
    );
    await expect(serializar(casos)).toMatchFileSnapshot("./__snapshots__/focus-v1-consultar.json");
  });

  it("buscarXml", async () => {
    const casos = await rodarCasos(
      {
        "200-xml": { status: 200, texto: "<nfeProc><NFe/></nfeProc>", contentType: "application/xml" },
        "404-json": { status: 404, json: { codigo: "nao_encontrado", mensagem: "Nota fiscal não encontrada" } },
        "rede-lanca": { lancar: new TypeError("fetch failed") },
      },
      (p) => p.buscarXml("nfe-golden-1", TOKEN),
    );
    await expect(serializar(casos)).toMatchFileSnapshot("./__snapshots__/focus-v1-buscar-xml.json");
  });

  it("cancelar", async () => {
    const casos = await rodarCasos(
      {
        "200-cancelado": {
          status: 200,
          json: { status: "cancelado", status_sefaz: "135", mensagem_sefaz: "Evento registrado e vinculado a NF-e", protocolo: "135260000000009" },
        },
        "200-erro-cancelamento": {
          status: 200,
          json: { status: "erro_cancelamento", status_sefaz: "501", mensagem_sefaz: "Rejeicao: Prazo de cancelamento superior ao previsto na Legislacao" },
        },
        "422-json": { status: 422, json: { codigo: "requisicao_invalida", mensagem: "Justificativa deve ter entre 15 e 255 caracteres" } },
        "401-html": { status: 401, texto: HTML_401, contentType: "text/html" },
        "rede-lanca": { lancar: new TypeError("fetch failed") },
      },
      (p) =>
        p.cancelar({
          ref: "nfe-golden-1",
          chaveAcesso: CHAVE,
          protocolo: "135260000000001",
          justificativa: "Cancelamento de teste do golden F0",
          token: TOKEN,
        }),
    );
    await expect(serializar(casos)).toMatchFileSnapshot("./__snapshots__/focus-v1-cancelar.json");
  });

  it("inutilizar", async () => {
    const casos = await rodarCasos(
      {
        "200-autorizado-102": {
          status: 200,
          json: { status: "autorizado", status_sefaz: "102", mensagem_sefaz: "Inutilizacao de numero homologado", protocolo_sefaz: "135260000000010" },
        },
        "200-erro-autorizacao": {
          status: 200,
          json: { status: "erro_autorizacao", status_sefaz: "241", mensagem_sefaz: "Rejeicao: Um numero da faixa ja foi utilizado" },
        },
        "422-json": { status: 422, json: { codigo: "requisicao_invalida", mensagem: "numero_final menor que numero_inicial" } },
        "401-html": { status: 401, texto: HTML_401, contentType: "text/html" },
        "rede-lanca": { lancar: new TypeError("fetch failed") },
      },
      (p) =>
        p.inutilizar({
          cnpj: "11222333000181",
          serie: 1,
          numeroInicial: 8,
          numeroFinal: 10,
          justificativa: "Inutilizacao de teste do golden F0",
          token: TOKEN,
          ambiente: "homologacao",
        }),
    );
    await expect(serializar(casos)).toMatchFileSnapshot("./__snapshots__/focus-v1-inutilizar.json");
  });
});
