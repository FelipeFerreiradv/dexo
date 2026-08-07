import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

vi.mock("../app/lib/prisma", () => ({ default: {} }));

import { READ_TOOLS, getReadToolRegistry } from "../app/ai/tools/read";
import { toToolDefinition, toolParameters } from "../app/ai/tools/registry";
import { PAGE_DEFS } from "../app/lib/page-access";

// ===========================================================================
// ⭐ Contrato do catálogo de tools.
//
// O teste central deste arquivo é o de tenant: NENHUM schema pode aceitar uma
// chave de dono. Não é uma questão de estilo — é a segunda das três travas de
// isolamento (as outras são o tipo `AiScope` e o `.strict()` do runner). Se
// alguém, um dia, achar prático "deixar o modelo escolher a loja", a suíte
// quebra antes do commit.
// ===========================================================================

const PAGE_IDS = new Set(PAGE_DEFS.map((p) => p.id));

/** Toda chave do schema, incluindo as aninhadas. */
function chavesDoSchema(node: any, saida: string[] = []): string[] {
  if (!node || typeof node !== "object") return saida;
  if (node.properties) {
    for (const [chave, valor] of Object.entries(node.properties)) {
      saida.push(chave);
      chavesDoSchema(valor, saida);
    }
  }
  if (node.items) chavesDoSchema(node.items, saida);
  return saida;
}

describe("⭐ nenhuma tool aceita o tenant como argumento", () => {
  it.each(READ_TOOLS.map((t) => [t.name, t] as const))("%s", (_nome, tool) => {
    const chaves = chavesDoSchema(toolParameters(tool));
    for (const chave of chaves) {
      expect(
        chave,
        `"${chave}" é chave de dono — o tenant vem do AiScope, nunca dos argumentos`,
      ).not.toMatch(/userId|dataOwnerId|tenant|ownerId|accountId/i);
    }
  });

  it("o texto-fonte das tools não lê tenant de dentro dos args", () => {
    // `args.userId`/`args.dataOwnerId` compilaria (os args são `any` no
    // handler) e passaria despercebido — este varre o código.
    for (const arquivo of listarTs(
      join(__dirname, "..", "app", "ai", "tools"),
    )) {
      const src = readFileSync(arquivo, "utf8");
      expect(src, arquivo).not.toMatch(
        /args\s*[.[]\s*["']?(userId|dataOwnerId|tenantId|ownerId)/,
      );
    }
  });

  it("todo handler tira o tenant do scope, e só de lá", () => {
    for (const arquivo of listarTs(
      join(__dirname, "..", "app", "ai", "tools", "read"),
    )) {
      const src = readFileSync(arquivo, "utf8");
      if (!src.includes("handler:")) continue;
      expect(src, `${arquivo} não usa scope.dataOwnerId`).toContain(
        "scope.dataOwnerId",
      );
    }
  });
});

describe("declaração das tools", () => {
  it("as 13 tools de leitura estão registradas", () => {
    expect(READ_TOOLS).toHaveLength(13);
    expect(getReadToolRegistry().size).toBe(13);
  });

  it.each(READ_TOOLS.map((t) => [t.name, t] as const))(
    "%s declara página, palavras-chave e rótulo de fonte",
    (_nome, tool) => {
      expect(PAGE_IDS.has(tool.page), `page "${tool.page}" não existe`).toBe(
        true,
      );
      expect(tool.keywords.length).toBeGreaterThan(0);
      expect(tool.sourceLabel.length).toBeGreaterThan(3);
      expect(tool.kind).toBe("read");
    },
  );

  it.each(READ_TOOLS.map((t) => [t.name, t] as const))(
    "%s usa schema .strict() (chave extra é rejeitada, não ignorada)",
    (_nome, tool) => {
      // Um schema não-strict deixaria `{consulta:"x", userId:"outro"}` passar
      // silenciosamente descartando a chave — e a tentativa ficaria invisível.
      const r = tool.args.safeParse({ __chave_invasora__: 1 });
      expect(r.success).toBe(false);
    },
  );

  it.each(READ_TOOLS.map((t) => [t.name, t] as const))(
    "%s tem descrição escrita PARA O MODELO",
    (_nome, tool) => {
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.description.length).toBeLessThan(700);
    },
  );

  it("nomes são snake_case em português, sem colisão", () => {
    const nomes = READ_TOOLS.map((t) => t.name);
    expect(new Set(nomes).size).toBe(nomes.length);
    for (const nome of nomes) expect(nome).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("palavras-chave estão normalizadas o bastante para casar por substring", () => {
    for (const tool of READ_TOOLS) {
      for (const kw of tool.keywords) {
        expect(kw, `${tool.name}: "${kw}"`).toBe(kw.toLowerCase());
        expect(kw.length).toBeGreaterThanOrEqual(2);
      }
    }
  });
});

describe("conversão do schema para o modelo", () => {
  it.each(READ_TOOLS.map((t) => [t.name, t] as const))(
    "%s converte para JSON Schema de objeto, sem cair no fallback vazio",
    (_nome, tool) => {
      const params: any = toolParameters(tool);
      expect(params.type).toBe("object");
      expect(params.properties).toBeTruthy();
      // Fallback `{}` significa tipo zod não suportado pelo conversor — o zod
      // ainda validaria, mas o modelo receberia um contrato mudo.
      for (const [chave, valor] of Object.entries<any>(params.properties)) {
        expect(
          Object.keys(valor).length,
          `${tool.name}.${chave} virou schema vazio`,
        ).toBeGreaterThan(0);
      }
    },
  );

  it("propaga limites numéricos e enums para o modelo", () => {
    const p: any = toolParameters(
      READ_TOOLS.find((t) => t.name === "buscar_produto")!,
    );
    expect(p.properties.limite.type).toBe("integer");
    expect(p.properties.limite.maximum).toBe(20);

    const pedido: any = toolParameters(
      READ_TOOLS.find((t) => t.name === "buscar_pedido")!,
    );
    expect(pedido.properties.situacao.enum).toContain("CANCELLED");
  });

  it("marca como obrigatório só o que é mesmo", () => {
    const p: any = toolParameters(
      READ_TOOLS.find((t) => t.name === "buscar_produto")!,
    );
    expect(p.required).toEqual(["consulta"]);

    const rel: any = toolParameters(
      READ_TOOLS.find((t) => t.name === "relatorio_vendas")!,
    );
    expect(rel.required).toEqual(["dimensao"]);
  });

  it("a definição enviada ao provedor carrega nome, descrição e parâmetros", () => {
    const d = toToolDefinition(READ_TOOLS[0]);
    expect(d.name).toBe(READ_TOOLS[0].name);
    expect(d.description).toBe(READ_TOOLS[0].description);
    expect(d.parameters).toBeTruthy();
  });
});

describe("⭐ somente leitura", () => {
  const ESCRITAS =
    /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(|\$executeRaw|\$transaction/;

  it.each(
    listarTs(join(__dirname, "..", "app", "ai", "tools", "read")).map((f) => [
      f.split(/[\\/]/).pop()!,
      f,
    ]),
  )("%s não chama nenhuma escrita do Prisma", (_nome, arquivo) => {
    expect(semComentarios(arquivo)).not.toMatch(ESCRITAS);
  });

  it("nenhuma tool importa um serviço de escrita conhecido", () => {
    // Os três que mais parecem leitura e não são: o reconciliador de pedidos
    // (baixa estoque), o getter de job da Shopee (faz UPDATE) e a limpeza de
    // log (apaga). Os comentários das tools CITAM esses nomes de propósito,
    // para registrar o "não embrulhar" — por isso a comparação é sobre o
    // código, não sobre o arquivo inteiro.
    for (const arquivo of listarTs(
      join(__dirname, "..", "app", "ai", "tools"),
    )) {
      expect(semComentarios(arquivo), arquivo).not.toMatch(
        /OrderIngestionReconcilerService|getShopeeImportJobStatus|cleanupOldLogs|ListingDispatcher/,
      );
    }
  });
});

/**
 * Fonte SEM comentários.
 *
 * As asserções negativas precisam disto: os comentários das tools citam de
 * propósito o que NÃO se deve fazer ("NÃO EMBRULHAR: OrderIngestionReconciler
 * baixa estoque"), e um `not.toMatch` ingênuo casaria com a documentação da
 * regra em vez de com a violação dela. Mesmo helper de
 * tests/ai-widget-contract.spec.ts.
 */
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
