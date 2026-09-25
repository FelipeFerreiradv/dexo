import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Focus V1 (flag global da numeração V2 desligada): HTTP 200 com status de ERRO no corpo.
//
// A Focus responde 200 com {status:"erro_cancelamento", status_sefaz:"501", ...} quando a
// SEFAZ RECUSA o evento de cancelamento (ex.: prazo). O V1 tratava QUALQUER 200 como
// sucesso: o caso de uso gravava CANCELLED (estado terminal) com evento CANCELADA de
// protocolo null, embora a nota continuasse AUTORIZADA na SEFAZ — e o DANFE saía carimbado.
// Decisão do dono (25/09): corrigir. A inutilização tinha o mesmo defeito (V6: 200 com
// "erro_autorizacao" virava ACEITA e avançava o contador).
//
// Conservador: só o status de erro documentado vira falha. Qualquer outro 200 — inclusive o
// sucesso "cancelado"/"autorizado" e um 200 sem status — segue EXATAMENTE como antes (sem
// passar a exigir cStat, para não criar falso negativo). O golden focus-v1-http trava o resto.
// Exceção (mesmo dia): dentro da recusa, os códigos que provam que o pedido JÁ surtiu efeito
// — 218/420 (já cancelada) e 206/563 (já inutilizada) — são sucesso IDEMPOTENTE; sem isso a
// retentativa após uma resposta perdida falharia para sempre. O 256 (parcial) segue falha.
//
// Sem banco: provider REAL com `fetch` simulado; casos de uso REAIS com prisma e
// repositórios mockados (o ramo V2/ledger fica desligado pelas flags).

const h = vi.hoisted(() => {
  const nfeFindFirst = vi.fn();
  const nfeUpdate = vi.fn(async (..._args: any[]): Promise<any> => ({}));
  const inutCreate = vi.fn(async (..._args: any[]): Promise<any> => ({ id: "inut-1" }));
  const inutUpdate = vi.fn(async (..._args: any[]): Promise<any> => ({}));
  const transaction = vi.fn(async (): Promise<any> => {
    throw new Error("transação não esperada no V1");
  });
  const addAuditLog = vi.fn(async (..._args: any[]) => undefined);
  const findByIdForUser = vi.fn();
  const findByUserId = vi.fn();
  const consultarProximoNumero = vi.fn(async (..._args: any[]) => 8);
  const ajustarProximoNumero = vi.fn(async (..._args: any[]) => undefined);
  const prisma = {
    nfeEmitida: { findFirst: nfeFindFirst, update: nfeUpdate },
    nfeInutilizacao: { create: inutCreate, update: inutUpdate },
    $transaction: transaction,
  };
  return {
    nfeFindFirst,
    nfeUpdate,
    inutCreate,
    inutUpdate,
    transaction,
    addAuditLog,
    findByIdForUser,
    findByUserId,
    consultarProximoNumero,
    ajustarProximoNumero,
    prisma,
  };
});

vi.mock("../../app/lib/prisma", () => ({ default: h.prisma }));
vi.mock("@/app/lib/prisma", () => ({ default: h.prisma }));
vi.mock("../../app/repositories/nfe.repository", () => ({
  NfeRepository: class {
    addAuditLog = h.addAuditLog;
  },
}));
vi.mock("../../app/repositories/company-fiscal.repository", () => ({
  CompanyFiscalRepository: class {
    findByIdForUser = h.findByIdForUser;
    findByUserId = h.findByUserId;
  },
}));
vi.mock("../../app/fiscal/sequence/nfe-sequence.service", () => ({
  NfeSequenceService: class {
    consultarProximoNumero = h.consultarProximoNumero;
    ajustarProximoNumero = h.ajustarProximoNumero;
  },
}));

import { FocusNfeProvider } from "../../app/fiscal/providers/focus-nfe.provider";
import { NfeCancelamentoUseCase } from "../../app/usecases/nfe-cancelamento.usecase";
import { NfeInutilizacaoUseCase } from "../../app/usecases/nfe-inutilizacao.usecase";
import { makeConfig } from "./__helpers__/test-draft";

const TOKEN = "TOKEN-V1-RECUSA";
const HOMOLOG = "https://homologacao.focusnfe.com.br";
const JUSTIFICATIVA = "Cancelamento por erro de digitacao no pedido";

const ERRO_CANCELAMENTO = {
  status: "erro_cancelamento",
  status_sefaz: "501",
  mensagem_sefaz: "Rejeicao: Prazo de cancelamento superior ao previsto na Legislacao",
};
const CANCELADO = {
  status: "cancelado",
  status_sefaz: "135",
  mensagem_sefaz: "Evento registrado e vinculado a NF-e",
  protocolo: "135260000000009",
};
const ERRO_INUTILIZACAO = {
  status: "erro_autorizacao",
  status_sefaz: "241",
  mensagem_sefaz: "Rejeicao: Um numero da faixa ja foi utilizado",
};
const INUTILIZADO = {
  status: "autorizado",
  status_sefaz: "102",
  mensagem_sefaz: "Inutilizacao de numero homologado",
  protocolo_sefaz: "135260000000010",
};

let resposta: { status: number; json: unknown } = { status: 200, json: {} };
let chamadas: Array<{ url: string; metodo: string }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  chamadas = [];
  resposta = { status: 200, json: {} };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      chamadas.push({ url: String(url), metodo: String(init?.method ?? "GET") });
      return new Response(JSON.stringify(resposta.json), {
        status: resposta.status,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }),
  );
  // V1 puro: sem numeração V2 (sem ledger) e sem devolução (sem transação).
  vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", "false");
  vi.stubEnv("NFE_NUMERACAO_V2_FOCUS_ENABLED", "false");
  vi.stubEnv("NFE_DEVOLUCAO_ENABLED", "false");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function cancelar(p: FocusNfeProvider) {
  return p.cancelar({
    ref: "nfe-1",
    chaveAcesso: "3".repeat(44),
    protocolo: "135260000000001",
    justificativa: JUSTIFICATIVA,
    token: TOKEN,
  });
}

function inutilizar(p: FocusNfeProvider, faixa: { numeroInicial: number; numeroFinal: number } = { numeroInicial: 8, numeroFinal: 10 }) {
  return p.inutilizar({
    cnpj: "11222333000181",
    serie: 1,
    numeroInicial: faixa.numeroInicial,
    numeroFinal: faixa.numeroFinal,
    justificativa: "Inutilizacao de numeros pulados por erro",
    token: TOKEN,
    ambiente: "homologacao",
  });
}

describe("FocusNfeProvider V1 — cancelar: 200 com erro_cancelamento é FALHA", () => {
  it("200 'erro_cancelamento' (SEFAZ 501) ⇒ success:false, protocolo null e mensagem com o código e o texto da SEFAZ", async () => {
    resposta = { status: 200, json: ERRO_CANCELAMENTO };
    expect(await cancelar(new FocusNfeProvider("homologacao"))).toEqual({
      success: false,
      protocolo: null,
      mensagem:
        "Cancelamento recusado pela SEFAZ (codigo 501): Rejeicao: Prazo de cancelamento superior ao previsto na Legislacao",
    });
    expect(chamadas).toEqual([{ url: `${HOMOLOG}/v2/nfe/nfe-1`, metodo: "DELETE" }]);
  });

  it("erro_cancelamento com protocolo no corpo continua falha e NÃO repassa o protocolo", async () => {
    resposta = { status: 200, json: { ...ERRO_CANCELAMENTO, protocolo: "135260000000999" } };
    const r = await cancelar(new FocusNfeProvider("homologacao"));
    expect(r.success).toBe(false);
    expect(r.protocolo).toBeNull();
  });

  it("erro_cancelamento sem os campos da SEFAZ ⇒ falha com texto legível (código numérico e mensagem genérica também servem)", async () => {
    resposta = { status: 200, json: { status: "erro_cancelamento" } };
    expect(await cancelar(new FocusNfeProvider("homologacao"))).toEqual({
      success: false,
      protocolo: null,
      mensagem: "Cancelamento recusado pela SEFAZ",
    });
    // Era 218 aqui; 218 ("já cancelada") passou a ser sucesso IDEMPOTENTE (ver o describe
    // abaixo). O que este caso trava — código NUMÉRICO e a `mensagem` da Focus aparada —
    // segue igual com um código que continua sendo recusa (501).
    resposta = { status: 200, json: { status: "erro_cancelamento", status_sefaz: 501, mensagem: "  Prazo de cancelamento expirado  " } };
    expect(await cancelar(new FocusNfeProvider("homologacao"))).toEqual({
      success: false,
      protocolo: null,
      mensagem: "Cancelamento recusado pela SEFAZ (codigo 501): Prazo de cancelamento expirado",
    });
  });

  it("erro_cancelamento com mensagem_sefaz E mensagem ⇒ prevalece a mensagem_sefaz", async () => {
    resposta = { status: 200, json: { ...ERRO_CANCELAMENTO, mensagem: "Mensagem generica da Focus" } };
    expect(await cancelar(new FocusNfeProvider("homologacao"))).toEqual({
      success: false,
      protocolo: null,
      mensagem:
        "Cancelamento recusado pela SEFAZ (codigo 501): Rejeicao: Prazo de cancelamento superior ao previsto na Legislacao",
    });
  });

  it("HTTP 200 com corpo null ⇒ a MESMA falha do HEAD de main (TypeError ao ler 'protocolo')", async () => {
    resposta = { status: 200, json: null };
    expect(await cancelar(new FocusNfeProvider("homologacao"))).toEqual({
      success: false,
      protocolo: null,
      mensagem: "Cannot read properties of null (reading 'protocolo')",
    });
  });

  it("NFC-e (modelo 65, /v2/nfce) segue a mesma regra", async () => {
    resposta = { status: 200, json: ERRO_CANCELAMENTO };
    const r = await cancelar(new FocusNfeProvider("homologacao", "65"));
    expect(r).toMatchObject({ success: false, protocolo: null });
    expect(chamadas).toEqual([{ url: `${HOMOLOG}/v2/nfce/nfe-1`, metodo: "DELETE" }]);
  });

  it("controle: 200 'cancelado' (135) segue EXATAMENTE como antes", async () => {
    resposta = { status: 200, json: CANCELADO };
    expect(await cancelar(new FocusNfeProvider("homologacao"))).toEqual({
      success: true,
      protocolo: "135260000000009",
      mensagem: "Evento registrado e vinculado a NF-e",
    });
  });

  it("controle: outro 200 (sem status, ou 'cancelado' sem cStat) segue como antes — sucesso, sem exigir cStat", async () => {
    resposta = { status: 200, json: {} };
    expect(await cancelar(new FocusNfeProvider("homologacao"))).toEqual({ success: true, protocolo: null, mensagem: "" });
    resposta = { status: 200, json: { status: "cancelado", mensagem: "Cancelado" } };
    expect(await cancelar(new FocusNfeProvider("homologacao"))).toEqual({ success: true, protocolo: null, mensagem: "Cancelado" });
  });

  it("controle: HTTP diferente de 200 com erro_cancelamento no corpo segue como antes (mensagem crua)", async () => {
    resposta = { status: 422, json: ERRO_CANCELAMENTO };
    expect(await cancelar(new FocusNfeProvider("homologacao"))).toEqual({
      success: false,
      protocolo: null,
      mensagem: ERRO_CANCELAMENTO.mensagem_sefaz,
    });
  });
});

// Beco sem saída que a revisão mediu: o 1º DELETE é processado pela SEFAZ e a resposta se
// perde; a nota fica AUTHORIZED no Dexo e toda nova tentativa volta 200 "erro_cancelamento"
// com 218 ("NF-e já está cancelada na base de dados da SEFAZ") ou 420 ("Cancelamento para
// NF-e já cancelada"). Como falha, nunca mais reconciliaria. Esses DOIS códigos provam que a
// nota ESTÁ cancelada ⇒ sucesso idempotente; qualquer outro código segue sendo recusa.
describe("FocusNfeProvider V1 — cancelar: 218/420 ('já cancelada') é sucesso IDEMPOTENTE", () => {
  it.each([
    ["218", "Rejeicao: NF-e ja esta cancelada na base de dados da SEFAZ"],
    ["420", "Rejeicao: Cancelamento para NF-e ja cancelada"],
  ])("200 'erro_cancelamento' com status_sefaz %s ⇒ success:true, protocolo null e mensagem clara", async (cStat, texto) => {
    resposta = { status: 200, json: { status: "erro_cancelamento", status_sefaz: cStat, mensagem_sefaz: texto } };
    expect(await cancelar(new FocusNfeProvider("homologacao"))).toEqual({
      success: true,
      protocolo: null,
      mensagem: `NF-e ja estava cancelada na SEFAZ (codigo ${cStat}): ${texto}`,
    });
    expect(chamadas).toEqual([{ url: `${HOMOLOG}/v2/nfe/nfe-1`, metodo: "DELETE" }]);
  });

  it("código numérico e com espaços também vale; o protocolo que vier é repassado", async () => {
    resposta = { status: 200, json: { status: "erro_cancelamento", status_sefaz: 420, protocolo: "135260000000777" } };
    expect(await cancelar(new FocusNfeProvider("homologacao"))).toEqual({
      success: true,
      protocolo: "135260000000777",
      mensagem: "NF-e ja estava cancelada na SEFAZ (codigo 420)",
    });
    resposta = { status: 200, json: { status: "erro_cancelamento", status_sefaz: " 218 ", mensagem: "Ja cancelada" } };
    expect(await cancelar(new FocusNfeProvider("homologacao", "65"))).toEqual({
      success: true,
      protocolo: null,
      mensagem: "NF-e ja estava cancelada na SEFAZ (codigo 218): Ja cancelada",
    });
  });

  it.each([["501"], ["573"], ["217"], ["219"], ["2180"], ["218a"], ["21 8"], [""]])(
    "NÃO afrouxa: erro_cancelamento com status_sefaz %j segue FALHA",
    async (cStat) => {
      resposta = { status: 200, json: { status: "erro_cancelamento", status_sefaz: cStat, protocolo: "135260000000777" } };
      const r = await cancelar(new FocusNfeProvider("homologacao"));
      expect(r.success).toBe(false);
      expect(r.protocolo).toBeNull();
      expect(r.mensagem.startsWith("Cancelamento recusado pela SEFAZ")).toBe(true);
    },
  );

  it("NÃO afrouxa: 218 fora do HTTP 200 segue como antes (falha com a mensagem crua)", async () => {
    resposta = {
      status: 422,
      json: { status: "erro_cancelamento", status_sefaz: "218", mensagem_sefaz: "Rejeicao: NF-e ja esta cancelada na base de dados da SEFAZ" },
    };
    expect(await cancelar(new FocusNfeProvider("homologacao"))).toEqual({
      success: false,
      protocolo: null,
      mensagem: "Rejeicao: NF-e ja esta cancelada na base de dados da SEFAZ",
    });
  });
});

describe("FocusNfeProvider V1 — inutilizar: 200 com erro_autorizacao é FALHA (V6)", () => {
  it("200 'erro_autorizacao' (SEFAZ 241) ⇒ success:false, protocolo null e mensagem com o código e o texto da SEFAZ", async () => {
    resposta = { status: 200, json: ERRO_INUTILIZACAO };
    expect(await inutilizar(new FocusNfeProvider("homologacao"))).toEqual({
      success: false,
      protocolo: null,
      mensagem: "Inutilizacao recusada pela SEFAZ (codigo 241): Rejeicao: Um numero da faixa ja foi utilizado",
    });
    expect(chamadas).toEqual([{ url: `${HOMOLOG}/v2/nfe/inutilizacao`, metodo: "POST" }]);
  });

  it("controle: 200 'autorizado' (102) segue EXATAMENTE como antes (inclusive o protocolo lido de `protocolo`)", async () => {
    resposta = { status: 200, json: INUTILIZADO };
    expect(await inutilizar(new FocusNfeProvider("homologacao"))).toEqual({
      success: true,
      protocolo: null,
      mensagem: "Inutilizacao de numero homologado",
    });
  });

  it("controle: 200 sem status segue como antes — sucesso", async () => {
    resposta = { status: 200, json: { mensagem: "ok" } };
    expect(await inutilizar(new FocusNfeProvider("homologacao"))).toEqual({ success: true, protocolo: null, mensagem: "ok" });
  });

  it("erro_autorizacao com mensagem_sefaz E mensagem ⇒ prevalece a mensagem_sefaz", async () => {
    resposta = { status: 200, json: { ...ERRO_INUTILIZACAO, mensagem: "Mensagem generica da Focus" } };
    expect(await inutilizar(new FocusNfeProvider("homologacao"))).toEqual({
      success: false,
      protocolo: null,
      mensagem: "Inutilizacao recusada pela SEFAZ (codigo 241): Rejeicao: Um numero da faixa ja foi utilizado",
    });
  });

  it("HTTP 200 com corpo null ⇒ a MESMA falha do HEAD de main (TypeError ao ler 'protocolo')", async () => {
    resposta = { status: 200, json: null };
    expect(await inutilizar(new FocusNfeProvider("homologacao"))).toEqual({
      success: false,
      protocolo: null,
      mensagem: "Cannot read properties of null (reading 'protocolo')",
    });
  });
});

// Mesmo beco sem saída na inutilização: a faixa foi inutilizada e a resposta se perdeu; a
// nova tentativa volta 206 ("NF-e já está inutilizada") ou 563 ("Já existe pedido de
// inutilização com a mesma faixa") ⇒ sucesso idempotente. O 256 ("Uma NF-e da faixa já está
// inutilizada") é faixa PARCIALMENTE inutilizada: o resto dela não foi — segue FALHA.
describe("FocusNfeProvider V1 — inutilizar: 206/563 ('já inutilizada') é sucesso IDEMPOTENTE", () => {
  // 563 prova a FAIXA; 206 é por NÚMERO ("NF-e já está inutilizada"): só prova a faixa
  // inteira quando ela tem um número só.
  it.each([
    ["206", "Rejeicao: NF-e ja esta inutilizada na Base de dados da SEFAZ", { numeroInicial: 9, numeroFinal: 9 }],
    ["563", "Rejeicao: Ja existe pedido de Inutilizacao com a mesma faixa de inutilizacao", { numeroInicial: 8, numeroFinal: 10 }],
  ])("200 'erro_autorizacao' com status_sefaz %s ⇒ success:true, protocolo null e mensagem clara", async (cStat, texto, faixa) => {
    resposta = { status: 200, json: { status: "erro_autorizacao", status_sefaz: cStat, mensagem_sefaz: texto } };
    expect(await inutilizar(new FocusNfeProvider("homologacao"), faixa)).toEqual({
      success: true,
      protocolo: null,
      mensagem: `Faixa ja estava inutilizada na SEFAZ (codigo ${cStat}): ${texto}`,
    });
    expect(chamadas).toEqual([{ url: `${HOMOLOG}/v2/nfe/inutilizacao`, metodo: "POST" }]);
  });

  it("código numérico também vale; o protocolo que vier (campo `protocolo`, como no sucesso) é repassado", async () => {
    resposta = { status: 200, json: { status: "erro_autorizacao", status_sefaz: 563, protocolo: "135260000000888" } };
    expect(await inutilizar(new FocusNfeProvider("homologacao"))).toEqual({
      success: true,
      protocolo: "135260000000888",
      mensagem: "Faixa ja estava inutilizada na SEFAZ (codigo 563)",
    });
  });

  it("206 numa faixa de VÁRIOS números NÃO é sucesso: um número já inutilizado não prova a faixa inteira", async () => {
    resposta = { status: 200, json: { status: "erro_autorizacao", status_sefaz: "206", mensagem_sefaz: "Rejeicao: NF-e ja esta inutilizada na Base de dados da SEFAZ" } };
    const r = await inutilizar(new FocusNfeProvider("homologacao"), { numeroInicial: 8, numeroFinal: 10 });
    expect(r.success).toBe(false);
    expect(r.protocolo).toBeNull();
    expect(r.mensagem).toMatch(/^Inutilizacao recusada pela SEFAZ/);
  });

  it("NÃO afrouxa o HTTP: 201/202 com 218 ou 563 no corpo seguem como antes (falha, mensagem crua)", async () => {
    for (const http of [201, 202]) {
      resposta = { status: http, json: { status: "erro_cancelamento", status_sefaz: "218", mensagem: "x" } };
      expect((await cancelar(new FocusNfeProvider("homologacao"))).success).toBe(false);
      resposta = { status: http, json: { status: "erro_autorizacao", status_sefaz: "563", mensagem: "x" } };
      expect((await inutilizar(new FocusNfeProvider("homologacao"), { numeroInicial: 9, numeroFinal: 9 })).success).toBe(false);
    }
  });

  it("256 (faixa PARCIALMENTE inutilizada) NÃO é sucesso: segue recusa", async () => {
    resposta = {
      status: 200,
      json: { status: "erro_autorizacao", status_sefaz: "256", mensagem_sefaz: "Rejeicao: Uma NF-e da faixa ja esta inutilizada na Base de dados da SEFAZ" },
    };
    expect(await inutilizar(new FocusNfeProvider("homologacao"))).toEqual({
      success: false,
      protocolo: null,
      mensagem: "Inutilizacao recusada pela SEFAZ (codigo 256): Rejeicao: Uma NF-e da faixa ja esta inutilizada na Base de dados da SEFAZ",
    });
  });

  it.each([["256"], ["241"], ["2060"], ["563x"], ["218"], ["420"], [""]])(
    "NÃO afrouxa: erro_autorizacao com status_sefaz %j segue FALHA",
    async (cStat) => {
      resposta = { status: 200, json: { status: "erro_autorizacao", status_sefaz: cStat, protocolo: "135260000000888" } };
      const r = await inutilizar(new FocusNfeProvider("homologacao"));
      expect(r.success).toBe(false);
      expect(r.protocolo).toBeNull();
      expect(r.mensagem.startsWith("Inutilizacao recusada pela SEFAZ")).toBe(true);
    },
  );

  it("NÃO cruza as listas: 206/563 num erro_cancelamento seguem recusa do cancelamento", async () => {
    resposta = { status: 200, json: { status: "erro_cancelamento", status_sefaz: "563" } };
    expect(await cancelar(new FocusNfeProvider("homologacao"))).toMatchObject({ success: false });
    resposta = { status: 200, json: { status: "erro_cancelamento", status_sefaz: "206" } };
    expect(await cancelar(new FocusNfeProvider("homologacao"))).toMatchObject({ success: false });
  });
});

describe("NfeCancelamentoUseCase — Focus V1 (flag global desligada)", () => {
  const CONFIG = makeConfig({ id: "cfg-focus", userId: "u1", providerName: "FOCUS_NFE", providerToken: TOKEN } as never);

  function notaAutorizada() {
    return {
      id: "nfe-1",
      userId: "u1",
      status: "AUTHORIZED",
      modelo: "55",
      chaveAcesso: "3".repeat(44),
      protocoloAutorizacao: "135260000000001",
      dataAutorizacao: new Date(Date.now() - 60 * 60 * 1000),
      createdAt: new Date(),
      companyFiscalConfigId: "cfg-focus",
    };
  }

  beforeEach(() => {
    h.nfeFindFirst.mockResolvedValue(notaAutorizada());
    h.findByIdForUser.mockResolvedValue(CONFIG);
  });

  it("200 'erro_cancelamento' ⇒ nota segue AUTHORIZED, nada é gravado como CANCELLED e o evento é CANCELAMENTO_REJEITADO", async () => {
    resposta = { status: 200, json: ERRO_CANCELAMENTO };
    const r = await new NfeCancelamentoUseCase().cancel("u1", "nfe-1", JUSTIFICATIVA);
    const mensagem =
      "Cancelamento recusado pela SEFAZ (codigo 501): Rejeicao: Prazo de cancelamento superior ao previsto na Legislacao";
    expect(r).toEqual({ success: false, nfeId: "nfe-1", status: "AUTHORIZED", protocolo: null, mensagem });
    expect(chamadas).toEqual([{ url: `${HOMOLOG}/v2/nfe/nfe-1`, metodo: "DELETE" }]);
    expect(h.nfeUpdate).not.toHaveBeenCalled();
    expect(h.addAuditLog.mock.calls).toEqual([["nfe-1", "u1", "CANCELAMENTO_REJEITADO", { mensagem }]]);
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("controle: 200 'cancelado' ⇒ CANCELLED com o protocolo da SEFAZ, como antes", async () => {
    resposta = { status: 200, json: CANCELADO };
    const r = await new NfeCancelamentoUseCase().cancel("u1", "nfe-1", JUSTIFICATIVA);
    expect(r).toEqual({
      success: true,
      nfeId: "nfe-1",
      status: "CANCELLED",
      protocolo: "135260000000009",
      mensagem: "NF-e cancelada com sucesso",
    });
    expect(h.nfeUpdate).toHaveBeenCalledWith({
      where: { id: "nfe-1" },
      data: { status: "CANCELLED", motivoRejeicao: JUSTIFICATIVA },
    });
    expect(h.addAuditLog.mock.calls).toEqual([
      ["nfe-1", "u1", "CANCELADA", { justificativa: JUSTIFICATIVA, protocolo: "135260000000009" }],
    ]);
  });

  it.each([["218"], ["420"]])(
    "retentativa depois de resposta perdida: 200 'erro_cancelamento' %s ⇒ a nota RECONCILIA para CANCELLED (protocolo null)",
    async (cStat) => {
      resposta = {
        status: 200,
        json: { status: "erro_cancelamento", status_sefaz: cStat, mensagem_sefaz: "Rejeicao: NF-e ja esta cancelada na base de dados da SEFAZ" },
      };
      const r = await new NfeCancelamentoUseCase().cancel("u1", "nfe-1", JUSTIFICATIVA);
      expect(r).toEqual({ success: true, nfeId: "nfe-1", status: "CANCELLED", protocolo: null, mensagem: "NF-e cancelada com sucesso" });
      expect(h.nfeUpdate).toHaveBeenCalledWith({
        where: { id: "nfe-1" },
        data: { status: "CANCELLED", motivoRejeicao: JUSTIFICATIVA },
      });
      expect(h.addAuditLog.mock.calls).toEqual([["nfe-1", "u1", "CANCELADA", { justificativa: JUSTIFICATIVA, protocolo: null }]]);
    },
  );
});

describe("NfeInutilizacaoUseCase — Focus V1 (flag global desligada)", () => {
  const CONFIG = makeConfig({ id: "cfg-focus", userId: "u1", providerName: "FOCUS_NFE", providerToken: TOKEN, isDefault: true } as never);
  const INPUT = { serie: 1, numeroInicial: 8, numeroFinal: 10, justificativa: "Inutilizacao de numeros pulados por erro" };

  beforeEach(() => {
    h.findByUserId.mockResolvedValue(CONFIG);
  });

  it("200 'erro_autorizacao' ⇒ REJEITADA e o contador NÃO avança", async () => {
    resposta = { status: 200, json: ERRO_INUTILIZACAO };
    const r = await new NfeInutilizacaoUseCase().inutilizar("u1", INPUT);
    const mensagem = "Inutilizacao recusada pela SEFAZ (codigo 241): Rejeicao: Um numero da faixa ja foi utilizado";
    expect(r).toEqual({ success: false, id: "inut-1", status: "REJEITADA", protocolo: null, mensagem });
    expect(h.inutUpdate).toHaveBeenCalledWith({
      where: { id: "inut-1" },
      data: { status: "REJEITADA", protocolo: null, respostaJson: { mensagem, protocolo: null } },
    });
    expect(h.consultarProximoNumero).not.toHaveBeenCalled();
    expect(h.ajustarProximoNumero).not.toHaveBeenCalled();
  });

  it("controle: 200 'autorizado' ⇒ ACEITA e o contador avança além da faixa, como antes", async () => {
    resposta = { status: 200, json: INUTILIZADO };
    const r = await new NfeInutilizacaoUseCase().inutilizar("u1", INPUT);
    expect(r).toMatchObject({ success: true, status: "ACEITA", mensagem: "Inutilizacao de numero homologado" });
    expect(h.ajustarProximoNumero).toHaveBeenCalledWith("u1", "HOMOLOGACAO", 1, 11, "55", {
      companyFiscalConfigId: "cfg-focus",
      isDefaultConfig: true,
    });
  });

  it.each([
    ["206", "Rejeicao: NF-e ja esta inutilizada na Base de dados da SEFAZ", { ...INPUT, numeroInicial: 10, numeroFinal: 10 }],
    ["563", "Rejeicao: Ja existe pedido de Inutilizacao com a mesma faixa de inutilizacao", INPUT],
  ])("retentativa depois de resposta perdida: 200 'erro_autorizacao' %s ⇒ ACEITA e o contador avança", async (cStat, texto, entrada) => {
    resposta = { status: 200, json: { status: "erro_autorizacao", status_sefaz: cStat, mensagem_sefaz: texto } };
    const r = await new NfeInutilizacaoUseCase().inutilizar("u1", entrada);
    const mensagem = `Faixa ja estava inutilizada na SEFAZ (codigo ${cStat}): ${texto}`;
    expect(r).toEqual({ success: true, id: "inut-1", status: "ACEITA", protocolo: null, mensagem });
    expect(h.inutUpdate).toHaveBeenCalledWith({
      where: { id: "inut-1" },
      data: { status: "ACEITA", protocolo: null, respostaJson: { mensagem, protocolo: null } },
    });
    expect(h.ajustarProximoNumero).toHaveBeenCalledWith("u1", "HOMOLOGACAO", 1, 11, "55", {
      companyFiscalConfigId: "cfg-focus",
      isDefaultConfig: true,
    });
  });

  it("206 numa faixa de vários números ⇒ REJEITADA e o contador NÃO avança", async () => {
    resposta = { status: 200, json: { status: "erro_autorizacao", status_sefaz: "206", mensagem_sefaz: "Rejeicao: NF-e ja esta inutilizada na Base de dados da SEFAZ" } };
    const r = await new NfeInutilizacaoUseCase().inutilizar("u1", INPUT);
    expect(r.success).toBe(false);
    expect(r.status).toBe("REJEITADA");
    expect(h.ajustarProximoNumero).not.toHaveBeenCalled();
  });

  it("256 (faixa parcialmente inutilizada) ⇒ REJEITADA e o contador NÃO avança", async () => {
    resposta = {
      status: 200,
      json: { status: "erro_autorizacao", status_sefaz: "256", mensagem_sefaz: "Rejeicao: Uma NF-e da faixa ja esta inutilizada na Base de dados da SEFAZ" },
    };
    const r = await new NfeInutilizacaoUseCase().inutilizar("u1", INPUT);
    expect(r).toMatchObject({ success: false, status: "REJEITADA", protocolo: null });
    expect(h.consultarProximoNumero).not.toHaveBeenCalled();
    expect(h.ajustarProximoNumero).not.toHaveBeenCalled();
  });
});
