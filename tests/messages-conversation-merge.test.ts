import { describe, it, expect } from "vitest";

import {
  READ_ACK_TTL_MS,
  aplicarLeiturasConfirmadas,
  mesclarPagina0,
  podarLeiturasAntigas,
} from "@/app/mensagens/lib/conversation-merge";

/**
 * H4 do diagnóstico: a lista tinha três disparadores de refetch e dois rodavam
 * sem AbortController, todos fazendo replace TOTAL do estado. Uma requisição
 * iniciada antes da leitura ser confirmada voltava depois e sobrescrevia o zero
 * com o valor antigo — o número "voltava" em segundos.
 */

const item = (externalItemId: string, unreadCount: number) => ({
  externalItemId,
  unreadCount,
  outroCampo: "preservado",
});

describe("aplicarLeiturasConfirmadas", () => {
  it("resposta iniciada ANTES da leitura confirmada NÃO ressuscita o contador", () => {
    const iniciadoEm = 1_000;
    const leituras = new Map([["MLB1", 1_500]]); // confirmada DEPOIS do início

    const r = aplicarLeiturasConfirmadas(
      [item("MLB1", 3), item("MLB2", 2)],
      leituras,
      iniciadoEm,
    );

    expect(r[0].unreadCount).toBe(0); // vetado
    expect(r[1].unreadCount).toBe(2); // sem leitura confirmada: valor do servidor
  });

  it("resposta iniciada DEPOIS da leitura vale — inclusive número novo legítimo", () => {
    const iniciadoEm = 2_000;
    const leituras = new Map([["MLB1", 1_500]]); // confirmada ANTES do início

    // Outro comprador perguntou no mesmo anúncio: o 1 é real e deve aparecer.
    const r = aplicarLeiturasConfirmadas([item("MLB1", 1)], leituras, iniciadoEm);

    expect(r[0].unreadCount).toBe(1);
  });

  it("preserva os demais campos do item e não muta a entrada", () => {
    const entrada = [item("MLB1", 3)];
    const r = aplicarLeiturasConfirmadas(
      entrada,
      new Map([["MLB1", 9_999]]),
      1_000,
    );

    expect(r[0].outroCampo).toBe("preservado");
    expect(entrada[0].unreadCount).toBe(3); // original intacto
  });

  it("sem leituras confirmadas: devolve os itens como vieram", () => {
    const r = aplicarLeiturasConfirmadas(
      [item("MLB1", 3), item("MLB2", 0)],
      new Map(),
      1_000,
    );
    expect(r.map((c) => c.unreadCount)).toEqual([3, 0]);
  });

  it("empate exato (confirmada no mesmo instante do início) NÃO veta", () => {
    // A comparação é estritamente MAIOR: no empate o servidor já pode ter visto
    // a leitura, e vetar aqui mascararia uma mensagem realmente nova.
    const r = aplicarLeiturasConfirmadas(
      [item("MLB1", 2)],
      new Map([["MLB1", 1_000]]),
      1_000,
    );
    expect(r[0].unreadCount).toBe(2);
  });
});

describe("podarLeiturasAntigas", () => {
  it("remove só o que passou do TTL", () => {
    const agora = 10 * READ_ACK_TTL_MS;
    const leituras = new Map([
      ["velha", agora - READ_ACK_TTL_MS - 1],
      ["no-limite", agora - READ_ACK_TTL_MS],
      ["recente", agora - 1_000],
    ]);

    podarLeiturasAntigas(leituras, agora);

    expect([...leituras.keys()].sort()).toEqual(["no-limite", "recente"]);
  });

  it("mapa vazio não quebra", () => {
    const leituras = new Map<string, number>();
    expect(() => podarLeiturasAntigas(leituras, Date.now())).not.toThrow();
    expect(leituras.size).toBe(0);
  });
});

describe("mesclarPagina0", () => {
  it("página 0 nova na frente; páginas profundas preservadas", () => {
    const anteriores = [item("A", 0), item("B", 0), item("C", 0)];
    const pagina0 = [item("B", 2), item("A", 0)];

    const r = mesclarPagina0(anteriores, pagina0);

    expect(r.map((c) => c.externalItemId)).toEqual(["B", "A", "C"]);
    expect(r[0].unreadCount).toBe(2); // valor NOVO do servidor
  });

  it("nada é duplicado quando a página 0 repete tudo", () => {
    const anteriores = [item("A", 0), item("B", 0)];
    const r = mesclarPagina0(anteriores, [item("A", 1), item("B", 0)]);
    expect(r).toHaveLength(2);
  });

  it("conversa empurrada para fora da página 0 desce, não some", () => {
    const anteriores = [item("A", 0), item("B", 0)];
    // "NOVA" chegou e empurrou "A" para fora da página 0.
    const r = mesclarPagina0(anteriores, [item("NOVA", 1), item("B", 0)]);
    expect(r.map((c) => c.externalItemId)).toEqual(["NOVA", "B", "A"]);
  });
});
