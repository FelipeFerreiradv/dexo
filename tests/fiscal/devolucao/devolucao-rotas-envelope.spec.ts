/**
 * Rotas da devolução: UM envelope para toda recusa — `{ error, code, issues?, erros?, draftId? }`
 * (respostaErroDevolucao) — tanto o 400 do parser quanto os erros do caso de uso. A tela
 * lê `issues` (pendências por item) e `erros` (campo + frase). Antes: a recusa de
 * tributação descartava o motivo, a recusa de campo do caso de uso não existia, e o
 * `campo` "itens[i]" apontava o corpo FILTRADO (a tela tira as peças zeradas antes de
 * enviar), sem como achar o cartão. Agora cada erro de item traz o `nItem` (e a chave).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fastify, { type FastifyInstance } from "fastify";

const h = vi.hoisted(() => ({ acao: null as null | ((metodo: string, args: unknown[]) => unknown) }));

vi.mock("../../../app/lib/prisma", () => ({ default: {} }));
vi.mock("@/app/lib/prisma", () => ({ default: {} }));
vi.mock("../../../app/middlewares/auth.middleware", () => ({
  authMiddleware: async (request: any) => { request.user = { id: "ator", dataOwnerId: "tenant" }; },
}));
vi.mock("../../../app/usecases/nfe-devolucao.usecase", () => ({
  NfeDevolucaoUseCase: class {
    constructor() {
      return new Proxy({}, { get: (_t, metodo: string) => async (...args: unknown[]) => h.acao!(metodo, args) });
    }
  },
}));

import { fiscalDevolucaoRoutes } from "../../../app/routes/fiscal-devolucao.routes";
import { DevolucaoError } from "../../../app/fiscal/devolucao/devolucao.errors";
import { NumeracaoError } from "../../../app/fiscal/numeracao/numeracao.errors";
import { CHAVE_DISAUTO } from "./devolucao-caso-de-uso-fixtures";

let app: FastifyInstance | null = null;
beforeEach(async () => {
  h.acao = null;
  app = fastify();
  await app.register(fiscalDevolucaoRoutes, { prefix: "/fiscal" });
});
afterEach(async () => { await app?.close(); app = null; });

const item = (over: Record<string, unknown> = {}) => ({ chaveAcesso: CHAVE_DISAUTO, nItem: 5, quantidade: 1, cfop: "5202", ...over });

describe("PUT …/devolucao/itens", () => {
  it("400 do parser: cada erro de item traz o nItem e a chave do item do CORPO (o índice é o do corpo filtrado)", async () => {
    h.acao = () => { throw new Error("não devia chegar ao caso de uso"); };
    const r = await app!.inject({
      method: "PUT", url: "/fiscal/nfe/draft/d1/devolucao/itens",
      payload: { itens: [item(), item({ nItem: 6, tributacao: { pis: { cst: "1" } } })] },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({
      error: "Dados da requisição inválidos.", code: "PAYLOAD_INVALIDO",
      erros: [{ campo: "itens[1].tributacao.pis.cst", mensagem: "Use 2 dígitos.", nItem: 6, chaveAcesso: CHAVE_DISAUTO }],
    });
  });

  it("422 do caso de uso: o motivo de cada tributo vai em `issues`, no mesmo envelope", async () => {
    const issues = [{ code: "PIS_COFINS_REGIME_INCOMPATIVEL", severidade: "ERRO", ordem: 2, mensagem: "Item 2: PIS: O CST 01 é de empresa do regime normal…" }];
    h.acao = (metodo) => { expect(metodo).toBe("itens"); throw new DevolucaoError("TRIBUTACAO_NAO_SUPORTADA", issues as never); };
    const r = await app!.inject({ method: "PUT", url: "/fiscal/nfe/draft/d1/devolucao/itens", payload: { itens: [item()] } });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toEqual({ error: "Tributação não suportada na devolução.", code: "TRIBUTACAO_NAO_SUPORTADA", issues });
  });

  it("recusa sem pendência continua sem a chave `issues` (nada muda para quem já lia)", async () => {
    h.acao = () => { throw new DevolucaoError("DEVOLUCAO_EM_EMISSAO"); };
    const r = await app!.inject({ method: "PUT", url: "/fiscal/nfe/draft/d1/devolucao/itens", payload: { itens: [item()] } });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: "Esta nota já foi enviada à SEFAZ e não pode mais ser alterada.", code: "DEVOLUCAO_EM_EMISSAO" });
  });
});

describe("POST …/devolucao/manual", () => {
  const corpoChave = { tipo: "COMPRA_SAIDA", chaveAcesso: CHAVE_DISAUTO, confirmarSemXml: true, itens: [{ nItem: 6, codigo: "X", descricao: "PECA", ncm: "84133090", unidade: "UN", valorUnitario: 10, quantidade: 1 }] };

  it("recusa de campo vinda do caso de uso (chave × empresa) sai IGUAL ao 400 do parser", async () => {
    h.acao = () => { throw new DevolucaoError("PAYLOAD_INVALIDO", undefined, { erros: [{ campo: "chaveAcesso", mensagem: "Esta chave é de uma nota emitida pela sua própria empresa." }] }); };
    const r = await app!.inject({ method: "POST", url: "/fiscal/nfe/devolucao/manual", payload: corpoChave });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: "Dados da requisição inválidos.", code: "PAYLOAD_INVALIDO", erros: [{ campo: "chaveAcesso", mensagem: "Esta chave é de uma nota emitida pela sua própria empresa." }] });
  });

  it("201 para rascunho novo; 200 com `reutilizado: true` quando já havia um aberto desta nota", async () => {
    h.acao = () => ({ draftId: "novo", reutilizado: false });
    const novo = await app!.inject({ method: "POST", url: "/fiscal/nfe/devolucao/manual", payload: corpoChave });
    expect(novo.statusCode).toBe(201);
    expect(novo.json()).toEqual({ draftId: "novo", reutilizado: false });
    h.acao = () => ({ draftId: "8d269885", reutilizado: true });
    const velho = await app!.inject({ method: "POST", url: "/fiscal/nfe/devolucao/manual", payload: corpoChave });
    expect(velho.statusCode).toBe(200);
    expect(velho.json()).toEqual({ draftId: "8d269885", reutilizado: true });
  });

  it("400 do parser na devolução pela chave: o nItem digitado acompanha o erro do item", async () => {
    h.acao = () => { throw new Error("não devia chegar"); };
    const r = await app!.inject({ method: "POST", url: "/fiscal/nfe/devolucao/manual", payload: { ...corpoChave, itens: [{ ...corpoChave.itens[0], ncm: "123" }] } });
    expect(r.statusCode).toBe(400);
    expect(r.json().erros).toEqual([{ campo: "itens[0].ncm", mensagem: "NCM com 8 dígitos.", nItem: 6 }]);
  });
});

describe("POST …/devolucao/manual/previa", () => {
  it("mesmo corpo do manual; devolve a prévia do caso de uso (200) e o 400 do parser no mesmo envelope", async () => {
    const previa = { chaveAcesso: CHAVE_DISAUTO, itens: [] };
    h.acao = (metodo, args) => { expect(metodo).toBe("previaManual"); expect((args[1] as { modo: string }).modo).toBe("XML"); return previa; };
    const ok = await app!.inject({ method: "POST", url: "/fiscal/nfe/devolucao/manual/previa", payload: { tipo: "COMPRA_SAIDA", xmlOriginal: "<nfeProc/>" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual(previa);
    const ruim = await app!.inject({ method: "POST", url: "/fiscal/nfe/devolucao/manual/previa", payload: { tipo: "COMPRA_SAIDA", xmlOriginal: "" } });
    expect(ruim.statusCode).toBe(400);
    expect(ruim.json()).toEqual({ error: "Dados da requisição inválidos.", code: "PAYLOAD_INVALIDO", erros: [{ campo: "xmlOriginal", mensagem: "XML vazio." }] });
  });
});

describe("GET …/devolucao/abertas", () => {
  it("devolve a lista do caso de uso", async () => {
    const lista = { abertas: [{ draftId: "cmubl7is", gerenciada: false }] };
    h.acao = (metodo, args) => { expect(metodo).toBe("abertas"); expect(args[0]).toBe("tenant"); return lista; };
    const r = await app!.inject({ method: "GET", url: "/fiscal/nfe/devolucao/abertas" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual(lista);
  });

  it("devolução desligada: 404 'Recurso indisponível' sem código (como as outras rotas)", async () => {
    h.acao = () => { throw new NumeracaoError("RECURSO_INDISPONIVEL", 404, "Recurso indisponível"); };
    const r = await app!.inject({ method: "GET", url: "/fiscal/nfe/devolucao/abertas" });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: "Recurso indisponível" });
  });
});

describe("GET …/devolucao/abertas sem a devolução ligada (onda 5)", () => {
  it("o caso de uso devolve a lista vazia: 200 {abertas: []} — não é mais 404", async () => {
    h.acao = (metodo) => { expect(metodo).toBe("abertas"); return { abertas: [] }; };
    const r = await app!.inject({ method: "GET", url: "/fiscal/nfe/devolucao/abertas" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ abertas: [] });
  });
});

describe("GET …/devolucao/disponibilidade (onda 5: pelo caso de uso, com `empresas`)", () => {
  it("devolve o corpo do caso de uso (o campo de sempre + empresas)", async () => {
    const corpo = { disponivel: true, companyFiscalConfigId: "cfg-dls", empresas: [{ companyFiscalConfigId: "cfg-dls", cnpj: "57502966000144", razaoSocial: "DLS", nomeFantasia: null, uf: "SC", ambiente: "PRODUCAO", isDefault: true }] };
    h.acao = (metodo, args) => { expect(metodo).toBe("disponibilidade"); expect(args[0]).toBe("tenant"); return corpo; };
    const r = await app!.inject({ method: "GET", url: "/fiscal/nfe/devolucao/disponibilidade" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual(corpo);
  });

  it("nenhuma empresa ligada: o MESMO 404 de antes, {error} sem código", async () => {
    h.acao = () => { throw new NumeracaoError("RECURSO_INDISPONIVEL", 404, "Recurso indisponível"); };
    const r = await app!.inject({ method: "GET", url: "/fiscal/nfe/devolucao/disponibilidade" });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: "Recurso indisponível" });
  });
});
