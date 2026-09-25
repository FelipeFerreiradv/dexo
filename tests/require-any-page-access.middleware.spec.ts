import { describe, it, expect, vi, beforeEach } from "vitest";

// ──────────────────────────────────────────────────────────
// Guard de "qualquer uma destas páginas" — mesma semântica e mesmo 403 do
// requirePageAccess, para as rotas que DUAS páginas usam. Caso real: o PDV
// consome GET /fiscal/companies (seletor de CNPJ) e GET /fiscal/nfe/:id/danfe
// (reimpressão), e em produção há colaboradores com "Notas fiscais" desligado e
// "PDV Balcão" ligado. Exigir só "fiscal" nelas quebraria o PDV deles.
// A reimpressão do DANFE também sai da ficha do cliente (Clientes →
// histórico de compras → PdvSaleActions), por isso o guard dela aceita
// "fiscal", "pdv" OU "clientes".
// ──────────────────────────────────────────────────────────

vi.mock("../app/lib/prisma", () => ({
  default: { user: { findUnique: vi.fn() } },
}));

import prisma from "../app/lib/prisma";
import {
  exigeAcessoFiscal,
  exigeAcessoFiscalOuPdv,
  exigeAcessoFiscalPdvOuClientes,
  requireAnyPageAccess,
} from "../app/middlewares/require-page-access.middleware";

function makeReply() {
  const reply: any = {
    statusCode: null as number | null,
    body: null as any,
    status(code: number) {
      reply.statusCode = code;
      return reply;
    },
    send(body: any) {
      reply.body = body;
      return reply;
    },
  };
  return reply;
}

const colaborador = (pagePermissions: Record<string, boolean> | null) =>
  ({
    user: { id: "colab-1", parentUserId: "admin-1", pagePermissions },
  }) as any;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("requireAnyPageAccess", () => {
  it("admin passa direto, sem nenhuma query", async () => {
    const reply = makeReply();
    await requireAnyPageAccess(["fiscal", "pdv"])(
      { user: { id: "u1", parentUserId: null, pagePermissions: { fiscal: false, pdv: false } } } as any,
      reply,
    );
    expect(reply.statusCode).toBeNull();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("colaborador sem pagePermissions gravado passa (zero regressão)", async () => {
    const reply = makeReply();
    await requireAnyPageAccess(["fiscal", "pdv"])(colaborador(null), reply);
    expect(reply.statusCode).toBeNull();
  });

  it("basta UMA das páginas liberada: fiscal desligado e PDV ligado passa", async () => {
    const reply = makeReply();
    await requireAnyPageAccess(["fiscal", "pdv"])(
      colaborador({ fiscal: false, pdv: true }),
      reply,
    );
    expect(reply.statusCode).toBeNull();
  });

  it("basta UMA das páginas liberada: fiscal ligado e PDV desligado passa (a PRIMEIRA da lista também abre)", async () => {
    const reply = makeReply();
    await requireAnyPageAccess(["fiscal", "pdv"])(
      colaborador({ fiscal: true, pdv: false }),
      reply,
    );
    expect(reply.statusCode).toBeNull();
  });

  it("chave ausente conta como liberada (mesma regra do hasPageAccess)", async () => {
    const reply = makeReply();
    await requireAnyPageAccess(["fiscal", "pdv"])(
      colaborador({ fiscal: false }),
      reply,
    );
    expect(reply.statusCode).toBeNull();
  });

  it("todas desligadas: 403 PAGE_FORBIDDEN no mesmo formato, com a lista de páginas", async () => {
    const reply = makeReply();
    await requireAnyPageAccess(["fiscal", "pdv"])(
      colaborador({ fiscal: false, pdv: false }),
      reply,
    );
    expect(reply.statusCode).toBe(403);
    expect(reply.body).toEqual({
      message:
        "Seu acesso a esta área foi removido pelo administrador da conta.",
      code: "PAGE_FORBIDDEN",
      pageId: "fiscal",
      pageIds: ["fiscal", "pdv"],
    });
  });

  it("sem request.user não responde nada (401 é papel do authMiddleware)", async () => {
    const reply = makeReply();
    await requireAnyPageAccess(["fiscal", "pdv"])({} as any, reply);
    expect(reply.statusCode).toBeNull();
  });
});

describe("guards nomeados das rotas fiscais", () => {
  it("exigeAcessoFiscal bloqueia fiscal=false mesmo com PDV ligado", async () => {
    const reply = makeReply();
    await exigeAcessoFiscal(colaborador({ fiscal: false, pdv: true }), reply);
    expect(reply.statusCode).toBe(403);
    expect(reply.body).toMatchObject({ code: "PAGE_FORBIDDEN", pageId: "fiscal" });
  });

  it("exigeAcessoFiscal deixa passar fiscal=true, mapa sem a chave e admin", async () => {
    for (const req of [
      colaborador({ fiscal: true }),
      colaborador({ financeiro: false }),
      colaborador(null),
      { user: { id: "admin-1", parentUserId: null } } as any,
    ]) {
      const reply = makeReply();
      await exigeAcessoFiscal(req, reply);
      expect(reply.statusCode).toBeNull();
    }
  });

  it("exigeAcessoFiscalOuPdv: passa com PDV, bloqueia sem nenhum dos dois", async () => {
    const libera = makeReply();
    await exigeAcessoFiscalOuPdv(colaborador({ fiscal: false, pdv: true }), libera);
    expect(libera.statusCode).toBeNull();

    const barra = makeReply();
    await exigeAcessoFiscalOuPdv(colaborador({ fiscal: false, pdv: false }), barra);
    expect(barra.statusCode).toBe(403);
    expect(barra.body).toMatchObject({ code: "PAGE_FORBIDDEN", pageIds: ["fiscal", "pdv"] });
  });

  it("exigeAcessoFiscalPdvOuClientes (reimpressão do DANFE): qualquer uma das três abre", async () => {
    for (const perms of [
      { fiscal: false, pdv: false, clientes: true },
      { fiscal: false, pdv: true, clientes: false },
      { fiscal: true, pdv: false, clientes: false },
    ]) {
      const reply = makeReply();
      await exigeAcessoFiscalPdvOuClientes(colaborador(perms), reply);
      expect(reply.statusCode, JSON.stringify(perms)).toBeNull();
    }
  });

  it("exigeAcessoFiscalPdvOuClientes: as três desligadas → 403 com as três páginas no corpo", async () => {
    const reply = makeReply();
    await exigeAcessoFiscalPdvOuClientes(
      colaborador({ fiscal: false, pdv: false, clientes: false }),
      reply,
    );
    expect(reply.statusCode).toBe(403);
    expect(reply.body).toEqual({
      message:
        "Seu acesso a esta área foi removido pelo administrador da conta.",
      code: "PAGE_FORBIDDEN",
      pageId: "fiscal",
      pageIds: ["fiscal", "pdv", "clientes"],
    });
  });

  it("exigeAcessoFiscalOuPdv NÃO se abre por Clientes (o seletor de CNPJ é só do PDV)", async () => {
    const reply = makeReply();
    await exigeAcessoFiscalOuPdv(
      colaborador({ fiscal: false, pdv: false, clientes: true }),
      reply,
    );
    expect(reply.statusCode).toBe(403);
    expect(reply.body).toMatchObject({ pageIds: ["fiscal", "pdv"] });
  });

  it("os guards nomeados são instâncias únicas (as rotas e o teste de cobertura comparam por identidade)", async () => {
    const mod = await import("../app/middlewares/require-page-access.middleware");
    expect(mod.exigeAcessoFiscal).toBe(exigeAcessoFiscal);
    expect(mod.exigeAcessoFiscalOuPdv).toBe(exigeAcessoFiscalOuPdv);
    expect(mod.exigeAcessoFiscalPdvOuClientes).toBe(exigeAcessoFiscalPdvOuClientes);
    expect(exigeAcessoFiscal).not.toBe(exigeAcessoFiscalOuPdv);
    expect(new Set([exigeAcessoFiscal, exigeAcessoFiscalOuPdv, exigeAcessoFiscalPdvOuClientes]).size).toBe(3);
  });
});
