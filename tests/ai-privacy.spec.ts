import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

vi.mock("../app/lib/prisma", () => ({
  default: { systemLog: { create: async () => ({}) } },
}));

import {
  CAMPOS_PROIBIDOS,
  acharCampoProibido,
  runTool,
} from "../app/ai/agent/tool-runner";
import { scopeFromRequest } from "../app/ai/core/scope";
import { buildRegistry, type AiTool } from "../app/ai/tools/registry";
import { mascararDocumento } from "../app/ai/tools/read/clientes";

// ===========================================================================
// ⭐ Privacidade: o que NUNCA sai de uma tool.
//
// Duas regras diferentes se encontram aqui:
//
//  1. `costPrice` e `markup` são regra INEGOCIÁVEL do produto — não saem para
//     ninguém, nem para o admin. Não é permissão, é campo proibido.
//
//  2. Dado pessoal de cliente pertence ao lojista, mas o destino aqui é o
//     contexto de um modelo de terceiro. Minimizar é a decisão certa: sai o
//     necessário para reconhecer e contatar, não o cadastro inteiro.
//
// A defesa é CENTRAL de propósito. Uma allowlist por handler é o plano; a
// trava do runner é a rede — porque `getDetail` lê o produto com `include`, e
// coluna nova no model entra no retorno sozinha.
// ===========================================================================

const req = (user: unknown) => ({ user }) as any;
const ADMIN = { id: "a", dataOwnerId: "TENANT-A", parentUserId: null };

const toolQueDevolve = (valor: unknown): AiTool => ({
  name: "consultar_coisa",
  description: "Consulta uma coisa qualquer para o teste.",
  args: z.object({}).strict(),
  kind: "read",
  page: "produtos",
  keywords: ["coisa"],
  sourceLabel: "Coisa",
  handler: async () => valor,
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("acharCampoProibido", () => {
  it("acha no primeiro nível", () => {
    expect(acharCampoProibido({ sku: "1", costPrice: 10 })).toBe("costPrice");
  });

  it("acha aninhado e devolve o caminho", () => {
    expect(
      acharCampoProibido({ itens: [{ nome: "x" }, { nome: "y", markup: 30 }] }),
    ).toBe("itens[1].markup");
  });

  it("é insensível a caixa", () => {
    expect(acharCampoProibido({ CostPrice: 1 })).toBe("CostPrice");
    expect(acharCampoProibido({ COSTPRICE: 1 })).toBe("COSTPRICE");
  });

  it("não acusa o que está limpo", () => {
    expect(
      acharCampoProibido({ sku: "1", preco: 10, itens: [{ nome: "x" }] }),
    ).toBeNull();
  });

  it("⭐ NÃO acusa a projeção deliberada em português", () => {
    // `placa` e `documento` são expostos de propósito e revisados: a placa é
    // como o lojista identifica o carro no pátio, e o documento vai mascarado.
    // A trava pega o objeto CRU do Prisma, não a projeção pensada.
    expect(
      acharCampoProibido({ placa: "ABC1D23", documento: "•••789" }),
    ).toBeNull();
  });

  it("não estoura em grafo com ciclo", () => {
    const a: any = { nome: "x" };
    a.self = a;
    expect(() => acharCampoProibido(a)).not.toThrow();
  });

  it("aguenta valores primitivos e nulos", () => {
    expect(acharCampoProibido(null)).toBeNull();
    expect(acharCampoProibido("texto")).toBeNull();
    expect(acharCampoProibido(42)).toBeNull();
  });
});

describe("⭐ a trava bloqueia a tool ANTES de o dado virar contexto", () => {
  it.each(["costPrice", "markup"])(
    "%s bloqueia a consulta inteira",
    async (campo) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const registry = buildRegistry([
        toolQueDevolve({ sku: "001", preco: 10, [campo]: 4 }),
      ]);
      const scope = scopeFromRequest(req(ADMIN))!;

      const r = await runTool(
        { id: "1", name: "consultar_coisa", args: {} },
        { registry, scope },
      );

      expect(r.ok).toBe(false);
      expect(r.failure).toBe("falha_na_consulta");
      // O valor não aparece no que volta ao modelo.
      expect(r.content).not.toContain(campo);
      expect(r.content).not.toContain("4");
    },
  );

  it("bloqueia mesmo para ADMIN — não é questão de permissão", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const registry = buildRegistry([toolQueDevolve({ costPrice: 99 })]);
    const scope = scopeFromRequest(req(ADMIN))!;
    const r = await runTool(
      { id: "1", name: "consultar_coisa", args: {} },
      { registry, scope },
    );
    expect(r.ok).toBe(false);
  });

  it("bloqueia credencial de marketplace devolvida por engano", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // findForFiscalDraft (order.repository.ts:416-425) devolve accessToken em
    // texto. É somente-leitura e mesmo assim não pode virar tool.
    const registry = buildRegistry([
      toolQueDevolve({ conta: { accountName: "x", accessToken: "SEGREDO" } }),
    ]);
    const scope = scopeFromRequest(req(ADMIN))!;
    const r = await runTool(
      { id: "1", name: "consultar_coisa", args: {} },
      { registry, scope },
    );
    expect(r.ok).toBe(false);
    expect(r.content).not.toContain("SEGREDO");
  });

  it("bloqueia PII crua (cliente devolvido sem projeção)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const registry = buildRegistry([
      toolQueDevolve({ name: "João", cpf: "12345678900", notes: "devendo" }),
    ]);
    const scope = scopeFromRequest(req(ADMIN))!;
    const r = await runTool(
      { id: "1", name: "consultar_coisa", args: {} },
      { registry, scope },
    );
    expect(r.ok).toBe(false);
    expect(r.content).not.toContain("12345678900");
  });

  it("resultado limpo passa normalmente", async () => {
    const registry = buildRegistry([
      toolQueDevolve({ sku: "001", nome: "Farol", preco: 120, estoque: 2 }),
    ]);
    const scope = scopeFromRequest(req(ADMIN))!;
    const r = await runTool(
      { id: "1", name: "consultar_coisa", args: {} },
      { registry, scope },
    );
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.content).preco).toBe(120);
  });

  it("a lista de proibidos cobre custo, credencial e PII", () => {
    for (const obrigatorio of [
      "costprice",
      "markup",
      "accesstoken",
      "refreshtoken",
      "cpf",
      "notes",
      "chassis",
    ]) {
      expect(CAMPOS_PROIBIDOS as readonly string[]).toContain(obrigatorio);
    }
  });
});

describe("máscara de documento", () => {
  it("mantém só os 3 últimos dígitos", () => {
    expect(mascararDocumento("123.456.789-00")).toBe("•••900");
    expect(mascararDocumento("12345678000199")).toBe("•••199");
  });

  it("documento ausente ou curto demais vira null", () => {
    expect(mascararDocumento(null)).toBeNull();
    expect(mascararDocumento("")).toBeNull();
    expect(mascararDocumento("12")).toBeNull();
  });

  it("nunca devolve o documento inteiro", () => {
    const cpf = "98765432100";
    expect(mascararDocumento(cpf)).not.toContain(cpf.slice(0, 6));
  });
});

describe("⭐ arquitetura: a superfície de leitura é a dos usecases", () => {
  const arquivosDeTools = listarTs(join(__dirname, "..", "app", "ai", "tools"));

  it("nenhuma tool importa um repositório direto", () => {
    // Vários repositórios têm `userId?` OPCIONAL, e sem ele a query varre TODOS
    // os tenants sem erro nenhum (product.repository.ts:1291,
    // location.repository.ts:62, order.repository.ts:302, scrap.repository.ts:157).
    // Os usecases exigem o tenant por tipo. Proibir o import é mais fácil de
    // pinar do que lembrar do argumento.
    for (const arquivo of arquivosDeTools) {
      const src = semComentarios(arquivo);
      expect(src, arquivo).not.toMatch(
        /from\s+["'].*repositories\/[a-z-]*\.repository["']/,
      );
    }
  });

  it("as quatro funções sem escopo de tenant nenhum não aparecem", () => {
    // Estas não têm nem parâmetro de dono para esquecer.
    for (const arquivo of arquivosDeTools) {
      const src = semComentarios(arquivo);
      expect(src, arquivo).not.toMatch(
        /getDescendantProductsCount|findByExternalOrderId|findByMarketplaceAccount|findForFiscalDraft/,
      );
    }
  });
});

function semComentarios(arquivo: string): string {
  return readFileSync(arquivo, "utf8")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");
}

function listarTs(dir: string): string[] {
  const saida: string[] = [];
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) saida.push(...listarTs(caminho));
    else if (caminho.endsWith(".ts")) saida.push(caminho);
  }
  return saida;
}
