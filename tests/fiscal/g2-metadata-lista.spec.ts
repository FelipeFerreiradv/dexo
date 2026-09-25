/**
 * `attachFiscalLista` — as chaves que a lista e a ficha leem da numeração V2.
 *
 * A2: quando a config entra na V2, a nota V1 REJECTED perdia o "Tentar novamente":
 * toda linha elegível recebia `numeracao:null` (a linha V1 nunca teve reserva), e a
 * tela lê null como "nº consumido". Agora a chave `numeracao` só vai na linha que tem
 * QUALQUER reserva no ledger; a elegível sem nenhuma ganha `legadoV1:true` e volta à
 * regra do V1 (flag + cStat). Reserva ABANDONADO/CONSUMIDO_EXTERNO segue `numeracao:null`.
 *
 * B8: VALIDATING/SIGNING travada antes do envio (lease vencido) ganha `retomavel:true`
 * pela MESMA decisão do orquestrador (`decidirEntrada` ⇒ RETOMAR_TRAVADA).
 *
 * Egress: consulta nova só pelos ids da página que precisam dela, com colunas explícitas;
 * config fora da V2 não paga consulta nenhuma a mais.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ReservaFake = { nfeId: string; estado: string; numero: number; serie: number; leaseAte: Date | null };
const h = vi.hoisted(() => ({
  configs: [] as Array<{ id: string; providerName: string; isDefault: boolean; temToken: boolean }>,
  reservas: [] as Array<{ nfeId: string; estado: string; numero: number; serie: number; leaseAte: Date | null }>,
  atualizadas: new Map<string, Date>(),
  consultas: [] as Array<{ sql: string; args: unknown[] }>,
  ausente: false,
}));
const VIVOS = ["RESERVADO", "REJEITADO", "EM_TRANSMISSAO", "INCERTO", "BLOQUEADO", "AUTORIZADO", "CANCELADO"];
vi.mock("../../app/lib/prisma", () => ({
  default: {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      h.consultas.push({ sql, args });
      if (sql.includes(`FROM "CompanyFiscalConfig"`)) return h.configs;
      if (sql.includes(`FROM "NfeNumeroReserva"`)) {
        if (h.ausente) throw Object.assign(new Error("relation does not exist"), { code: "P2021" });
        const ids = args[1] as string[];
        const daPagina = h.reservas.filter((r) => ids.includes(r.nfeId));
        // A consulta de antes (reserva viva) filtra por estado; a nova (A2) não.
        return sql.includes(`"estado" IN`) ? daPagina.filter((r) => VIVOS.includes(r.estado)) : [...new Set(daPagina.map((r) => r.nfeId))].map((nfeId) => ({ nfeId }));
      }
      if (sql.includes(`FROM "NfeEmitida"`) && sql.includes(`"updatedAt"`)) {
        return (args[1] as string[]).filter((id) => h.atualizadas.has(id)).map((id) => ({ id, updatedAt: h.atualizadas.get(id) }));
      }
      throw new Error("consulta inesperada: " + sql);
    },
  },
}));

import { attachFiscalLista } from "../../app/fiscal/numeracao/metadata";

const CFC = "cfg-sefaz";
const CFC_V1 = "cfg-fora-da-v2";
const MIN = 60_000;

beforeEach(() => {
  vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", "true");
  vi.stubEnv("NFE_NUMERACAO_V2_CONFIG_IDS", CFC);
  vi.stubEnv("NFE_NUMERACAO_V2_MODELOS", "55");
  vi.stubEnv("NFE_DEVOLUCAO_ENABLED", "false");
  vi.stubEnv("NFE_NUMERACAO_V2_LEASE_PRE_ENVIO_MS", String(10 * MIN));
  h.configs = [
    { id: CFC, providerName: "SEFAZ_DIRECT", isDefault: true, temToken: false },
    { id: CFC_V1, providerName: "SEFAZ_DIRECT", isDefault: false, temToken: false },
  ];
  h.reservas = [];
  h.atualizadas = new Map();
  h.consultas = [];
  h.ausente = false;
});
afterEach(() => { vi.unstubAllEnvs(); });

const nota = (id: string, over: Record<string, unknown> = {}) => ({ id, companyFiscalConfigId: CFC, modelo: "55", status: "REJECTED", numero: 158, serie: 1, tipoOperacao: "SAIDA", finalidade: "NORMAL", ...over });
const reserva = (nfeId: string, estado: string, numero = 158, leaseAte: Date | null = null): ReservaFake => ({ nfeId, estado, numero, serie: 1, leaseAte });
const doLedgerSemEstado = () => h.consultas.filter((c) => c.sql.includes(`FROM "NfeNumeroReserva"`) && !c.sql.includes(`"estado" IN`));
const dasDatas = () => h.consultas.filter((c) => c.sql.includes(`FROM "NfeEmitida"`) && c.sql.includes(`"updatedAt"`));

describe("A2: a chave `numeracao` só onde há reserva no ledger", () => {
  it("elegível SEM nenhuma reserva (nota V1 rejeitada antes da virada) ⇒ sem a chave `numeracao` e com legadoV1:true", async () => {
    const [n] = await attachFiscalLista("tenant", [nota("legada", { reaproveitavel: true })]);
    expect(n).not.toHaveProperty("numeracao");
    expect(n).toMatchObject({ legadoV1: true, reaproveitavel: true });
  });

  it("reserva ABANDONADO / CONSUMIDO_EXTERNO / INUTILIZADO (nº consumido) ⇒ numeracao:null e SEM legadoV1", async () => {
    h.reservas = [reserva("aband", "ABANDONADO"), reserva("externo", "CONSUMIDO_EXTERNO"), reserva("inut", "INUTILIZADO")];
    const linhas = await attachFiscalLista("tenant", [nota("aband"), nota("externo"), nota("inut")]);
    for (const n of linhas) {
      expect(n, n.id).toHaveProperty("numeracao", null);
      expect(n, n.id).not.toHaveProperty("legadoV1");
    }
  });

  it("reserva viva ⇒ numeracao como antes (estado, número, série, reutilizavel), sem legadoV1", async () => {
    h.reservas = [reserva("rej", "REJEITADO", 2), reserva("bloq", "BLOQUEADO", 501)];
    const [rej, bloq] = await attachFiscalLista("tenant", [nota("rej", { numero: 2 }), nota("bloq", { numero: 501 })]);
    expect(rej).toMatchObject({ numeracao: { estado: "REJEITADO", numero: 2, serie: 1, reutilizavel: true } });
    expect(bloq).toMatchObject({ numeracao: { estado: "BLOQUEADO", numero: 501, serie: 1, reutilizavel: false } });
    expect(rej).not.toHaveProperty("legadoV1");
    expect(bloq).not.toHaveProperty("legadoV1");
  });

  it("egress: a consulta nova só leva os ids SEM reserva viva, só o nfeId, e não roda quando todos já têm", async () => {
    h.reservas = [reserva("viva", "RESERVADO", 3), reserva("aband", "ABANDONADO")];
    await attachFiscalLista("tenant", [nota("viva", { numero: 3 }), nota("aband"), nota("nova"), nota("v1", { companyFiscalConfigId: CFC_V1 })]);
    const nova = doLedgerSemEstado();
    expect(nova).toHaveLength(1);
    expect(nova[0].args[1]).toEqual(["aband", "nova"]);
    expect(nova[0].sql).toMatch(/SELECT DISTINCT "nfeId" FROM "NfeNumeroReserva"/);
    expect(nova[0].sql).not.toContain("*");

    h.consultas = [];
    await attachFiscalLista("tenant", [nota("viva", { numero: 3 })]);
    expect(doLedgerSemEstado()).toHaveLength(0);
  });

  it("config fora da V2 ⇒ nenhuma chave nova e NENHUMA consulta ao ledger (V1 intacto)", async () => {
    const [n] = await attachFiscalLista("tenant", [nota("v1", { companyFiscalConfigId: CFC_V1, reaproveitavel: true })]);
    expect(n).not.toHaveProperty("numeracao");
    expect(n).not.toHaveProperty("legadoV1");
    expect(n).not.toHaveProperty("retomavel");
    expect(h.consultas.filter((c) => c.sql.includes(`"NfeNumeroReserva"`) || c.sql.includes(`"NfeEmitida"`))).toHaveLength(0);
  });

  it("V2 desligada no global ⇒ a lista volta exatamente como veio (nem a config é lida)", async () => {
    vi.stubEnv("NFE_NUMERACAO_V2_ENABLED", "false");
    const entrada = [nota("x")];
    expect(await attachFiscalLista("tenant", entrada)).toBe(entrada);
    expect(h.consultas).toHaveLength(0);
  });

  it("tabela do ledger ausente (DDL não aplicado) ⇒ a emissão cai no V1, então a lista também: legadoV1", async () => {
    h.ausente = true;
    const [n] = await attachFiscalLista("tenant", [nota("x")]);
    expect(n).not.toHaveProperty("numeracao");
    expect(n).toMatchObject({ legadoV1: true });
  });
});

describe("B8: retomavel para a emissão travada antes do envio", () => {
  const agora = Date.now();

  it("VALIDATING antiga (lease vencido) com reserva RESERVADO ⇒ retomavel:true", async () => {
    h.reservas = [reserva("trav", "RESERVADO", 3)];
    h.atualizadas.set("trav", new Date(agora - 20 * MIN));
    const [n] = await attachFiscalLista("tenant", [nota("trav", { status: "VALIDATING", numero: 3 })]);
    expect(n).toMatchObject({ retomavel: true, numeracao: { estado: "RESERVADO", numero: 3 } });
    // A data vem numa consulta só, com colunas explícitas, pelos ids que precisam.
    expect(dasDatas()).toHaveLength(1);
    expect(dasDatas()[0].args[1]).toEqual(["trav"]);
    expect(dasDatas()[0].sql).toMatch(/SELECT "id","updatedAt" FROM "NfeEmitida"/);
  });

  it("SIGNING antiga com REJEITADO ⇒ retomavel:true; VALIDATING recente (lease valendo) ⇒ não", async () => {
    h.reservas = [reserva("sig", "REJEITADO", 4), reserva("recente", "RESERVADO", 5)];
    h.atualizadas.set("sig", new Date(agora - 11 * MIN));
    h.atualizadas.set("recente", new Date(agora - 1 * MIN));
    const [sig, recente] = await attachFiscalLista("tenant", [nota("sig", { status: "SIGNING", numero: 4 }), nota("recente", { status: "VALIDATING", numero: 5 })]);
    expect(sig).toMatchObject({ retomavel: true });
    expect(recente).not.toHaveProperty("retomavel");
  });

  it("VALIDATING sem reserva e nunca numerada (queda entre o claim e a reserva), antiga ⇒ retomavel:true", async () => {
    h.atualizadas.set("sem", new Date(agora - 30 * MIN));
    const [n] = await attachFiscalLista("tenant", [nota("sem", { status: "VALIDATING", numero: -1 })]);
    expect(n).toMatchObject({ retomavel: true, legadoV1: true });
  });

  it("não retoma o que o orquestrador não retomaria: EM_TRANSMISSAO/INCERTO, linha V1 numerada sem reserva, SENDING — e nem pergunta a data", async () => {
    h.reservas = [reserva("tx", "EM_TRANSMISSAO", 6, new Date(agora - MIN)), reserva("inc", "INCERTO", 7)];
    const linhas = await attachFiscalLista("tenant", [
      nota("tx", { status: "VALIDATING", numero: 6 }),
      nota("inc", { status: "SIGNING", numero: 7 }),
      nota("v1num", { status: "VALIDATING", numero: 40 }),
      nota("env", { status: "SENDING", numero: 8 }),
    ]);
    for (const n of linhas) expect(n, n.id).not.toHaveProperty("retomavel");
    expect(dasDatas()).toHaveLength(0);
  });

  it("linha completa (GET /nfe/:id já traz updatedAt) ⇒ decide sem consulta a mais", async () => {
    h.reservas = [reserva("ficha", "RESERVADO", 9)];
    const [n] = await attachFiscalLista("tenant", [nota("ficha", { status: "VALIDATING", numero: 9, updatedAt: new Date(agora - 20 * MIN) })]);
    expect(n).toMatchObject({ retomavel: true });
    expect(dasDatas()).toHaveLength(0);
  });

  it("config fora da V2 com VALIDATING velha ⇒ nada (o V1 não tem retomada)", async () => {
    h.atualizadas.set("v1", new Date(agora - 60 * MIN));
    const [n] = await attachFiscalLista("tenant", [nota("v1", { companyFiscalConfigId: CFC_V1, status: "VALIDATING", numero: -1 })]);
    expect(n).not.toHaveProperty("retomavel");
    expect(dasDatas()).toHaveLength(0);
  });
});
