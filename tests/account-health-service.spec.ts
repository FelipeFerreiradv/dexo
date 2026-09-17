import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/lib/prisma", () => ({ default: { $queryRaw: vi.fn() } }));
vi.mock("../app/lib/prisma", () => ({ default: { $queryRaw: vi.fn() } }));

import prisma from "../app/lib/prisma";
import {
  AccountHealthService,
  classifyAccountHealth,
  statusSignature,
  type AccountHealthRow,
} from "../app/marketplaces/services/account-health.service";

/**
 * Qual conta vira aviso. Regra medida em produção (17/09/2026): conta ERROR
 * com credencial não importa pedido; conta desconectada pode ser decisão do
 * lojista, então só avisa se ainda houver anúncio à venda. "Sem baixa
 * automática" só quando for verdade (a baixa não olha o status da conta).
 */

const row = (extra: Partial<AccountHealthRow>): AccountHealthRow => ({
  id: "acc",
  platform: "MERCADO_LIVRE",
  accountName: "Loja",
  status: "ERROR",
  temToken: true,
  tokenVencido: true,
  ultimoPedidoEm: null,
  anunciosAVenda: 0,
  ...extra,
});

describe("classifyAccountHealth", () => {
  it("ERROR com credencial é PARADA, mesmo sem anúncio à venda", () => {
    const r = classifyAccountHealth([row({ id: "a", anunciosAVenda: 0 })]);
    expect(r).toEqual([
      expect.objectContaining({ id: "a", tipo: "parada", anunciosAVenda: 0 }),
    ]);
  });

  it("INACTIVE ou ERROR sem credencial é DESCONECTADA só com anúncio à venda", () => {
    const r = classifyAccountHealth([
      row({ id: "inativa-com", status: "INACTIVE", temToken: false, anunciosAVenda: 3 }),
      row({ id: "inativa-sem", status: "INACTIVE", temToken: false, anunciosAVenda: 0 }),
      row({ id: "erro-sem-token", status: "ERROR", temToken: false, anunciosAVenda: 2 }),
      row({ id: "erro-sem-token-sem-anuncio", status: "ERROR", temToken: false, anunciosAVenda: 0 }),
    ]);
    expect(r.map((c) => [c.id, c.tipo])).toEqual([
      ["inativa-com", "desconectada"],
      ["erro-sem-token", "desconectada"],
    ]);
  });

  it("ACTIVE nunca vira aviso", () => {
    expect(classifyAccountHealth([row({ status: "ACTIVE", anunciosAVenda: 99 })])).toEqual([]);
  });

  it("semBaixa: só sem token ou com token vencido", () => {
    const r = classifyAccountHealth([
      row({ id: "valido", tokenVencido: false, anunciosAVenda: 5 }),
      row({ id: "vencido", tokenVencido: true, anunciosAVenda: 4 }),
      row({ id: "sem-token", status: "INACTIVE", temToken: false, tokenVencido: false, anunciosAVenda: 3 }),
    ]);
    const porId = Object.fromEntries(r.map((c) => [c.id, c.semBaixa]));
    expect(porId).toEqual({ valido: false, vencido: true, "sem-token": true });
  });

  it("parada primeiro, depois quem expõe mais anúncios; contagem bigint e data ISO", () => {
    const r = classifyAccountHealth([
      row({ id: "d-pouco", status: "INACTIVE", temToken: false, anunciosAVenda: BigInt(5) }),
      row({ id: "p", anunciosAVenda: 1, ultimoPedidoEm: new Date("2026-09-02T13:03:00Z") }),
      row({ id: "d-muito", status: "INACTIVE", temToken: false, anunciosAVenda: 2096 }),
    ]);
    expect(r.map((c) => c.id)).toEqual(["p", "d-muito", "d-pouco"]);
    expect(r[2].anunciosAVenda).toBe(5);
    expect(r[0].ultimoPedidoEm).toBe("2026-09-02T13:03:00.000Z");
  });
});

describe("AccountHealthService.getForOwner", () => {
  const queryRaw = () => (prisma as any).$queryRaw as ReturnType<typeof vi.fn>;
  const sqlDe = (call: any[]) => (call[0] as string[]).join("?");
  const pesadas = () => queryRaw().mock.calls.filter((c: any[]) => sqlDe(c).includes('"anunciosAVenda"'));

  /** Estado das contas (leitura leve) e linhas completas (leitura pesada). */
  function banco(estado: Partial<AccountHealthRow>[], completas?: Partial<AccountHealthRow>[]) {
    queryRaw().mockImplementation(async (strings: string[]) => {
      const sql = strings.join("?");
      if (sql.includes('"anunciosAVenda"')) return (completas ?? estado).map(row);
      return estado.map((e) => {
        const r = row(e);
        return { id: r.id, status: r.status, temToken: r.temToken, tokenVencido: r.tokenVencido };
      });
    });
  }

  beforeEach(() => {
    AccountHealthService.__clearCache();
    queryRaw().mockReset();
    delete process.env.ACCOUNT_HEALTH_ALERTS_DISABLED;
  });

  afterEach(() => {
    delete process.env.ACCOUNT_HEALTH_ALERTS_DISABLED;
  });

  it("consulta contas do dono E dos colaboradores, só ERROR/INACTIVE, sem ler o token", async () => {
    banco([{ id: "a" }]);

    const r = await AccountHealthService.getForOwner("owner-1");

    expect(r.map((c) => c.id)).toEqual(["a"]);
    for (const call of queryRaw().mock.calls) {
      const sql = sqlDe(call);
      expect(sql).toContain(`u.id = ? OR u."parentUserId" = ?`);
      expect(call.slice(1)).toEqual(["owner-1", "owner-1"]);
      expect(sql).toContain(`ma.status::text IN ('ERROR', 'INACTIVE')`);
      // O token só é comparado com vazio dentro do SQL; nunca volta na linha.
      expect(sql).toContain(`(COALESCE(ma."accessToken", '') <> '') AS "temToken"`);
      expect(sql.replace(`(COALESCE(ma."accessToken", '') <> '')`, "")).not.toContain("accessToken");
    }
    const pesada = sqlDe(pesadas()[0]);
    // Anúncio à venda = ativo, real (não placeholder) e com estoque disponível.
    expect(pesada).toContain(`pl.status = 'active'`);
    expect(pesada).toContain(`(p.stock - p."reservedStock") > 0`);
  });

  it("nenhuma conta com problema: só a leitura leve", async () => {
    banco([]);
    await expect(AccountHealthService.getForOwner("owner-1")).resolves.toEqual([]);
    expect(queryRaw()).toHaveBeenCalledTimes(1);
    expect(pesadas()).toHaveLength(0);
  });

  it("cache por dono: a parte cara não se repete enquanto o estado das contas é o mesmo", async () => {
    banco([{ id: "a" }]);
    await AccountHealthService.getForOwner("owner-1");
    await AccountHealthService.getForOwner("owner-1");
    await AccountHealthService.getForOwner("owner-2");
    expect(pesadas()).toHaveLength(2);
  });

  it("conta reconectada (estado mudou): ignora o cache na hora", async () => {
    banco([{ id: "a" }, { id: "b" }]);
    const antes = await AccountHealthService.getForOwner("owner-1");
    expect(antes.map((c) => c.id).sort()).toEqual(["a", "b"]);

    // "a" voltou a ACTIVE: sai da leitura leve e da pesada.
    banco([{ id: "b" }]);
    const depois = await AccountHealthService.getForOwner("owner-1");
    expect(depois.map((c) => c.id)).toEqual(["b"]);
  });

  it("todas reconectadas: vazio imediatamente, sem consultar a parte cara", async () => {
    banco([{ id: "a" }]);
    await AccountHealthService.getForOwner("owner-1");
    const pesadasAntes = pesadas().length;
    banco([]);
    await expect(AccountHealthService.getForOwner("owner-1")).resolves.toEqual([]);
    expect(pesadas()).toHaveLength(pesadasAntes);
  });

  it("falha não fica em cache", async () => {
    let falhar = true;
    queryRaw().mockImplementation(async (strings: string[]) => {
      const sql = strings.join("?");
      if (!sql.includes('"anunciosAVenda"')) {
        return [{ id: "a", status: "ERROR", temToken: true, tokenVencido: true }];
      }
      if (falhar) throw new Error("banco fora");
      return [row({ id: "a" })];
    });
    await expect(AccountHealthService.getForOwner("owner-1")).rejects.toThrow("banco fora");
    falhar = false;
    await expect(AccountHealthService.getForOwner("owner-1")).resolves.toHaveLength(1);
  });

  it("kill-switch ligado: lista vazia sem consultar", async () => {
    process.env.ACCOUNT_HEALTH_ALERTS_DISABLED = "1";
    await expect(AccountHealthService.getForOwner("owner-1")).resolves.toEqual([]);
    expect(queryRaw()).not.toHaveBeenCalled();
  });

  it("assinatura independe da ordem e muda com o estado", () => {
    const a = { id: "a", status: "ERROR", temToken: true, tokenVencido: true };
    const b = { id: "b", status: "INACTIVE", temToken: false, tokenVencido: false };
    expect(statusSignature([a, b])).toBe(statusSignature([b, a]));
    expect(statusSignature([a])).not.toBe(statusSignature([{ ...a, tokenVencido: false }]));
  });
});
