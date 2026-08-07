import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

// ===========================================================================
// A PRÉVIA GRATUITA E O TETO POR CLIENTE.
//
// Duas alavancas novas, e as duas mexem em dinheiro real:
//   AI_FREE_PREVIEW      — libera o Bitz para TODO MUNDO, sem concessão.
//   User.aiDailyLimit    — teto próprio do cliente; null cai no padrão (5/dia).
//
// O que este spec protege é a assimetria entre elas: a prévia dá ACESSO, nunca
// COTA. Se um dia a prévia começar a conceder teto junto, "grátis para todos"
// deixa de ter preço previsível — que é a única razão de a prévia existir.
// ===========================================================================

const raiz = join(__dirname, "..");
const ler = (p: string) => readFileSync(join(raiz, p), "utf8");

const ambienteOriginal = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.NEXT_PUBLIC_AI_MODULE_ENABLED = "true";
  delete process.env.AI_FREE_PREVIEW;
  delete process.env.AI_MAX_DAILY_PER_TENANT;
});

afterEach(() => {
  process.env = { ...ambienteOriginal };
});

/** Dublê do prisma usado pelo serviço de entitlement. */
function comUsuario(user: { aiEnabledAt: Date | null; aiDailyLimit?: number | null }) {
  vi.doMock("../app/lib/prisma", () => ({
    default: { user: { findUnique: vi.fn().mockResolvedValue(user) } },
  }));
}

describe("prévia gratuita — AI_FREE_PREVIEW", () => {
  it("sem a flag, quem não tem concessão continua SEM acesso", async () => {
    comUsuario({ aiEnabledAt: null });
    const m = await import("../app/ai/entitlement/ai-entitlement.service");
    m.clearAiEntitlementCache();
    expect(await m.isAiEnabledFor("tenant-1")).toBe(false);
  });

  it("com a flag, quem NÃO tem concessão passa a ter acesso", async () => {
    process.env.AI_FREE_PREVIEW = "true";
    comUsuario({ aiEnabledAt: null });
    const m = await import("../app/ai/entitlement/ai-entitlement.service");
    m.clearAiEntitlementCache();
    expect(await m.isAiEnabledFor("tenant-1")).toBe(true);
  });

  it("⭐ o kill-switch do módulo vence a prévia — sempre", async () => {
    // Se a prévia conseguisse ligar o módulo, não haveria mais kill-switch.
    process.env.NEXT_PUBLIC_AI_MODULE_ENABLED = "false";
    process.env.AI_FREE_PREVIEW = "true";
    comUsuario({ aiEnabledAt: new Date() });
    const m = await import("../app/ai/entitlement/ai-entitlement.service");
    m.clearAiEntitlementCache();
    expect(await m.isAiEnabledFor("tenant-1")).toBe(false);
  });

  it("⭐ a prévia dá ACESSO, nunca COTA", async () => {
    // Quem entra pela prévia fica sem teto próprio e cai no padrão da
    // plataforma. É isto que torna "grátis para todos" um gasto previsível.
    process.env.AI_FREE_PREVIEW = "true";
    comUsuario({ aiEnabledAt: null, aiDailyLimit: null });
    const m = await import("../app/ai/entitlement/ai-entitlement.service");
    m.clearAiEntitlementCache();
    expect(await m.isAiEnabledFor("t")).toBe(true);
    expect(await m.getAiDailyLimitFor("t")).toBeNull();
  });

  it("⭐ teto residual SEM concessão não vale — o teto é do PLANO", async () => {
    // O buraco que este teste fecha: revogar um cliente grava `aiEnabledAt =
    // null` e NÃO limpa `aiDailyLimit`. Com a prévia ligada, o ex-assinante
    // voltava carregando o teto do plano pago — até 2000 mensagens/dia de
    // graça, ~R$ 18/dia num único tenant, consumindo quase metade do teto
    // global e empurrando os clientes da prévia para "muita demanda agora".
    process.env.AI_FREE_PREVIEW = "true";
    comUsuario({ aiEnabledAt: null, aiDailyLimit: 2000 });
    const m = await import("../app/ai/entitlement/ai-entitlement.service");
    m.clearAiEntitlementCache();
    expect(await m.isAiEnabledFor("t")).toBe(true);
    expect(await m.getAiDailyLimitFor("t")).toBeNull();
  });

  it("⭐ a prévia NÃO apaga o teto de quem já assinou", async () => {
    // No dia de encerrar a prévia, quem tem plano maior não pode ter perdido a
    // configuração dele no meio do caminho.
    process.env.AI_FREE_PREVIEW = "true";
    comUsuario({ aiEnabledAt: new Date(), aiDailyLimit: 300 });
    const m = await import("../app/ai/entitlement/ai-entitlement.service");
    m.clearAiEntitlementCache();
    expect(await m.getAiDailyLimitFor("t")).toBe(300);
  });

  it("nasce DESLIGADA: sem a env, o comportamento é o de antes", async () => {
    const src = ler("app/ai/core/ai-constants.ts");
    expect(src).toContain('process.env.AI_FREE_PREVIEW === "true"');
  });

  it("fail-closed: banco fora do ar NÃO vira acesso liberado", async () => {
    process.env.AI_FREE_PREVIEW = "true";
    vi.doMock("../app/lib/prisma", () => ({
      default: {
        user: { findUnique: vi.fn().mockRejectedValue(new Error("db down")) },
      },
    }));
    const m = await import("../app/ai/entitlement/ai-entitlement.service");
    m.clearAiEntitlementCache();
    // Mesmo com a prévia ligada — um banco fora do ar não é motivo para abrir.
    expect(await m.isAiEnabledFor("t")).toBe(false);
  });
});

describe("teto diário por cliente — User.aiDailyLimit", () => {
  it("null = usa o padrão da plataforma (quem resolve é reserveAiTurn)", async () => {
    comUsuario({ aiEnabledAt: new Date(), aiDailyLimit: null });
    const m = await import("../app/ai/entitlement/ai-entitlement.service");
    m.clearAiEntitlementCache();
    expect(await m.getAiDailyLimitFor("t")).toBeNull();
  });

  it("número = sobrescreve o padrão", async () => {
    comUsuario({ aiEnabledAt: new Date(), aiDailyLimit: 42 });
    const m = await import("../app/ai/entitlement/ai-entitlement.service");
    m.clearAiEntitlementCache();
    expect(await m.getAiDailyLimitFor("t")).toBe(42);
  });

  it("zero é um teto VÁLIDO — é como se corta um cliente sem revogar", async () => {
    // `0` tem que sobreviver ao caminho todo. Um `||` no lugar de `??` em
    // qualquer ponto o transformaria silenciosamente no padrão de 5/dia.
    comUsuario({ aiEnabledAt: new Date(), aiDailyLimit: 0 });
    const m = await import("../app/ai/entitlement/ai-entitlement.service");
    m.clearAiEntitlementCache();
    expect(await m.getAiDailyLimitFor("t")).toBe(0);
  });

  it("valor inválido no banco não vira teto — cai no padrão", async () => {
    comUsuario({ aiEnabledAt: new Date(), aiDailyLimit: -5 as number });
    const m = await import("../app/ai/entitlement/ai-entitlement.service");
    m.clearAiEntitlementCache();
    expect(await m.getAiDailyLimitFor("t")).toBeNull();
  });

  it("⭐ o padrão da plataforma é o teto da prévia: 5/dia", async () => {
    const { AI_CONSTANTS } = await import("../app/ai/core/ai-constants");
    // Se alguém subir isto sem querer, "grátis para todos" fica caro em um dia.
    expect(AI_CONSTANTS.DEFAULT_MAX_DAILY_PER_TENANT).toBe(5);
  });

  it("⭐ o orquestrador PASSA o teto do cliente para a reserva", async () => {
    // Sem isto a coluna existiria, a tela gravaria, e o teto nunca valeria.
    const src = ler("app/ai/agent/orchestrator.ts");
    expect(src).toContain("getAiDailyLimitFor(dataOwnerId)");
    expect(src).toMatch(
      /limiteDoTenant !== null \? \{ maxPerTenant: limiteDoTenant \} : \{\}/,
    );
  });
});

describe("⭐ o custo medido tem que ser o custo REAL", () => {
  // Um turno com tools faz 3 ou 4 requisições ao provedor, e todas sao cobradas.
  // `completion` e REATRIBUIDO a cada rodada, entao gravar `completion.usage`
  // registrava so a ULTIMA chamada — e e dessa coluna que sai o relatorio de
  // custo. O numero virava um PISO, e a conta de "quanto custa liberar para
  // todos" saia subestimada: exatamente a conta que decide se a previa e viavel.
  const orq = ler("app/ai/agent/orchestrator.ts");

  it("⭐ os tokens do turno são SOMADOS, não sobrescritos", () => {
    expect(orq).toContain("const somarUso");
    // Uma soma por caminho de chamada: a primeira, o laço de tools e a última
    // sem cardápio. Faltar uma volta a subestimar em silêncio.
    const somas = orq.match(/if \(completion\.ok\) somarUso\(completion\.usage\)/g) ?? [];
    expect(somas.length, "chamadas somadas").toBe(3);
    const chamadas = orq.match(/await chamar\(/g) ?? [];
    expect(somas.length).toBe(chamadas.length);
  });

  it("⭐ o que vai para o banco é o acumulado, nunca a última chamada", () => {
    expect(orq).not.toMatch(/inputTokens: completion\.usage/);
    expect(orq).not.toMatch(/outputTokens: completion\.usage/);
    expect(orq).toContain("inputTokens: usoDoTurno().inputTokens");
  });

  it("⭐ turno que já gastou NÃO devolve a cota", () => {
    // Um turno com duas rodadas faz 3-4 requisições; se a ÚLTIMA falha, o
    // Google já cobrou as anteriores. Devolver o slot ali fazia o contador
    // voltar enquanto a fatura subia — e como o usuário reenvia a mesma
    // pergunta, o ciclo se repetia sem nunca consumir cota.
    expect(orq).toMatch(
      /if \(!uso\.houve\) \{\s*\n\s*await refundAiTurn\(/,
    );
  });

  it("provedor que não reporta uso grava null, não zero", () => {
    // Zero seria mentira — "custou nada" e "não sei quanto custou" são coisas
    // diferentes, e o relatório de custo soma esta coluna.
    expect(orq).toContain("uso.houve ? uso.inputTokens : null");
  });
});

describe("⭐ escalação de privilégio: auto-conceder o Bitz", () => {
  // ESTE BLOCO EXISTE POR CAUSA DE UM DEFEITO REAL, introduzido e pego dentro
  // da mesma entrega.
  //
  // `PUT /users/me/settings` (app/routes/user.routes.ts) tipa o corpo como
  // `UserUpdate` e o repassa INTEIRO para `updateSettings` → `update()`. Ao pôr
  // `aiEnabledAt`/`aiDailyLimit` em `UserUpdate`, qualquer usuário autenticado
  // passava a poder se auto-conceder o Bitz com cota ilimitada:
  //
  //     PUT /users/me/settings  {"aiEnabledAt":"...","aiDailyLimit":999999}
  //
  // A correção não foi sanitizar a rota — foi tirar os campos do tipo largo e
  // criar um método próprio. A trava passa a ser do COMPILADOR, não da
  // disciplina de quem revisa o próximo PR.

  const iface = ler("app/interfaces/user.interface.ts");
  const repo = ler("app/repositories/user.repository.ts");
  const rotaUser = ler("app/routes/user.routes.ts");

  it("⭐ `UserUpdate` NÃO carrega os campos do Bitz", () => {
    // Só o CORPO da interface, até a chave de fechamento na coluna 0 — sem
    // isto o recorte engoliria o JSDoc de `UserAiAccessUpdate`, que cita os dois
    // campos de propósito e faria o teste passar/falhar pelo motivo errado.
    const inicio = iface.indexOf("export interface UserUpdate");
    const corpo = iface.slice(inicio, iface.indexOf("\n}", inicio));
    expect(corpo).toContain("pagePermissions");
    expect(corpo).not.toContain("aiEnabledAt");
    expect(corpo).not.toContain("aiDailyLimit");
  });

  it("⭐ `update()` — que recebe o corpo cru — não escreve as colunas do Bitz", () => {
    const inicio = repo.indexOf("async update(id: string, data: UserUpdate)");
    const fim = repo.indexOf("async ", inicio + 10);
    const corpo = repo.slice(inicio, fim > inicio ? fim : undefined);
    expect(corpo).not.toMatch(/aiEnabledAt:/);
    expect(corpo).not.toMatch(/aiDailyLimit:/);
  });

  it("⭐ existe UM caminho para escrever, e ele é separado", () => {
    expect(iface).toContain("export interface UserAiAccessUpdate");
    expect(repo).toContain("async updateAiAccess(");
    // E a rota de settings do próprio usuário não o alcança.
    expect(rotaUser).not.toContain("updateAiAccess");
    expect(rotaUser).not.toContain("aiEnabledAt");
    expect(rotaUser).not.toContain("aiDailyLimit");
  });

  it("⭐ quem chama `updateAiAccess` é SÓ a rota de Superadmin", () => {
    const rota = ler("app/routes/superadmin.routes.ts");
    expect(rota).toContain("userRepository.updateAiAccess(id, patchAi)");
    // Se algum dia outra rota chamar isto, este teste tem que ser revisto a
    // dedo — não é um detalhe de implementação, é a fronteira do privilégio.
    for (const arquivo of [
      "app/routes/user.routes.ts",
      "app/routes/team.routes.ts",
    ]) {
      expect(ler(arquivo), arquivo).not.toContain("updateAiAccess");
    }
  });
});

describe("painel do Superadmin — a tela que configura isso", () => {
  const rota = ler("app/routes/superadmin.routes.ts");
  const tela = ler("app/colaboradores/components/superadmin-team.tsx");

  it("⭐ TODA rota deste arquivo está atrás do guarda de Superadmin", () => {
    // O gate é a razão de este arquivo existir separado. Um PATCH de
    // entitlement sem ele deixaria qualquer admin liberar IA para si mesmo.
    //
    // ⚠️ A primeira versão deste teste fatiava de `"/users/:id"` até o FIM DO
    // ARQUIVO e procurava o guarda ali dentro — passaria mesmo se a rota
    // certa perdesse o `preHandler`, desde que qualquer rota abaixo o tivesse.
    // Contar é o que prende de verdade, e ainda cobre rotas futuras.
    const rotas = rota.match(/fastify\.(get|post|patch|put|delete)[<(]/g) ?? [];
    const guardas =
      rota.match(/preHandler: \[authMiddleware, requireSuperadmin\]/g) ?? [];
    expect(rotas.length, "rotas no arquivo").toBeGreaterThan(0);
    expect(guardas.length, "rotas guardadas").toBe(rotas.length);
  });

  it("⭐ quem decide o timestamp é o SERVIDOR, não o cliente", () => {
    // A API recebe um booleano. Se recebesse a data, um relógio errado no
    // navegador gravaria concessão no futuro — e o gate só testa `!= null`.
    expect(rota).toContain("aiEnabled?: boolean");
    expect(rota).toContain("patchAi.aiEnabledAt = new Date()");
    expect(rota).not.toMatch(/aiEnabledAt:\s*new Date\(request\.body/);
  });

  it("concessão que já existe não é reescrita por clique repetido", () => {
    expect(rota).toContain(
      "if (!target.aiEnabledAt) patchAi.aiEnabledAt = new Date()",
    );
  });

  it("⭐ há teto de sanidade no número — dedo pesado custa dinheiro", () => {
    expect(rota).toContain("LIMITE_DIARIO_MAXIMO");
    const teto = Number(rota.match(/LIMITE_DIARIO_MAXIMO = (\d+)/)?.[1] ?? "0");
    expect(teto).toBeGreaterThan(0);
    expect(teto).toBeLessThanOrEqual(5000);
    expect(rota).toMatch(/bruto > LIMITE_DIARIO_MAXIMO/);
  });

  it("⭐ salvar limpa o cache de entitlement", () => {
    // O gate fica 60 s em cache. Sem limpar, o Superadmin libera o acesso e o
    // cliente segue barrado por até um minuto — olhando a tela naquela hora.
    expect(rota).toContain("clearAiEntitlementCache()");
  });

  it("⭐ o controle vive na linha do ADMINISTRADOR, não do colaborador", () => {
    // Quota e gate usam sempre o dataOwnerId (parentUserId ?? id). Um controle
    // na linha do colaborador gravaria coluna que nunca é lida.
    const bloco = tela.slice(
      tela.indexOf('u.role === "ADMIN" && ('),
      tela.indexOf("Novo colaborador"),
    );
    expect(bloco).toContain("openAi(u)");
  });

  it("campo vazio significa 'padrão da plataforma', e não zero", () => {
    expect(tela).toContain('bruto === "" ? null : Number(bruto)');
  });

  it("⭐ desmarcar o acesso limpa o teto na tela — nada de campo mentindo", () => {
    // O teto pertence ao plano. Deixá-lo preenchido após revogar faria a tela
    // dizer que um cliente sem concessão ainda tem cota própria — e o servidor
    // já ignora esse teto, então o campo mentiria duas vezes.
    expect(tela).toContain('if (!e.target.checked) setAiLimite("")');
    // E abrir o diálogo de quem não tem concessão não mostra teto residual.
    expect(tela).toContain(
      'u.aiEnabledAt && u.aiDailyLimit !== null ? String(u.aiDailyLimit) : ""',
    );
  });

  it("⭐ erro do diálogo aparece DENTRO do diálogo", () => {
    // O `setError` da página renderiza atrás do modal: uma falha de rede ou um
    // 400 da rota ficavam invisíveis, e o superadmin só descobria o motivo
    // depois de desistir e fechar.
    expect(tela).toContain("const [aiErro, setAiErro]");
    expect(tela).toContain("{aiErro && (");
    expect(tela).toContain('role="alert"');
    // E o caminho de salvar não escreve mais no aviso de fora.
    const salvar = tela.slice(
      tela.indexOf("const handleSaveAi"),
      tela.indexOf("const handleSavePerms"),
    );
    expect(salvar).not.toContain("setError(");
  });

  it("⭐ .env.example descreve o mundo atual, não o anterior", () => {
    // Documentação de env que mente custa uma madrugada de alguém.
    const env = ler(".env.example");
    expect(env).toContain("AI_FREE_PREVIEW");
    expect(env).toContain("TRES camadas");
    expect(env).toContain("5 por tenant");
    expect(env).not.toContain("Defaults: 300 por tenant");
  });
});

// ===========================================================================
// ⭐ O DDL ACOMPANHA O SCHEMA — a checagem que faltava.
//
// Isto existe por causa de um defeito real desta entrega: `aiDailyLimit` entrou
// em `prisma/schema.prisma` e NÃO entrou nem em `docs/bitz/setup-supabase.sql`
// (que se anuncia como "TODO o DDL, num arquivo só") nem em nenhuma migração
// versionada. Nada no repositório acusava.
//
// A consequência não é um recurso capenga, é a plataforma fora do ar: o Prisma
// não faz `SELECT *`, ele expande a lista NOMINAL de colunas do schema. Uma
// coluna declarada e ausente do banco faz TODA leitura de `User` falhar —
// `findByEmail` do login inclusive. Cai o Dexo inteiro, para todo mundo, por
// causa de uma coluna de um módulo desligado.
//
// Por isso a checagem é derivada do schema, e não uma lista escrita à mão: a
// próxima coluna nasce coberta sem ninguém lembrar de vir aqui.
// ===========================================================================
describe("DDL das colunas de IA em User", () => {
  /**
   * As COLUNAS do model `User` cujo nome começa com `ai` — lidas do schema.
   *
   * ⚠️ O tipo é filtrado por uma lista de escalares do Prisma, e não por
   * "qualquer coisa". `aiConversations AiConversation[]` é uma RELAÇÃO: não
   * existe coluna com esse nome, e exigir DDL para ela faria este spec falhar
   * pedindo um `ALTER TABLE` impossível. Coluna tem tipo escalar; relação tem
   * nome de model.
   */
  function colunasDeIaNoUser(): string[] {
    const ESCALARES =
      "String|Boolean|Int|BigInt|Float|Decimal|DateTime|Json|Bytes";
    const schema = ler("prisma/schema.prisma");
    const inicio = schema.indexOf("model User {");
    expect(inicio, "model User no schema").toBeGreaterThan(-1);
    const corpo = schema.slice(inicio, schema.indexOf("\n}", inicio));
    return [
      ...corpo.matchAll(
        new RegExp(`^\\s{2}(ai[A-Za-z]+)\\s+(?:${ESCALARES})\\??\\s*$`, "gm"),
      ),
    ].map((m) => m[1]);
  }

  it("o schema realmente declara as colunas que este spec vigia", () => {
    // Guarda do próprio guarda: se a extração acima parar de casar (o schema
    // mudou de formatação, o model foi renomeado), os dois testes seguintes
    // passariam vazios e não protegeriam nada.
    expect(colunasDeIaNoUser()).toEqual(
      expect.arrayContaining(["aiEnabledAt", "aiDailyLimit"]),
    );
  });

  it("⭐ toda coluna de IA em User está no SQL de setup do Supabase", () => {
    const sql = ler("docs/bitz/setup-supabase.sql");
    for (const coluna of colunasDeIaNoUser()) {
      expect(
        sql,
        `${coluna} falta em docs/bitz/setup-supabase.sql — deploy nessa ordem derruba o login`,
      ).toMatch(
        new RegExp(`ADD COLUMN IF NOT EXISTS\\s+"${coluna}"`),
      );
    }
  });

  it("⭐ toda coluna de IA em User tem migração VERSIONADA (lida do índice do git)", () => {
    // ⚠️ LÊ O ÍNDICE DO GIT, NÃO O DISCO — e a diferença é a razão de este
    // teste existir na forma atual.
    //
    // `prisma/migrations/` está no `.gitignore` (linha 51) neste projeto: as
    // migrações entram uma a uma com `git add -f`. Um arquivo criado e não
    // adicionado fica no disco desta máquina e NÃO vai no PR. Um teste que
    // usasse `readdirSync` passaria aqui e falharia em qualquer clone limpo —
    // verde falso, que é pior que teste nenhum. Foi exatamente o que quase
    // aconteceu com `aiDailyLimit`.
    //
    // Falhar quando o `git` não existe é proposital: sem ele não há como
    // afirmar nada sobre o que está versionado, e "não consegui verificar"
    // nunca pode virar "está tudo certo".
    const versionadas = execFileSync(
      "git",
      ["ls-files", "--", "prisma/migrations/*/migration.sql"],
      { cwd: raiz, encoding: "utf8" },
    )
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    expect(
      versionadas.length,
      "nenhuma migração versionada — o `git ls-files` não achou nada",
    ).toBeGreaterThan(0);

    const sql = versionadas.map((p) => ler(p)).join("\n");

    for (const coluna of colunasDeIaNoUser()) {
      expect(
        sql,
        `${coluna} não tem migração VERSIONADA — o arquivo pode existir no seu disco e não estar no git (\`git add -f prisma/migrations/<pasta>\`)`,
      ).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS\\s+"${coluna}"`));
    }
  });

  it("o SQL de setup continua idempotente e sem extensão nova", () => {
    // Sem tirar os comentários, o `DROP COLUMN` de rollback que mora comentado
    // dentro dos arquivos seria lido como comando de verdade.
    const sql = ler("docs/bitz/setup-supabase.sql").replace(/^\s*--.*$/gm, "");
    // Rodar duas vezes não pode quebrar: é assim que o runbook manda usar.
    const alters = sql.match(/ALTER TABLE "User"[\s\S]*?;/g) ?? [];
    expect(alters.length, "ALTERs em User").toBeGreaterThan(0);
    for (const alter of alters) {
      expect(alter, alter).toContain("IF NOT EXISTS");
    }
    // Extensão nova no Postgres de produção exige aprovação explícita do dono
    // do produto. Este arquivo é colado direto no SQL Editor com permissão de
    // dono: uma linha destas passaria sem ninguém ler.
    expect(sql).not.toMatch(/CREATE\s+EXTENSION/i);
  });
});
