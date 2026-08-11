import { describe, expect, it } from "vitest";

import {
  resumirSync,
  type SyncResultItem,
} from "../app/produtos/lib/sync-summary";

// ===========================================================================
// O TOAST QUE RESUME O RE-SYNC DA EDIÇÃO DE PRODUTO.
//
// O defeito que este arquivo tranca aparece só quando o kill-switch de um canal
// está ligado: o anúncio PULADO volta com `success: true` — porque pausar a
// integração não é falha da edição do lojista —, e a contagem antiga
// (`filter(r => r.success)`) o somava como "sincronizado". Com a OLX pausada, a
// tela AFIRMAVA que o anúncio dela recebeu a alteração.
//
// Os quatro primeiros testes são de NÃO-REGRESSÃO: fixam, palavra por palavra,
// as mensagens que já existiam. Se a extração da função pura tivesse mudado uma
// vírgula do caminho comum, é aqui que apareceria.
// ===========================================================================

const ok = (id: string): SyncResultItem => ({
  success: true,
  externalListingId: id,
});
const falha = (id: string, erro: string): SyncResultItem => ({
  success: false,
  externalListingId: id,
  error: erro,
});
const pulado = (platform: string): SyncResultItem => ({
  success: true,
  skipped: true,
  skipReason: "integration_disabled",
  platform,
  externalListingId: "SKU-1",
});

describe("⭐ zero regressão: as mensagens que já existiam, intactas", () => {
  it("sem anúncio nenhum, a mensagem é a de sempre", () => {
    expect(resumirSync([])).toEqual({
      mensagem: "Produto atualizado com sucesso!",
      tipo: "success",
    });
    expect(resumirSync(undefined).mensagem).toBe(
      "Produto atualizado com sucesso!",
    );
  });

  it("tudo sincronizado", () => {
    expect(resumirSync([ok("MLB1"), ok("MLB2")])).toEqual({
      mensagem: "Produto atualizado e 2 anúncio(s) sincronizado(s).",
      tipo: "success",
    });
  });

  it("parte falhou", () => {
    const r = resumirSync([ok("MLB1"), falha("MLB2", "categoria inválida")]);
    expect(r.mensagem).toBe(
      "Produto atualizado. 1 anúncio(s) sincronizado(s); 1 falhou(aram): MLB2: categoria inválida.",
    );
    expect(r.tipo).toBe("warning");
  });

  it("tudo falhou, e só três erros são citados", () => {
    const r = resumirSync([
      falha("A", "e1"),
      falha("B", "e2"),
      falha("C", "e3"),
      falha("D", "e4"),
    ]);
    expect(r.mensagem).toContain("4 anúncio(s) falhou(aram)");
    expect(r.mensagem).toContain("(+1)");
    expect(r.mensagem).not.toContain("D");
    expect(r.tipo).toBe("warning");
  });
});

describe("⭐ o anúncio pulado não é contado como sincronizado", () => {
  it("um pulado no meio de dois que foram: conta 2, não 3", () => {
    const r = resumirSync([ok("MLB1"), pulado("OLX"), ok("SHP1")]);
    expect(r.mensagem).toContain("2 anúncio(s) sincronizado(s)");
    expect(r.mensagem).not.toContain("3 anúncio(s) sincronizado(s)");
  });

  it("e diz QUAL canal ficou de fora, com o nome que o lojista conhece", () => {
    const r = resumirSync([ok("MLB1"), pulado("OLX")]);
    expect(r.mensagem).toContain("integração pausada (OLX)");
    // Nunca o enum cru: FACEBOOK vira "Facebook", MERCADO_LIVRE vira "Mercado
    // Livre". É o mesmo mapa que a lista de anúncios usa.
    expect(resumirSync([ok("MLB1"), pulado("FACEBOOK")]).mensagem).toContain(
      "(Facebook)",
    );
    expect(
      resumirSync([ok("MLB1"), pulado("MERCADO_LIVRE")]).mensagem,
    ).toContain("(Mercado Livre)");
  });

  it("pulado vira AVISO mesmo sem nenhuma falha — senão passa batido", () => {
    expect(resumirSync([ok("MLB1"), pulado("OLX")]).tipo).toBe("warning");
  });

  it("dois canais pausados aparecem os dois, sem repetir", () => {
    const r = resumirSync([
      ok("MLB1"),
      pulado("OLX"),
      pulado("OLX"),
      pulado("FACEBOOK"),
    ]);
    expect(r.mensagem).toContain("3 anúncio(s) não recebeu(ram)");
    expect(r.mensagem).toMatch(/\(OLX, Facebook\)|\(Facebook, OLX\)/);
    expect(r.mensagem).toContain("1 anúncio(s) sincronizado(s)");
  });

  it("TODOS pulados: não diz '0 sincronizados', diz que nenhum recebeu", () => {
    const r = resumirSync([pulado("OLX"), pulado("OLX")]);
    expect(r.mensagem).toBe(
      "Produto atualizado, mas nenhum anúncio recebeu a alteração: integração pausada (OLX).",
    );
    expect(r.mensagem).not.toContain("0 anúncio");
    expect(r.tipo).toBe("warning");
  });

  it("falha e pulado convivem: a falha continua sendo o assunto principal", () => {
    const r = resumirSync([
      ok("MLB1"),
      falha("SHP1", "token expirado"),
      pulado("OLX"),
    ]);
    expect(r.mensagem).toContain("1 falhou(aram): SHP1: token expirado");
    expect(r.mensagem).toContain("integração pausada (OLX)");
    expect(r.mensagem).toContain("1 anúncio(s) sincronizado(s)");
    expect(r.tipo).toBe("warning");
  });
});

describe("⭐ o pulado que não é kill-switch não inventa canal pausado", () => {
  // `syncOlxProductStock` também pula, com outros motivos
  // ("olx_listing_already_paused"). Dizer "integração pausada" nesse caso seria
  // mentira — e mandaria o lojista conferir uma flag que está desligada.
  it("outro skipReason é contado, mas descrito sem causa", () => {
    const r = resumirSync([
      ok("MLB1"),
      {
        success: true,
        skipped: true,
        skipReason: "olx_listing_already_paused",
        platform: "OLX",
      },
    ]);
    expect(r.mensagem).toContain("1 anúncio(s) não recebeu(ram) a alteração.");
    expect(r.mensagem).not.toContain("integração pausada");
  });

  it("pulado sem plataforma no resultado também não inventa nome", () => {
    const r = resumirSync([
      ok("MLB1"),
      { success: true, skipped: true, skipReason: "integration_disabled" },
    ]);
    expect(r.mensagem).toContain("não recebeu(ram) a alteração.");
    // Sem o trecho de causa. (`toContain("(")` não serviria: "anúncio(s)" tem
    // parêntese em toda mensagem.)
    expect(r.mensagem).not.toContain("integração pausada");
  });
});
