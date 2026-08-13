import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

vi.mock("../app/lib/prisma", () => ({ default: {} }));

import { ALL_TOOLS, getToolRegistry } from "../app/ai/tools";
import { ADVISORY_TOOLS } from "../app/ai/tools/advisory";
import { WRITE_TOOLS } from "../app/ai/tools/write";
import { ACAO_EXIGE_PERMISSAO } from "../app/ai/acoes/acao.types";
import { TIPOS_EXECUTAVEIS } from "../app/ai/acoes/executores";
import { ACTION_DEFS } from "../app/lib/action-access";
import { READ_TOOLS, getReadToolRegistry } from "../app/ai/tools/read";
import { toToolDefinition, toolParameters } from "../app/ai/tools/registry";
import { selectTools } from "../app/ai/tools/select";
import { normalizeTerm } from "../app/repositories/product-search-terms";
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
  it.each(ALL_TOOLS.map((t) => [t.name, t] as const))("%s", (_nome, tool) => {
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
  it("as 14 tools de leitura estão registradas", () => {
    expect(READ_TOOLS).toHaveLength(14);
    expect(getReadToolRegistry().size).toBe(14);
  });

  it("7 consultivas + 9 de escrita, e o registry completo tem 30", () => {
    expect(ADVISORY_TOOLS).toHaveLength(7);
    expect(WRITE_TOOLS).toHaveLength(9);
    expect(ALL_TOOLS).toHaveLength(30);
    // `buildRegistry` lançaria em nome duplicado; o tamanho prova que não houve
    // colisão entre os três conjuntos.
    expect(getToolRegistry().size).toBe(30);
  });

  // -------------------------------------------------------------------------
  // ⭐ AS TOOLS DE ESCRITA (Fase 9) — o contrato mais apertado do catálogo.
  // -------------------------------------------------------------------------

  it("⭐ TODA tool de escrita declara `action` — escrita sem dono não existe", () => {
    // O tool-runner barra quem não declarar, mas o runtime não pode ser a
    // primeira linha de defesa contra um esquecimento de autoria: permissão de
    // PÁGINA sozinha deixaria o balconista alterar preço pelo chat sem ninguém
    // ter decidido isso.
    for (const tool of WRITE_TOOLS) {
      expect(tool.kind, tool.name).toBe("write");
      expect(tool.action, `${tool.name} sem action`).toBeTruthy();
      expect(
        Object.values(ACAO_EXIGE_PERMISSAO),
        `${tool.name}: action fora do mapa único`,
      ).toContain(tool.action);
    }
  });

  it("⭐ NENHUMA tool apaga nada — a ausência é a garantia", () => {
    // Regra do dono do produto: o Bitz não exclui. A defesa não é validação, é
    // não existir a ferramenta — não há o que o modelo possa pedir.
    for (const tool of ALL_TOOLS) {
      expect(
        tool.name,
        `${tool.name} parece uma tool de exclusão`,
      ).not.toMatch(/apagar|excluir|deletar|remover|delete|cancelar/i);
    }
  });

  it("⭐ toda tool de escrita AVISA, na descrição, que não executa", () => {
    // A descrição é o que o MODELO lê para decidir. Se ela não disser que a
    // ferramenta só prepara, ele dirá ao lojista que já fez.
    for (const tool of WRITE_TOOLS) {
      expect(tool.description, tool.name).toMatch(/PREPARA/);
      expect(tool.description, tool.name).toMatch(/NÃO (cadastra|altera)/);
      expect(tool.description, tool.name).toMatch(/confirma/i);
    }
  });

  it("⭐ o mapa de permissão cobre exatamente as ações executáveis", () => {
    // Uma ação executável sem permissão declarada seria escrita sem gate; uma
    // permissão declarada sem executor seria confirmação que não faz nada.
    expect(Object.keys(ACAO_EXIGE_PERMISSAO).sort()).toEqual(
      [...TIPOS_EXECUTAVEIS].sort(),
    );
    // E toda permissão exigida existe de verdade no catálogo da casa.
    const conhecidas = new Set(ACTION_DEFS.map((a) => a.id));
    for (const id of Object.values(ACAO_EXIGE_PERMISSAO)) {
      expect(conhecidas, `${id} não está em ACTION_DEFS`).toContain(id);
    }
  });

  it("toda tool consultiva é `advisory` e mora na página de produtos", () => {
    for (const tool of ADVISORY_TOOLS) {
      expect(tool.kind, tool.name).toBe("advisory");
      // Recomendar preço, medida, categoria ou título é trabalho de quem
      // cadastra peça. Colaborador sem Produtos é barrado no tool-runner.
      expect(tool.page, tool.name).toBe("produtos");
    }
  });

  it.each(ALL_TOOLS.map((t) => [t.name, t] as const))(
    "%s declara página, palavras-chave e rótulo de fonte",
    (_nome, tool) => {
      expect(PAGE_IDS.has(tool.page), `page "${tool.page}" não existe`).toBe(
        true,
      );
      expect(tool.keywords.length).toBeGreaterThan(0);
      expect(tool.sourceLabel.length).toBeGreaterThan(3);
      expect(["read", "advisory", "write"]).toContain(tool.kind);
    },
  );

  it.each(ALL_TOOLS.map((t) => [t.name, t] as const))(
    "%s usa schema .strict() (chave extra é rejeitada, não ignorada)",
    (_nome, tool) => {
      // Um schema não-strict deixaria `{consulta:"x", userId:"outro"}` passar
      // silenciosamente descartando a chave — e a tentativa ficaria invisível.
      const r = tool.args.safeParse({ __chave_invasora__: 1 });
      expect(r.success).toBe(false);
    },
  );

  it.each(ALL_TOOLS.map((t) => [t.name, t] as const))(
    "%s tem descrição escrita PARA O MODELO",
    (_nome, tool) => {
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.description.length).toBeLessThan(700);
    },
  );

  it("nomes são snake_case em português, sem colisão", () => {
    const nomes = ALL_TOOLS.map((t) => t.name);
    expect(new Set(nomes).size).toBe(nomes.length);
    for (const nome of nomes) expect(nome).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("palavras-chave estão normalizadas o bastante para casar por substring", () => {
    for (const tool of ALL_TOOLS) {
      for (const kw of tool.keywords) {
        expect(kw, `${tool.name}: "${kw}"`).toBe(kw.toLowerCase());
        expect(kw.length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("⭐ nenhuma palavra-chave tem acento — acentuada, ela nunca casa", () => {
    // `selectTools` compara contra `normalizeTerm(mensagem)`, que faz NFD e
    // apaga as marcas combinantes. O texto do usuário NUNCA tem acento quando
    // chega na comparação, então "peça" como palavra-chave é uma linha que
    // parece funcionar e não funciona. Elas existiam: 17 entradas mortas nas
    // tools de leitura, todas com a gêmea sem acento ao lado — por isso a
    // limpeza não mudou seleção nenhuma. Este teste impede a próxima.
    for (const tool of ALL_TOOLS) {
      for (const kw of tool.keywords) {
        expect(normalizeTerm(kw), `${tool.name}: "${kw}" nunca casaria`).toBe(
          kw,
        );
      }
    }
  });
});

describe("conversão do schema para o modelo", () => {
  it.each(ALL_TOOLS.map((t) => [t.name, t] as const))(
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
    const rel: any = toolParameters(
      READ_TOOLS.find((t) => t.name === "relatorio_vendas")!,
    );
    expect(rel.required).toEqual(["dimensao"]);

    // Escrita: o modelo do veículo é o único campo sem o qual não dá para
    // cadastrar sucata — a marca sai do catálogo e o resto é opcional.
    const suc: any = toolParameters(
      WRITE_TOOLS.find((t) => t.name === "cadastrar_sucata")!,
    );
    expect(suc.required).toEqual(["modelo"]);

    // ⚠️ `buscar_produto` passou a NÃO ter campo obrigatório: `consulta` virou
    // opcional para caber "o que foi cadastrado hoje?", que não tem termo de
    // busca. Quem exige "pelo menos um dos dois" é o HANDLER, e não o schema —
    // o conversor de schema desta casa não suporta `.refine()` (ele viraria
    // `ZodEffects` e o parâmetro sairia como `{}`, que outro teste aqui proíbe).
    const p: any = toolParameters(
      READ_TOOLS.find((t) => t.name === "buscar_produto")!,
    );
    expect(p.required).toBeUndefined();
    expect(Object.keys(p.properties)).toContain("cadastradasNosUltimosDias");
  });

  it("a definição enviada ao provedor carrega nome, descrição e parâmetros", () => {
    const d = toToolDefinition(ALL_TOOLS[0]);
    expect(d.name).toBe(ALL_TOOLS[0].name);
    expect(d.description).toBe(ALL_TOOLS[0].description);
    expect(d.parameters).toBeTruthy();
  });
});

describe("⭐ somente leitura", () => {
  const ESCRITAS =
    /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(|\$executeRaw|\$transaction/;

  // Varre as tools INTEIRAS (leitura + consultivas) e também a camada de
  // fontes: a Fase 6 é "consulta e recomenda", e nenhuma linha dela escreve.
  it.each(
    [
      ...listarTs(join(__dirname, "..", "app", "ai", "tools")),
      ...listarTs(join(__dirname, "..", "app", "ai", "advisory")),
    ].map((f) => [f.split(/[\\/]/).pop()!, f]),
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

// ===========================================================================
// ⭐ Frase de lojista de verdade escolhe a tool certa.
//
// A seleção casa palavra-chave por SUBSTRING, e por isso chave com mais de uma
// palavra é FRÁGIL: qualquer palavra no meio quebra o casamento em silêncio, e
// o turno cai no conjunto padrão sem ninguém perceber.
//
// Foi o que aconteceu com a pergunta mais comum do sistema. A chave era
// "quanto vendi"; o lojista escreve "quanto EU vendi" — e o "eu" no meio fazia
// o relatório de vendas nunca ser oferecido. O agente respondia listando
// pedidos um a um e dizendo que não tinha o total.
//
// Este bloco existe para a próxima chave frágil morrer aqui, e não na frente
// do cliente.
// ===========================================================================

describe("⭐ seleção com a frase que o lojista realmente digita", () => {
  const registry = getToolRegistry();
  const nomes = (m: string) => selectTools(m, registry).map((t) => t.name);

  it.each([
    ["Quanto eu vendi em julho?", "relatorio_vendas"],
    ["quanto vendeu a loja ontem", "relatorio_vendas"],
    ["quanto nós vendemos esse mês", "relatorio_vendas"],
    ["quanto faturei no mês passado", "relatorio_vendas"],
    ["quanto eu devo cobrar nesse farol", "sugerir_preco"],
    ["por quanto vender essa lanterna", "sugerir_preco"],
    ["quanto eu tenho a receber?", "contas_a_receber"],
    ["me acha o farol do gol", "buscar_produto"],
    ["quais peças estão com estoque baixo", "relatorio_estoque"],
    [
      "o pedido não apareceu, deu erro na sincronização",
      "diagnostico_operacional",
    ],
  ])("%s → %s", (frase, esperada) => {
    expect(nomes(frase)).toContain(esperada);
  });

  it("⭐ a pergunta mais comum do sistema oferece o relatório, não a lista", () => {
    // O bug que originou este bloco: "quanto vendi" como chave nunca casava
    // "quanto EU vendi", e o turno caía no conjunto padrão. O agente listava
    // pedido por pedido e terminava dizendo que não tinha o total.
    for (const frase of [
      "Quanto eu vendi em julho?",
      "quanto a loja vendeu ontem",
      "quanto nós vendemos esse mês",
    ]) {
      expect(nomes(frase), frase).toContain("relatorio_vendas");
    }
  });
});
