import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHAVES_IGNORADAS_HASH,
  MENSAGEM_SENDING_LEGADO,
  avaliarFaixa,
  decidirAdocaoLegado,
  decidirEntrada,
  decidirPreClaim,
  decidirReadbackFocus,
  hashConteudo,
  mensagemBloqueiosFaixa,
  mensagemDescarteFaixa,
  motivoTrocaChave,
  partesDaChave,
  type EntradaAdocaoLegado,
  type EventoTrilha,
  type ReservaPreClaim,
  type ReservaVivaEntrada,
} from "../../../app/fiscal/numeracao/decisao";
import { calcularDV, parseChave } from "../../../app/fiscal/sefaz/chave-acesso";

const AGORA = new Date("2026-09-17T12:00:00.000Z");
const antes = (ms: number) => new Date(AGORA.getTime() - ms);
const depois = (ms: number) => new Date(AGORA.getTime() + ms);
const LEASE_PRE = 600_000;

// ─────────────────────────────── decidirEntrada ───────────────────────────────

function viva(estado: string, extra: Partial<ReservaVivaEntrada> = {}): ReservaVivaEntrada {
  return { estado, leaseAte: null, numero: 101, ...extra };
}

function entrada(status: string, v: ReservaVivaEntrada | null, updatedAt = antes(1_000)) {
  return decidirEntrada({ status, updatedAt, viva: v, agora: AGORA, leasePreEnvioMs: LEASE_PRE });
}

describe("decidirEntrada — tabela do design §4.9", () => {
  it.each([[null], [viva("RESERVADO")], [viva("INCERTO")], [viva("BLOQUEADO")], [viva("AUTORIZADO")]])(
    "AUTHORIZED com %j ⇒ REPLAY_AUTORIZADA",
    (v) => {
      expect(entrada("AUTHORIZED", v)).toMatchObject({ acao: "REPLAY_AUTORIZADA", mensagem: "NF-e já autorizada" });
    },
  );

  it.each([
    ["CANCELLED", null],
    ["CANCELLED", viva("CANCELADO")],
    ["CANCELLED", viva("BLOQUEADO")],
    ["INUTILIZED", null],
    ["INUTILIZED", viva("INUTILIZADO")],
  ])("%s com %j ⇒ DELEGAR_V1", (status, v) => {
    expect(entrada(status, v).acao).toBe("DELEGAR_V1");
  });

  it.each([
    ["DRAFT", null],
    ["DRAFT", viva("RESERVADO")],
    ["DRAFT", viva("REJEITADO")],
    ["REJECTED", null],
    ["REJECTED", viva("RESERVADO")],
    ["REJECTED", viva("REJEITADO")],
  ])("%s com %j ⇒ SEGUIR", (status, v) => {
    expect(entrada(status, v).acao).toBe("SEGUIR");
  });

  it.each([
    ["DRAFT", viva("EM_TRANSMISSAO", { leaseAte: depois(60_000) })],
    ["DRAFT", viva("EM_TRANSMISSAO", { leaseAte: antes(1) })],
    ["DRAFT", viva("INCERTO")],
    ["REJECTED", viva("INCERTO", { leaseAte: depois(60_000) })],
    ["REJECTED", viva("EM_TRANSMISSAO")],
  ])("%s com %j (só após SQL manual) ⇒ RECONCILIAR", (status, v) => {
    expect(entrada(status, v).acao).toBe("RECONCILIAR");
  });

  it.each([["DRAFT"], ["REJECTED"], ["VALIDATING"], ["SIGNING"], ["SENDING"]])("%s com BLOQUEADO ⇒ BLOQUEADA_MANUAL", (status) => {
    expect(entrada(status, viva("BLOQUEADO", { numero: 777 }))).toEqual({
      acao: "BLOQUEADA_MANUAL",
      mensagem: "Numeração nº 777 exige conferência manual",
    });
  });

  it.each([["VALIDATING"], ["SIGNING"]])("%s sem reserva ⇒ EM_ANDAMENTO (vencedor do claim ou linha antiga)", (status) => {
    expect(entrada(status, null, antes(10 * LEASE_PRE)).acao).toBe("EM_ANDAMENTO");
  });

  describe.each([["VALIDATING"], ["SIGNING"]])("%s com reserva reusável", (status) => {
    it.each([["RESERVADO"], ["REJEITADO"]])("%s travada além do lease ⇒ RETOMAR_TRAVADA (mesmo número)", (estado) => {
      const d = entrada(status, viva(estado), antes(LEASE_PRE + 1));
      expect(d.acao).toBe("RETOMAR_TRAVADA");
      expect(d.mensagem).toContain("101");
    });

    it.each([["RESERVADO"], ["REJEITADO"]])("%s recente ⇒ EM_ANDAMENTO", (estado) => {
      expect(entrada(status, viva(estado), antes(1_000)).acao).toBe("EM_ANDAMENTO");
    });

    it("exatamente no lease ainda não retoma (SQL usa updatedAt < agora − lease)", () => {
      expect(entrada(status, viva("RESERVADO"), antes(LEASE_PRE)).acao).toBe("EM_ANDAMENTO");
    });

    it("updatedAt inválido nunca retoma", () => {
      expect(entrada(status, viva("RESERVADO"), new Date("x")).acao).toBe("EM_ANDAMENTO");
    });
  });

  it("SENDING sem reserva ⇒ EM_ANDAMENTO com a mensagem de legado (decisão 3)", () => {
    expect(entrada("SENDING", null, antes(100 * LEASE_PRE))).toEqual({
      acao: "EM_ANDAMENTO",
      mensagem: "emissão anterior à numeração v2 — sem ação automática",
    });
    expect(MENSAGEM_SENDING_LEGADO).toBe("emissão anterior à numeração v2 — sem ação automática");
  });

  it.each([["RESERVADO"], ["REJEITADO"], ["DENEGADO"], ["ABANDONADO"]])(
    "SENDING com reserva %s (envio do fluxo V1) ⇒ EM_ANDAMENTO legado",
    (estado) => {
      expect(entrada("SENDING", viva(estado))).toMatchObject({ acao: "EM_ANDAMENTO", mensagem: MENSAGEM_SENDING_LEGADO });
    },
  );

  it("SENDING + EM_TRANSMISSAO com lease válido ⇒ EM_ANDAMENTO", () => {
    expect(entrada("SENDING", viva("EM_TRANSMISSAO", { leaseAte: depois(1) })).acao).toBe("EM_ANDAMENTO");
    expect(entrada("SENDING", viva("EM_TRANSMISSAO", { leaseAte: AGORA })).acao).toBe("EM_ANDAMENTO");
  });

  it("SENDING + EM_TRANSMISSAO com lease vencido ou nulo ⇒ RECONCILIAR (consulta antes de reenviar)", () => {
    expect(entrada("SENDING", viva("EM_TRANSMISSAO", { leaseAte: antes(1) })).acao).toBe("RECONCILIAR");
    expect(entrada("SENDING", viva("EM_TRANSMISSAO", { leaseAte: null })).acao).toBe("RECONCILIAR");
  });

  it("SENDING + INCERTO ⇒ RECONCILIAR (o lease é conferido pelo tomarLease)", () => {
    expect(entrada("SENDING", viva("INCERTO")).acao).toBe("RECONCILIAR");
    expect(entrada("SENDING", viva("INCERTO", { leaseAte: depois(60_000) })).acao).toBe("RECONCILIAR");
  });

  it.each([["VALIDATING"], ["SIGNING"]])("%s + INCERTO/EM_TRANSMISSAO (anomalia) segue a régua do lease", (status) => {
    expect(entrada(status, viva("INCERTO")).acao).toBe("RECONCILIAR");
    expect(entrada(status, viva("EM_TRANSMISSAO", { leaseAte: depois(1) })).acao).toBe("EM_ANDAMENTO");
    expect(entrada(status, viva("EM_TRANSMISSAO", { leaseAte: antes(1) })).acao).toBe("RECONCILIAR");
  });

  it.each([
    ["DRAFT", "AUTORIZADO"],
    ["REJECTED", "CANCELADO"],
    ["SENDING", "AUTORIZADO"],
    ["VALIDATING", "AUTORIZADO"],
  ])("%s com reserva %s (número consumido, linha fora de AUTHORIZED) ⇒ BLOQUEADA_MANUAL", (status, estado) => {
    expect(entrada(status, viva(estado)).acao).toBe("BLOQUEADA_MANUAL");
  });

  it.each([["DENEGADO"], ["INUTILIZADO"], ["CONSUMIDO_EXTERNO"], ["ABANDONADO"]])(
    "DRAFT com reserva %s (não viva) ⇒ SEGUIR (a reserva seguinte renumera)",
    (estado) => {
      expect(entrada("DRAFT", viva(estado)).acao).toBe("SEGUIR");
    },
  );

  it("status desconhecido ⇒ DELEGAR_V1", () => {
    expect(entrada("QUALQUER", viva("RESERVADO")).acao).toBe("DELEGAR_V1");
  });
});

// ─────────────────────────────── decidirPreClaim ───────────────────────────────

function reserva(extra: Partial<ReservaPreClaim> = {}): ReservaPreClaim {
  return {
    estado: "REJEITADO",
    numero: 101,
    serie: 3,
    ambiente: "PRODUCAO",
    modelo: "55",
    companyFiscalConfigId: "cfg_a",
    bloqueadoAte: null,
    ...extra,
  };
}

const KEY = { cfc: "cfg_a", ambiente: "PRODUCAO", modelo: "55", serie: 3 };
const SHA = "a".repeat(64);

function pre(p: Partial<Parameters<typeof decidirPreClaim>[0]> = {}) {
  return decidirPreClaim({
    viva: reserva(),
    key: KEY,
    conteudoSha256: SHA,
    ultimaTentativa: null,
    confirmarDescarte: false,
    agora: AGORA,
    cooldownMs: 60_000,
    ...p,
  });
}

describe("decidirPreClaim", () => {
  it("sem reserva ⇒ SEGUIR", () => {
    expect(pre({ viva: null })).toEqual({ acao: "SEGUIR", troca: null });
  });

  it("mesma chave, sem tentativa ⇒ SEGUIR", () => {
    expect(pre()).toEqual({ acao: "SEGUIR", troca: null });
  });

  it.each([
    [{ serie: 1 }, "SERIE"],
    [{ cfc: "cfg_b" }, "EMITENTE"],
    [{ modelo: "65" }, "MODELO"],
    [{ ambiente: "HOMOLOGACAO" }, "AMBIENTE"],
  ])("troca %j com nº antigo em PRODUÇÃO sem confirmação ⇒ CONFIRMAR_DESCARTE (%s)", (mudanca, motivo) => {
    expect(pre({ key: { ...KEY, ...mudanca } })).toEqual({
      acao: "CONFIRMAR_DESCARTE",
      mensagem: "O nº 101 (série 3) ficará sem uso e precisará ser inutilizado",
      detalhes: { numero: 101, serie: 3, motivo },
    });
  });

  it("troca confirmada em PRODUÇÃO ⇒ SEGUIR com o motivo", () => {
    expect(pre({ key: { ...KEY, serie: 1 }, confirmarDescarte: true })).toEqual({ acao: "SEGUIR", troca: "SERIE" });
  });

  it("nº antigo em HOMOLOGAÇÃO ⇒ troca automática, sem confirmação", () => {
    expect(pre({ viva: reserva({ ambiente: "HOMOLOGACAO" }), key: { ...KEY, ambiente: "PRODUCAO" } })).toEqual({
      acao: "SEGUIR",
      troca: "AMBIENTE",
    });
  });

  it("troca de chave prevalece sobre cooldown (a espera era do número antigo)", () => {
    expect(
      pre({
        viva: reserva({ bloqueadoAte: depois(60_000) }),
        key: { ...KEY, serie: 9 },
        confirmarDescarte: true,
      }),
    ).toEqual({ acao: "SEGUIR", troca: "SERIE" });
  });

  it.each([["INCERTO"], ["EM_TRANSMISSAO"], ["BLOQUEADO"], ["AUTORIZADO"]])(
    "reserva %s não é assunto do pré-claim ⇒ SEGUIR",
    (estado) => {
      expect(pre({ viva: reserva({ estado, bloqueadoAte: depois(60_000) }), key: { ...KEY, serie: 9 } })).toEqual({
        acao: "SEGUIR",
        troca: null,
      });
    },
  );

  it("bloqueadoAte no futuro (656/429) ⇒ COOLDOWN com a espera restante", () => {
    const d = pre({ viva: reserva({ bloqueadoAte: depois(90_000) }) });
    expect(d).toMatchObject({ acao: "COOLDOWN", retryAposMs: 90_000, numero: 101 });
    if (d.acao === "COOLDOWN") {
      expect(d.mensagem).toContain("2 min");
      expect(d.mensagem).toContain("nº 101");
    }
  });

  it("bloqueadoAte vencido ⇒ SEGUIR", () => {
    expect(pre({ viva: reserva({ bloqueadoAte: antes(1) }) }).acao).toBe("SEGUIR");
    expect(pre({ viva: reserva({ bloqueadoAte: AGORA }) }).acao).toBe("SEGUIR");
  });

  describe("L1 — mesmo conteúdo recusado há pouco", () => {
    const tentativa = (extra: Record<string, unknown> = {}) => ({
      conteudoSha256: SHA,
      classe: "REJEICAO",
      transmitidaEm: antes(40_000),
      respondidaEm: antes(30_000),
      ...extra,
    });

    it.each([["REJEICAO"], ["PRE_ENVIO_PROVEDOR"]])("%s há 30 s ⇒ COOLDOWN", (classe) => {
      const d = pre({ ultimaTentativa: tentativa({ classe }) });
      expect(d).toMatchObject({ acao: "COOLDOWN", retryAposMs: 30_000 });
      if (d.acao === "COOLDOWN") expect(d.mensagem).toContain("30 s");
    });

    it("exatamente 60 s ⇒ SEGUIR (reenvio idêntico permitido)", () => {
      expect(pre({ ultimaTentativa: tentativa({ respondidaEm: antes(60_000) }) }).acao).toBe("SEGUIR");
    });

    it("conteúdo diferente ⇒ SEGUIR", () => {
      expect(pre({ ultimaTentativa: tentativa({ conteudoSha256: "b".repeat(64) }) }).acao).toBe("SEGUIR");
    });

    it.each([["DENEGADA"], ["SERVICO_INDISPONIVEL"], ["INCERTO_TRANSPORTE"], [null]])("classe %j ⇒ SEGUIR", (classe) => {
      expect(pre({ ultimaTentativa: tentativa({ classe }) }).acao).toBe("SEGUIR");
    });

    it("sem respondidaEm usa transmitidaEm", () => {
      expect(pre({ ultimaTentativa: tentativa({ respondidaEm: null, transmitidaEm: antes(10_000) }) })).toMatchObject({
        acao: "COOLDOWN",
        retryAposMs: 50_000,
      });
    });

    it("cooldown desligado (0) ⇒ SEGUIR", () => {
      expect(pre({ ultimaTentativa: tentativa(), cooldownMs: 0 }).acao).toBe("SEGUIR");
    });
  });

  it("motivoTrocaChave", () => {
    expect(motivoTrocaChave(reserva(), KEY)).toBeNull();
    expect(motivoTrocaChave(reserva({ serie: "3" as unknown as number }), KEY)).toBeNull();
    expect(motivoTrocaChave(reserva(), { ...KEY, serie: 4 })).toBe("SERIE");
  });
});

// ─────────────────────────────── decidirAdocaoLegado ───────────────────────────────

const NUMERADA: EventoTrilha = { evento: "NUMERADA", detalhes: { numero: 101, serie: 3 } };
const ENVIADA_SEFAZ: EventoTrilha = { evento: "ENVIADA", detalhes: { providerName: "SEFAZ_DIRECT" } };
const ENVIADA_FOCUS: EventoTrilha = { evento: "ENVIADA", detalhes: { providerName: "FOCUS_NFE" } };
const REJEITADA: EventoTrilha = { evento: "REJEITADA", detalhes: { mensagem: "Rejeicao" } };
const ERRO_LOCAL: EventoTrilha = {
  evento: "EDITADA_DRAFT",
  detalhes: { motivo: "Erro antes do envio - retornado a rascunho", erro: "codMunicipio ausente" },
};

function adocao(p: {
  row?: Partial<EntradaAdocaoLegado["row"]>;
  providerName?: string | null;
  trilha?: EventoTrilha[] | null;
  proximoNumero?: number;
  ocupacao?: Partial<EntradaAdocaoLegado["ocupacao"]>;
}) {
  return decidirAdocaoLegado({
    row: { numero: 101, serie: 3, status: "REJECTED", cStatRejeicao: null, ...p.row },
    providerName: p.providerName === undefined ? "SEFAZ_DIRECT" : p.providerName,
    trilha: p.trilha === undefined ? [NUMERADA, ERRO_LOCAL] : p.trilha,
    proximoNumero: p.proximoNumero ?? 102,
    ocupacao: { inutilizado: false, reservado: false, emNota: false, ...p.ocupacao },
  });
}

describe("decidirAdocaoLegado — design §4.5", () => {
  it("evidência A: erro antes do envio, sem ENVIADA ⇒ RESERVADO", () => {
    expect(adocao({ row: { status: "DRAFT" } })).toEqual({ adotar: true, estado: "RESERVADO", evidencia: "NUNCA_TRANSMITIDO" });
  });

  it.each([[225], [974], [999], [704]])("evidência B: SEFAZ direto rejeitou com %i ⇒ REJEITADO", (c) => {
    expect(adocao({ row: { cStatRejeicao: c }, trilha: [NUMERADA, ENVIADA_SEFAZ, REJEITADA] })).toEqual({
      adotar: true,
      estado: "REJEITADO",
      evidencia: "REJEICAO_SEFAZ",
    });
  });

  it("evidência B vale para linha que o wizard voltou a DRAFT (cStat sobrevive)", () => {
    expect(
      adocao({ row: { status: "DRAFT", cStatRejeicao: 225 }, trilha: [NUMERADA, ENVIADA_SEFAZ, REJEITADA, { evento: "EDITADA_DRAFT", detalhes: {} }] }),
    ).toMatchObject({ adotar: true, estado: "REJEITADO" });
  });

  it.each([["FOCUS_NFE"], [null], ["MOCK"]])("provedor %j ⇒ recusa FOCUS_NUMERO_FICTICIO (mesmo com evidência)", (provider) => {
    expect(adocao({ providerName: provider })).toEqual({ adotar: false, motivo: "FOCUS_NUMERO_FICTICIO" });
  });

  it.each([["SENDING"], ["AUTHORIZED"], ["VALIDATING"], ["CANCELLED"]])("status %s ⇒ STATUS_INELEGIVEL", (status) => {
    expect(adocao({ row: { status } })).toEqual({ adotar: false, motivo: "STATUS_INELEGIVEL" });
  });

  it.each([[0], [-3]])("número %i (placeholder) ⇒ SEM_NUMERO", (numero) => {
    expect(adocao({ row: { numero } })).toEqual({ adotar: false, motivo: "SEM_NUMERO" });
  });

  it.each([[101], [100]])("número ≥ contador (%i) ⇒ NUMERO_NAO_ABAIXO_DO_CONTADOR", (proximo) => {
    expect(adocao({ proximoNumero: proximo })).toEqual({ adotar: false, motivo: "NUMERO_NAO_ABAIXO_DO_CONTADOR" });
  });

  it("número inutilizado ⇒ recusa", () => {
    expect(adocao({ ocupacao: { inutilizado: true } })).toEqual({ adotar: false, motivo: "NUMERO_INUTILIZADO" });
  });

  it("número já reservado ⇒ recusa", () => {
    expect(adocao({ ocupacao: { reservado: true } })).toEqual({ adotar: false, motivo: "NUMERO_RESERVADO" });
  });

  it("número em outra nota ⇒ recusa", () => {
    expect(adocao({ ocupacao: { emNota: true } })).toEqual({ adotar: false, motivo: "NUMERO_EM_OUTRA_NOTA" });
  });

  it.each([
    ["trilha nula", null],
    ["trilha vazia", []],
    ["NUMERADA de outro número", [{ evento: "NUMERADA", detalhes: { numero: 100, serie: 3 } }, ERRO_LOCAL]],
    ["NUMERADA de outra série", [{ evento: "NUMERADA", detalhes: { numero: 101, serie: 1 } }, ERRO_LOCAL]],
    ["NUMERADA sem detalhes", [{ evento: "NUMERADA" }, ERRO_LOCAL]],
  ])("%s ⇒ SEM_TRILHA", (_r, trilha) => {
    expect(adocao({ trilha: trilha as EventoTrilha[] | null })).toEqual({ adotar: false, motivo: "SEM_TRILHA" });
  });

  it.each([
    ["ENVIO_INCERTO (linhas B6)", { evento: "ENVIO_INCERTO", detalhes: {} }],
    ["AUTORIZADA", { evento: "AUTORIZADA", detalhes: {} }],
    ["CONTINGENCIA_SVC", { evento: "CONTINGENCIA_SVC", detalhes: {} }],
    ["CONTINGENCIA_CONSULTA", { evento: "CONTINGENCIA_CONSULTA", detalhes: {} }],
    ["NUMERADA posterior com outro número", { evento: "NUMERADA", detalhes: { numero: 102, serie: 3 } }],
  ])("%s depois da última NUMERADA ⇒ TRILHA_INCERTA", (_r, ev) => {
    expect(adocao({ row: { cStatRejeicao: 225 }, trilha: [NUMERADA, ENVIADA_SEFAZ, ev as EventoTrilha, REJEITADA] })).toEqual({
      adotar: false,
      motivo: "TRILHA_INCERTA",
    });
  });

  it("evento incerto ANTES da última NUMERADA do mesmo número não conta", () => {
    expect(
      adocao({
        trilha: [
          { evento: "NUMERADA", detalhes: { numero: 101, serie: 3 } },
          { evento: "ENVIO_INCERTO", detalhes: {} },
          NUMERADA,
          ERRO_LOCAL,
        ],
      }),
    ).toMatchObject({ adotar: true, estado: "RESERVADO" });
  });

  it.each([[205], [204], [206], [218], [539], [562], [613], [635], [110], [301], [302], [303], [108]])(
    "cStat %i não é rejeição comum ⇒ SEM_EVIDENCIA",
    (c) => {
      expect(adocao({ row: { cStatRejeicao: c }, trilha: [NUMERADA, ENVIADA_SEFAZ, REJEITADA] })).toEqual({
        adotar: false,
        motivo: "SEM_EVIDENCIA",
      });
    },
  );

  it("REJEITADA sem cStat ⇒ SEM_EVIDENCIA", () => {
    expect(adocao({ row: { cStatRejeicao: null }, trilha: [NUMERADA, ENVIADA_SEFAZ, REJEITADA] })).toEqual({
      adotar: false,
      motivo: "SEM_EVIDENCIA",
    });
  });

  it("envio pela Focus seguido de rejeição ⇒ SEM_EVIDENCIA", () => {
    expect(adocao({ row: { cStatRejeicao: 225 }, trilha: [NUMERADA, ENVIADA_FOCUS, REJEITADA] })).toEqual({
      adotar: false,
      motivo: "SEM_EVIDENCIA",
    });
  });

  it("ENVIADA sem REJEITADA depois ⇒ SEM_EVIDENCIA", () => {
    expect(adocao({ row: { cStatRejeicao: 225 }, trilha: [NUMERADA, REJEITADA, ENVIADA_SEFAZ] })).toEqual({
      adotar: false,
      motivo: "SEM_EVIDENCIA",
    });
  });

  it("erro local COM ENVIADA não é evidência A", () => {
    expect(adocao({ row: { cStatRejeicao: null }, trilha: [NUMERADA, ERRO_LOCAL, ENVIADA_SEFAZ] })).toEqual({
      adotar: false,
      motivo: "SEM_EVIDENCIA",
    });
  });

  it("EDITADA_DRAFT de edição comum (sem 'Erro antes do envio') ⇒ SEM_EVIDENCIA", () => {
    expect(adocao({ trilha: [NUMERADA, { evento: "EDITADA_DRAFT", detalhes: { motivo: "Edição do wizard" } }] })).toEqual({
      adotar: false,
      motivo: "SEM_EVIDENCIA",
    });
  });

  it("detalhes com número em texto casam pelo valor", () => {
    expect(adocao({ trilha: [{ evento: "NUMERADA", detalhes: { numero: "101", serie: "3" } }, ERRO_LOCAL] })).toMatchObject({
      adotar: true,
    });
  });

  it("trilha datada é reordenada por createdAt", () => {
    const t = (ev: EventoTrilha, s: number): EventoTrilha => ({ ...ev, createdAt: new Date(AGORA.getTime() + s * 1000) });
    expect(
      adocao({
        row: { cStatRejeicao: 225 },
        trilha: [t(REJEITADA, 3), t(NUMERADA, 1), t(ENVIADA_SEFAZ, 2)],
      }),
    ).toMatchObject({ adotar: true, estado: "REJEITADO" });
  });
});

// ─────────────────────────────── decidirReadbackFocus ───────────────────────────────

const CNPJ = "11386276000176";

function chave(p: { cnpj?: string; mod?: string; serie?: number; nNF?: number; cUF?: string } = {}): string {
  const base =
    (p.cUF ?? "41") +
    "2609" +
    (p.cnpj ?? CNPJ) +
    (p.mod ?? "55") +
    String(p.serie ?? 3).padStart(3, "0") +
    String(p.nNF ?? 101).padStart(9, "0") +
    "1" +
    "12345678";
  return base + calcularDV(base);
}

function readback(p: Partial<Parameters<typeof decidirReadbackFocus>[0]> = {}) {
  return decidirReadbackFocus({
    reservado: { numero: 101, serie: 3 },
    chave44: chave(),
    cnpjConfig: CNPJ,
    modelo: "55",
    ...p,
  });
}

describe("decidirReadbackFocus", () => {
  it("nº e série iguais ⇒ IGUAL", () => {
    expect(readback()).toEqual({ resultado: "IGUAL", numero: 101, serie: 3 });
  });

  it("nNF divergente (Focus numerou sozinha: 12 no banco × 3 na chave) ⇒ DIVERGENTE com o nº real", () => {
    expect(readback({ reservado: { numero: 12, serie: 3 }, chave44: chave({ nNF: 3 }) })).toEqual({
      resultado: "DIVERGENTE",
      numero: 3,
      serie: 3,
    });
  });

  it("só a série diverge ⇒ DIVERGENTE", () => {
    expect(readback({ chave44: chave({ serie: 1 }) })).toEqual({ resultado: "DIVERGENTE", numero: 101, serie: 1 });
  });

  it("prefixo NFe (47 caracteres) é aceito", () => {
    expect(readback({ chave44: `NFe${chave()}` })).toMatchObject({ resultado: "IGUAL" });
  });

  it("CNPJ da config formatado casa pelos dígitos", () => {
    expect(readback({ cnpjConfig: "11.386.276/0001-76" })).toMatchObject({ resultado: "IGUAL" });
  });

  it("emitente CPF (11 dígitos) casa com 000+CPF na chave", () => {
    const cpf = "12345678909";
    expect(readback({ cnpjConfig: cpf, chave44: chave({ cnpj: `000${cpf}` }) })).toMatchObject({ resultado: "IGUAL" });
  });

  it.each([
    ["curta", "4126091138627600017655003000000101112345678"],
    ["vazia", ""],
    ["nula", null],
    ["DV errado", chave().slice(0, 43) + String((Number(chave().slice(43)) + 1) % 10)],
    ["nNF zero", chave({ nNF: 0 })],
  ])("chave %s ⇒ INCONSISTENTE CHAVE_INVALIDA", (_r, c) => {
    expect(readback({ chave44: c as string | null })).toEqual({ resultado: "INCONSISTENTE", motivo: "CHAVE_INVALIDA" });
  });

  it.each([["CNPJ de outra empresa", "07504505000132"], ["CNPJ nulo", null], ["CNPJ incompleto", "1138627600017"]])(
    "%s ⇒ INCONSISTENTE CNPJ_DIVERGENTE",
    (_r, cnpj) => {
      expect(readback({ cnpjConfig: cnpj })).toEqual({ resultado: "INCONSISTENTE", motivo: "CNPJ_DIVERGENTE" });
    },
  );

  it("modelo da chave ≠ modelo da config ⇒ INCONSISTENTE MODELO_DIVERGENTE", () => {
    expect(readback({ chave44: chave({ mod: "65" }) })).toEqual({ resultado: "INCONSISTENTE", motivo: "MODELO_DIVERGENTE" });
    expect(readback({ modelo: "65" })).toEqual({ resultado: "INCONSISTENTE", motivo: "MODELO_DIVERGENTE" });
  });

  it("parser local concorda com parseChave de chave-acesso.ts", () => {
    for (const nNF of [1, 3, 101, 999_999_999]) {
      for (const serie of [0, 3, 999]) {
        const c = chave({ nNF, serie, cUF: "35" });
        const { cDV, ...oficial } = parseChave(c);
        expect(partesDaChave(c)).toEqual({ ...oficial, cDV });
      }
    }
  });

  it("decisao.ts não importa chave-acesso.ts", () => {
    const fonte = readFileSync(path.resolve(__dirname, "../../../app/fiscal/numeracao/decisao.ts"), "utf8");
    expect(fonte).not.toMatch(/from\s+["'][^"']*chave-acesso["']/);
  });
});

// ─────────────────────────────── avaliarFaixa ───────────────────────────────

describe("avaliarFaixa — guarda da inutilização V2", () => {
  it("faixa livre (só ABANDONADO e INUTILIZED) ⇒ ok", () => {
    expect(
      avaliarFaixa({
        linhas: [{ id: "n1", numero: 101, status: "INUTILIZED" }],
        reservas: [{ numero: 101, estado: "ABANDONADO" }],
        ini: 100,
        fim: 105,
      }),
    ).toEqual({ ok: true, acao: "SEGUIR", bloqueios: [], descartes: [] });
  });

  // Documento fiscal emitido ou em emissão: número que pode estar (ou vai estar) na SEFAZ.
  it.each([["AUTHORIZED"], ["CANCELLED"], ["SENDING"], ["VALIDATING"], ["SIGNING"], ["STATUS_NOVO"]])(
    "linha %s com número na faixa ⇒ bloqueia (mesmo com o descarte confirmado)",
    (status) => {
      for (const confirmarDescarte of [false, true]) {
        const r = avaliarFaixa({ linhas: [{ id: "nota_x", numero: 101, status }], reservas: [], ini: 101, fim: 101, confirmarDescarte });
        expect(r.ok).toBe(false);
        expect(r.acao).toBe("BLOQUEAR");
        expect(r.bloqueios).toHaveLength(1);
        expect(r.bloqueios[0]).toMatchObject({ numero: 101, nfeId: "nota_x" });
        expect(r.bloqueios[0].motivo).toContain("nº 101");
      }
    },
  );

  // BLOQ-1: 3 das 9 inutilizações ACEITAS em produção cobriram nº preso em nota REJECTED do V1
  // (Mesquita série 4 nº 1-2 e série 2 nº 99; Centro Jotabê série 4 nº 92-95). O V1 inutiliza
  // e deixa a linha como está; a V2 recusava ("exclua o rascunho" — botão que a tela não tem).
  it.each([["DRAFT"], ["REJECTED"]])(
    "linha %s legada (sem reserva viva no número) ⇒ não bloqueia, sem pedir confirmação",
    (status) => {
      const r = avaliarFaixa({ linhas: [{ id: "legado_v1", numero: 101, status }], reservas: [], ini: 100, fim: 101 });
      expect(r).toEqual({ ok: true, acao: "SEGUIR", bloqueios: [], descartes: [] });
    },
  );

  it("nenhum motivo manda excluir rascunho (a tela não tem esse botão para NF-e comum)", () => {
    const r = avaliarFaixa({
      linhas: [
        { id: "rasc_1", numero: 101, status: "DRAFT" },
        { id: "rej_1", numero: 102, status: "REJECTED" },
        { id: "env_1", numero: 103, status: "SENDING" },
      ],
      reservas: [{ numero: 101, estado: "EM_TRANSMISSAO", nfeId: "rasc_1" }],
      ini: 100,
      fim: 105,
    });
    expect(r.acao).toBe("BLOQUEAR");
    expect(r.bloqueios.map((b) => b.numero)).toEqual([101, 103]);
    for (const b of r.bloqueios) expect(b.motivo).not.toMatch(/exclua|excluir/i);
  });

  it.each([
    ["EM_TRANSMISSAO"],
    ["INCERTO"],
    ["AUTORIZADO"],
    ["CANCELADO"],
    ["DENEGADO"],
    ["INUTILIZADO"],
    ["CONSUMIDO_EXTERNO"],
  ])("reserva %s na faixa ⇒ bloqueia (confirmar o descarte não abre atalho)", (estado) => {
    for (const confirmarDescarte of [false, true]) {
      const r = avaliarFaixa({ linhas: [], reservas: [{ numero: 103, estado }], ini: 100, fim: 110, confirmarDescarte });
      expect(r.ok).toBe(false);
      expect(r.acao).toBe("BLOQUEAR");
      expect(r.bloqueios[0].numero).toBe(103);
      expect(r.bloqueios[0].motivo).toContain(estado);
      expect(r.descartes).toEqual([]);
    }
  });

  it.each([["RESERVADO"], ["REJEITADO"], ["BLOQUEADO"]])(
    "reserva %s sem confirmação ⇒ CONFIRMAR_DESCARTE (não é número vivo na SEFAZ)",
    (estado) => {
      const r = avaliarFaixa({
        linhas: [{ id: "nota_r", numero: 103, status: "REJECTED" }],
        reservas: [{ id: "res_1", numero: 103, estado, nfeId: "nota_r" }],
        ini: 100,
        fim: 110,
      });
      expect(r.ok).toBe(false);
      expect(r.acao).toBe("CONFIRMAR_DESCARTE");
      expect(r.bloqueios).toEqual([]);
      expect(r.descartes).toEqual([{ numero: 103, estado, reservaId: "res_1", nfeId: "nota_r" }]);
    },
  );

  it.each([["RESERVADO"], ["REJEITADO"], ["BLOQUEADO"]])(
    "reserva %s COM confirmação ⇒ SEGUIR, e a reserva vem listada para o descarte",
    (estado) => {
      const r = avaliarFaixa({
        linhas: [{ id: "nota_r", numero: 103, status: "DRAFT" }],
        reservas: [{ id: "res_1", numero: 103, estado, nfeId: "nota_r" }],
        ini: 100,
        fim: 110,
        confirmarDescarte: true,
      });
      expect(r).toEqual({ ok: true, acao: "SEGUIR", bloqueios: [], descartes: [{ numero: 103, estado, reservaId: "res_1", nfeId: "nota_r" }] });
    },
  );

  it("bloqueio prevalece sobre descarte: reserva RESERVADO com a nota em emissão (VALIDATING) não é descartável", () => {
    // Emissão em curso (claim feito, reserva RESERVADO, envio a seguir): descartar o número
    // agora deixaria a nota VALIDATING sem reserva — travada para sempre.
    const r = avaliarFaixa({
      linhas: [{ id: "em_curso", numero: 103, status: "VALIDATING" }],
      reservas: [{ id: "res_1", numero: 103, estado: "RESERVADO", nfeId: "em_curso" }],
      ini: 103,
      fim: 103,
      confirmarDescarte: true,
    });
    expect(r.ok).toBe(false);
    expect(r.acao).toBe("BLOQUEAR");
    expect(r.bloqueios.map((b) => b.numero)).toEqual([103]);
  });

  it("fora da faixa não bloqueia (bordas inclusivas)", () => {
    const r = avaliarFaixa({
      linhas: [
        { id: "a", numero: 99, status: "AUTHORIZED" },
        { id: "b", numero: 100, status: "AUTHORIZED" },
        { id: "c", numero: 110, status: "SIGNING" },
        { id: "d", numero: 111, status: "SIGNING" },
      ],
      reservas: [
        { numero: 99, estado: "INCERTO" },
        { numero: 111, estado: "INCERTO" },
        { numero: 99, estado: "REJEITADO" },
        { numero: 111, estado: "RESERVADO" },
      ],
      ini: 100,
      fim: 110,
    });
    expect(r.bloqueios.map((b) => b.numero)).toEqual([100, 110]);
    expect(r.descartes).toEqual([]);
  });

  it("bloqueios e descartes em ordem de número", () => {
    const r = avaliarFaixa({
      linhas: [{ id: "z", numero: 105, status: "SENDING" }],
      reservas: [
        { numero: 107, estado: "CONSUMIDO_EXTERNO" },
        { numero: 101, estado: "INCERTO" },
        { numero: 109, estado: "REJEITADO" },
        { numero: 102, estado: "BLOQUEADO" },
      ],
      ini: 100,
      fim: 110,
    });
    expect(r.bloqueios.map((b) => b.numero)).toEqual([101, 105, 107]);
    expect(r.descartes.map((d) => d.numero)).toEqual([102, 109]);
  });

  it.each([
    [0, 5],
    [10, 9],
    [1.5, 3],
    [NaN, 3],
  ])("faixa inválida (%s–%s) ⇒ não ok", (ini, fim) => {
    expect(avaliarFaixa({ linhas: [], reservas: [], ini, fim }).ok).toBe(false);
  });

  it("mensagemBloqueiosFaixa lista até 10 e conta o resto", () => {
    const bloqueios = Array.from({ length: 13 }, (_, i) => ({ numero: 100 + i, motivo: `nº ${100 + i} ocupado` }));
    const m = mensagemBloqueiosFaixa(bloqueios);
    expect(m).toContain("nº 109 ocupado");
    expect(m).not.toContain("nº 110 ocupado");
    expect(m).toMatch(/e mais 3$/);
    expect(mensagemBloqueiosFaixa(bloqueios.slice(0, 2))).toBe("nº 100 ocupado; nº 101 ocupado");
  });

  it("mensagemDescarteFaixa: um número reservado — diz o que acontece com a nota, sem mandar excluir", () => {
    const m = mensagemDescarteFaixa([{ numero: 7, estado: "REJEITADO" }], 1);
    expect(m).toContain("nº 7");
    expect(m).toContain("série 1");
    expect(m).toContain("rascunho");
    expect(m).toContain("número novo");
    expect(m).not.toMatch(/exclua|excluir/i);
    expect(m).not.toContain("NÃO foi autorizado");
  });

  it("mensagemDescarteFaixa: com BLOQUEADO, pede confirmar que o número NÃO foi autorizado na SEFAZ", () => {
    const um = mensagemDescarteFaixa([{ numero: 7, estado: "RESERVADO" }, { numero: 9, estado: "BLOQUEADO" }], 2);
    expect(um).toContain("7, 9");
    expect(um).toContain("série 2");
    expect(um).toContain("nº 9 está retido para conferência");
    expect(um).toContain("NÃO foi autorizado na SEFAZ");
    const dois = mensagemDescarteFaixa([{ numero: 9, estado: "BLOQUEADO" }, { numero: 11, estado: "BLOQUEADO" }], 2);
    expect(dois).toContain("nºs 9, 11 estão retidos para conferência");
    expect(dois).toContain("NÃO foram autorizados na SEFAZ");
  });
});

// ─────────────────────────────── hashConteudo ───────────────────────────────

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("hashConteudo", () => {
  const draft = {
    id: "nfe_1",
    status: "REJECTED",
    numero: 101,
    chaveAcesso: "4126...",
    createdAt: new Date("2026-09-01T10:00:00Z"),
    updatedAt: new Date("2026-09-17T10:00:00Z"),
    dataEmissao: new Date("2026-09-17T10:00:00Z"),
    motivoRejeicao: "Rejeicao 225",
    cStatRejeicao: 225,
    serie: 3,
    naturezaOperacao: "VENDA",
    destinatarioJson: { nome: "Cliente", documento: "12345678909" },
    itens: [
      { id: "item_a", numero: 1, codigo: "P1", quantidade: 2, valorUnitario: 10.5 },
      { id: "item_b", numero: 2, codigo: "P2", quantidade: 1, valorUnitario: 3 },
    ],
  };

  it("sha256 hex de 64 caracteres, determinístico", () => {
    const h = hashConteudo(draft);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashConteudo(draft)).toBe(h);
  });

  it("forma canônica conhecida", () => {
    expect(hashConteudo({})).toBe(sha256("{}"));
    expect(hashConteudo({ b: 1, a: "x", id: "ignorado" })).toBe(sha256('{"a":"x","b":1}'));
    expect(hashConteudo(null)).toBe(sha256("null"));
  });

  it("ignora exatamente as chaves de identidade/tempo/resultado", () => {
    expect([...CHAVES_IGNORADAS_HASH].sort()).toEqual(
      ["cStatRejeicao", "chaveAcesso", "createdAt", "dataEmissao", "id", "motivoRejeicao", "numero", "status", "updatedAt"].sort(),
    );
    const outraTentativa = {
      ...draft,
      id: "nfe_2",
      status: "DRAFT",
      numero: 102,
      chaveAcesso: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      dataEmissao: new Date(),
      motivoRejeicao: null,
      cStatRejeicao: null,
    };
    expect(hashConteudo(outraTentativa)).toBe(hashConteudo(draft));
  });

  it("ids/números de ITENS regravados pelo updateDraft não mudam o hash", () => {
    const regravado = {
      ...draft,
      itens: draft.itens.map((it, i) => ({ ...it, id: `novo_${i}`, numero: i + 10, createdAt: new Date() })),
    };
    expect(hashConteudo(regravado)).toBe(hashConteudo(draft));
  });

  it("ordem das chaves não importa", () => {
    const invertido = Object.fromEntries(Object.entries(draft).reverse());
    expect(hashConteudo(invertido)).toBe(hashConteudo(draft));
  });

  it.each([
    ["valor de item", { ...draft, itens: [{ ...draft.itens[0], valorUnitario: 10.51 }, draft.itens[1]] }],
    ["ordem dos itens", { ...draft, itens: [draft.itens[1], draft.itens[0]] }],
    ["série", { ...draft, serie: 1 }],
    ["destinatário", { ...draft, destinatarioJson: { ...draft.destinatarioJson, nome: "Outro" } }],
    ["campo novo", { ...draft, informacoesComplementares: "obs" }],
  ])("mudança de conteúdo (%s) muda o hash", (_r, alterado) => {
    expect(hashConteudo(alterado)).not.toBe(hashConteudo(draft));
  });

  it("undefined é omitido como no JSON; null não", () => {
    expect(hashConteudo({ a: 1, b: undefined })).toBe(hashConteudo({ a: 1 }));
    expect(hashConteudo({ a: 1, b: null })).not.toBe(hashConteudo({ a: 1 }));
  });

  it("Date e objetos com toJSON (Decimal do Prisma) serializam como no JSON", () => {
    const d = new Date("2026-09-17T12:00:00.000Z");
    expect(hashConteudo({ vencimento: d })).toBe(hashConteudo({ vencimento: d.toISOString() }));
    const decimal = { toJSON: () => "10.50", interno: [1, 2] };
    expect(hashConteudo({ valor: decimal })).toBe(hashConteudo({ valor: "10.50" }));
  });

  it("NaN/Infinity viram null; bigint vira texto", () => {
    expect(hashConteudo({ a: NaN })).toBe(hashConteudo({ a: null }));
    expect(hashConteudo({ a: BigInt(5) })).toBe(hashConteudo({ a: "5" }));
  });

  it("referência compartilhada não é tratada como ciclo; ciclo não lança", () => {
    const comum = { x: 1 };
    expect(hashConteudo({ a: comum, b: comum })).toBe(hashConteudo({ a: { x: 1 }, b: { x: 1 } }));
    const ciclico: Record<string, unknown> = { a: 1 };
    ciclico.self = ciclico;
    expect(() => hashConteudo(ciclico)).not.toThrow();
    expect(hashConteudo(ciclico)).toMatch(/^[0-9a-f]{64}$/);
  });
});
