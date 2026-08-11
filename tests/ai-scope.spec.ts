import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { scopeFromRequest } from "../app/ai/core/scope";

// ===========================================================================
// ⭐ AiScope — a peça que torna o vazamento entre lojas impossível por
// construção, e não por disciplina.
//
// A pergunta que estes testes respondem: existe ALGUM caminho por onde o
// tenant chegue a uma tool sem passar por uma sessão autenticada? A resposta
// tem de ser não, e ela é provada em três níveis: a fábrica única, a delegação
// para as regras reais de permissão, e o texto-fonte (nenhuma segunda fábrica).
// ===========================================================================

/** Requisição fake com o shape que `authMiddleware` produz. */
const req = (user: unknown) => ({ user }) as any;

const ADMIN = {
  id: "admin-1",
  dataOwnerId: "admin-1",
  parentUserId: null,
  pagePermissions: null,
};

const COLABORADOR_SEM_FINANCEIRO = {
  id: "colab-1",
  // O tenant é o do admin PAI — é isso que faz o colaborador ver o catálogo
  // da loja e não um vazio.
  dataOwnerId: "admin-1",
  parentUserId: "admin-1",
  pagePermissions: { financeiro: false, pdv: false },
};

describe("scopeFromRequest — a fábrica única", () => {
  it("monta o escopo a partir da sessão autenticada", () => {
    const scope = scopeFromRequest(req(ADMIN));
    expect(scope?.dataOwnerId).toBe("admin-1");
    expect(scope?.actorId).toBe("admin-1");
  });

  it("colaborador: tenant do admin pai, ator ele mesmo", () => {
    const scope = scopeFromRequest(req(COLABORADOR_SEM_FINANCEIRO));
    expect(scope?.dataOwnerId).toBe("admin-1");
    expect(scope?.actorId).toBe("colab-1");
  });

  it("sem usuário devolve null — nunca um escopo vazio que consultaria tudo", () => {
    expect(scopeFromRequest(req(null))).toBeNull();
    expect(scopeFromRequest(req(undefined))).toBeNull();
    expect(scopeFromRequest({} as any)).toBeNull();
  });

  it("usuário sem dataOwnerId ou sem id devolve null", () => {
    expect(scopeFromRequest(req({ id: "x" }))).toBeNull();
    expect(scopeFromRequest(req({ dataOwnerId: "x" }))).toBeNull();
    expect(scopeFromRequest(req({ id: "", dataOwnerId: "" }))).toBeNull();
  });

  it("NÃO recalcula o tenant: usa o que o authMiddleware resolveu", () => {
    // Se um dia a regra `parentUserId ?? id` mudar, ela muda em UM lugar.
    // Duas derivações de tenant é como se cria um vazamento.
    const scope = scopeFromRequest(
      req({ id: "a", dataOwnerId: "TENANT-EXPLICITO", parentUserId: "b" }),
    );
    expect(scope?.dataOwnerId).toBe("TENANT-EXPLICITO");
  });
});

describe("permissões — delega para as regras reais do sistema", () => {
  it("admin pode tudo", () => {
    const scope = scopeFromRequest(req(ADMIN))!;
    expect(scope.can("financeiro")).toBe(true);
    expect(scope.can("produtos")).toBe(true);
    expect(scope.canAction("pdv.cancelar-venda")).toBe(true);
  });

  it("⭐ colaborador sem `financeiro` não passa no gate financeiro", () => {
    const scope = scopeFromRequest(req(COLABORADOR_SEM_FINANCEIRO))!;
    expect(scope.can("financeiro")).toBe(false);
    expect(scope.can("pdv")).toBe(false);
    // ...mas o que não foi desligado continua liberado (default é permitir).
    expect(scope.can("produtos")).toBe(true);
    expect(scope.can("pedidos")).toBe(true);
  });

  it("colaborador sem pagePermissions gravado tem acesso total (zero regressão)", () => {
    const scope = scopeFromRequest(
      req({ id: "c", dataOwnerId: "a", parentUserId: "a" }),
    )!;
    expect(scope.can("financeiro")).toBe(true);
  });

  it("permissão por AÇÃO desligada é respeitada", () => {
    const scope = scopeFromRequest(
      req({
        id: "c",
        dataOwnerId: "a",
        parentUserId: "a",
        pagePermissions: { "action:pdv.cancelar-venda": false },
      }),
    )!;
    expect(scope.canAction("pdv.cancelar-venda")).toBe(false);
    // Desligar a ação não desliga a página.
    expect(scope.can("pdv")).toBe(true);
  });
});

describe("⭐ não existe segunda porta", () => {
  const fonte = readFileSync(
    join(__dirname, "..", "app", "ai", "core", "scope.ts"),
    "utf8",
  );

  const codigo = fonte
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");

  it("scope.ts exporta UMA única função de construção", () => {
    const exportadas = [...codigo.matchAll(/export function (\w+)/g)].map(
      (m) => m[1],
    );
    expect(exportadas).toEqual(["scopeFromRequest"]);
  });

  it("o cast que cria a marca nominal aparece UMA vez só", () => {
    const casts = codigo.match(/as unknown as AiScope/g) ?? [];
    expect(casts).toHaveLength(1);
  });

  it("nenhum outro arquivo do Bitz constrói um AiScope", () => {
    // Um `as AiScope` solto em outro módulo seria uma porta dos fundos: bastaria
    // um objeto literal com o dataOwnerId errado para furar o isolamento.
    const raiz = join(__dirname, "..", "app", "ai");
    const arquivos = listarTs(raiz).filter(
      (f) => !f.endsWith("core\\scope.ts") && !f.endsWith("core/scope.ts"),
    );
    for (const arquivo of arquivos) {
      const src = readFileSync(arquivo, "utf8");
      expect(src, `${arquivo} constrói um AiScope`).not.toMatch(
        /as\s+unknown\s+as\s+AiScope|as\s+AiScope/,
      );
    }
  });
});

function listarTs(dir: string): string[] {
  const { readdirSync, statSync } =
    require("node:fs") as typeof import("node:fs");
  const saida: string[] = [];
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) saida.push(...listarTs(caminho));
    else if (caminho.endsWith(".ts")) saida.push(caminho);
  }
  return saida;
}
