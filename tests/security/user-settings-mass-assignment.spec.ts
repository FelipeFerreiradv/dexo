import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ===========================================================================
// MASS-ASSIGNMENT EM `PUT /users/me/settings` e `PUT /users/:id/settings`.
//
// As duas rotas tipam o corpo como `UserUpdate` e o repassam INTEIRO para
// `updateSettings` → `userRepository.update`. Enquanto `isActive` e
// `pagePermissions` moravam naquele tipo, qualquer usuário autenticado — um
// COLABORADOR com páginas bloqueadas, inclusive — se auto-liberava:
//
//     PUT /users/me/settings   {"pagePermissions": {}}
//
// Mapa vazio significa acesso a TUDO por definição do schema. O mesmo caminho
// escrevia o próprio `isActive`.
//
// A correção NÃO foi sanitizar as rotas: foi tirar os campos do tipo largo e
// dar a eles um método próprio no repositório. A trava passa a ser do
// COMPILADOR — e qualquer campo sensível acrescentado ao tipo estreito no
// futuro nasce protegido pelo mesmo motivo.
//
// Verificado no TEXTO-FONTE porque a suíte roda em `environment: "node"`, sem
// servidor HTTP nem banco. Mesmo precedente de tests/ai-widget-contract.spec.ts
// e tests/dashboard-routes-page-gate.spec.ts.
// ===========================================================================

const raiz = join(__dirname, "..", "..");
const ler = (p: string) => readFileSync(join(raiz, p), "utf8");

const iface = ler("app/interfaces/user.interface.ts");
const repo = ler("app/repositories/user.repository.ts");
const rotaUser = ler("app/routes/user.routes.ts");
const rotaTeam = ler("app/routes/team.routes.ts");
const rotaSuper = ler("app/routes/superadmin.routes.ts");

/**
 * Corpo de uma interface, SEM comentários.
 *
 * ⚠️ Os comentários deste módulo citam de propósito os campos que NÃO devem
 * estar ali ("isActive e pagePermissions não moram mais aqui"), então um
 * `not.toContain` ingênuo casaria com a documentação da regra em vez da
 * violação dela. Aqui procuramos a DECLARAÇÃO, não a palavra.
 */
function camposDaInterface(src: string, nome: string): string[] {
  const inicio = src.indexOf(`export interface ${nome}`);
  expect(inicio, `interface ${nome} não encontrada`).toBeGreaterThan(-1);
  const corpo = src.slice(inicio, src.indexOf("\n}", inicio));
  return [...corpo.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
}

describe("⭐ o tipo largo não carrega controle de acesso", () => {
  it("`UserUpdate` não declara isActive nem pagePermissions", () => {
    const campos = camposDaInterface(iface, "UserUpdate");
    // Âncora positiva: se o recorte falhar, o teste falha em vez de passar por
    // estar olhando um bloco vazio.
    expect(campos).toContain("defaultProductDescription");
    expect(campos).not.toContain("isActive");
    expect(campos).not.toContain("pagePermissions");
    // E os do Bitz continuam fora, pelo mesmo motivo.
    expect(campos).not.toContain("aiEnabledAt");
    expect(campos).not.toContain("aiDailyLimit");
  });

  it("existe um tipo estreito para controle de acesso", () => {
    const campos = camposDaInterface(iface, "UserAccessControlUpdate");
    expect(campos).toEqual(["isActive", "pagePermissions"]);
  });

  it("⭐ `update()` — que recebe o corpo cru — não escreve esses campos", () => {
    const inicio = repo.indexOf("async update(id: string, data: UserUpdate)");
    expect(inicio).toBeGreaterThan(-1);
    const proximo = repo.indexOf("\n  async ", inicio + 10);
    const corpo = repo.slice(inicio, proximo > inicio ? proximo : undefined);
    // Âncora positiva: o método continua gravando o que DEVE gravar.
    expect(corpo).toContain("defaultProductDescription: data.defaultProductDescription");
    expect(corpo).not.toMatch(/isActive: data\.isActive/);
    expect(corpo).not.toMatch(/pagePermissions: data\.pagePermissions/);
    expect(corpo).not.toMatch(/aiEnabledAt: data\.aiEnabledAt/);
  });

  it("há UM caminho para escrever, e ele é separado", () => {
    expect(repo).toContain("async updateAccessControl(");
    const inicio = repo.indexOf("async updateAccessControl(");
    const proximo = repo.indexOf("\n  async ", inicio + 10);
    const corpo = repo.slice(inicio, proximo);
    expect(corpo).toContain("isActive: data.isActive");
    expect(corpo).toContain("pagePermissions: data.pagePermissions");
  });
});

describe("⭐ as rotas de AUTOATENDIMENTO não alcançam o caminho privilegiado", () => {
  it("user.routes não chama nenhum método de escrita privilegiada", () => {
    // As duas rotas de settings vivem neste arquivo: `/me/settings` e
    // `/:id/settings` (esta última aceita o próprio usuário OU o admin-pai, e
    // portanto também era um caminho de auto-liberação).
    expect(rotaUser).toContain('"/me/settings"');
    expect(rotaUser).toContain('"/:id/settings"');
    expect(rotaUser).not.toContain("updateAccessControl");
    expect(rotaUser).not.toContain("updateAiAccess");
  });

  it("⭐ user.routes não ESCREVE campo privilegiado nenhum", () => {
    // ⚠️ `pagePermissions` aparece neste arquivo — mas só em LEITURA, num
    // `select` de GET, o que é legítimo. O que não pode existir é escrita.
    // Por isso a asserção é sobre atribuição/patch, não sobre a palavra.
    expect(rotaUser).not.toMatch(/pagePermissions:\s*(request|data|patch)/);
    expect(rotaUser).not.toMatch(/isActive:\s*(request|data|patch)/);
    expect(rotaUser).not.toContain("aiEnabledAt");
    expect(rotaUser).not.toContain("aiDailyLimit");

    // E o corpo das duas rotas de settings continua tipado como `UserUpdate` —
    // que, pelo bloco acima, não carrega mais nada privilegiado. É daí que vem
    // a garantia: não é sanitização, é o tipo.
    expect(rotaUser).toContain("fastify.put<{ Body: UserUpdate }>");
    expect(rotaUser).toContain(
      "fastify.put<{ Body: UserUpdate; Params: { id: string } }>",
    );
  });
});

describe("⭐ REGRA ZERO: os caminhos de admin continuam podendo escrever", () => {
  it("admin liga/desliga o próprio colaborador", () => {
    expect(rotaTeam).toContain("updateAccessControl(id, { isActive })");
  });

  it("admin edita as permissões de página do próprio colaborador", () => {
    expect(rotaTeam).toMatch(
      /updateAccessControl\(id, \{\s*\n?\s*pagePermissions: pp,/,
    );
  });

  it("superadmin escreve status e permissões de qualquer usuário", () => {
    expect(rotaSuper).toContain("updateAccessControl(id, patchAcesso)");
    expect(rotaSuper).toContain("patchAcesso.isActive = request.body.isActive");
    expect(rotaSuper).toContain("patchAcesso.pagePermissions = pp");
  });

  it("⭐ e escrevem SÓ depois de checar posse ou role", () => {
    // O método do repositório é a fechadura, não a porta: ele não checa nada.
    // Quem protege é a rota, e é aqui que isso fica preso.
    const superPatch = rotaSuper.slice(rotaSuper.indexOf('"/users/:id"'));
    expect(superPatch).toContain(
      "preHandler: [authMiddleware, requireSuperadmin]",
    );
    // No team, a posse é o vínculo com o admin logado.
    expect(rotaTeam).toContain("target.parentUserId !== me.id");
  });
});
