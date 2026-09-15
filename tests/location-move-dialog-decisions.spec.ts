import { describe, it, expect } from "vitest";
import {
  canConfirmMove,
  describeMoveBlocker,
  describeMoveOutcome,
  describeUnbindConfirm,
} from "../app/localizacoes/lib/move-products-decisions";

/**
 * Chamado MK2 Autopeças, 09/2026.
 *
 * O diálogo "Mover Produtos" abria com `moveTargetLocationId = "__none__"` — o
 * sentinela de DESVINCULAR — e o botão de confirmar só checava `isMoving`. Quem
 * abrisse e clicasse sem mexer no seletor tirava a peça de todas as
 * localizações e recebia um toast VERDE de sucesso.
 *
 * E o mesmo handler mostrava `result.message` como sucesso sem olhar `count`:
 * `count === 0` virava "0 produto(s) movido(s) para X" em verde, tornando um
 * no-op indistinguível de um sucesso. Era o "cliquei em mover e o produto
 * continua aqui, sem erro na tela".
 *
 * Não há teste de componente neste repo (`@testing-library/react` não está
 * instalado e o jsdom está quebrado no ambiente), por isso a decisão vive em
 * módulo puro — mesmo padrão de `app/produtos/lib/location-scan-decision.ts`.
 */

const PRONTO = {
  targetLocationId: "loc-dest",
  selectedCount: 3,
  isMoving: false,
  optionsStatus: "ready" as const,
};

describe("canConfirmMove — a guarda que impede o desvínculo acidental", () => {
  it("bloqueia a confirmação enquanto nenhum destino foi escolhido", () => {
    expect(canConfirmMove({ ...PRONTO, targetLocationId: null })).toBe(false);
  });

  it("bloqueia quando o destino é string vazia", () => {
    expect(canConfirmMove({ ...PRONTO, targetLocationId: "" })).toBe(false);
  });

  it("bloqueia enquanto as localizações ainda estão carregando", () => {
    // O `fetchAllLocations()` não era aguardado: o seletor podia abrir vazio.
    expect(canConfirmMove({ ...PRONTO, optionsStatus: "loading" })).toBe(false);
    expect(canConfirmMove({ ...PRONTO, optionsStatus: "idle" })).toBe(false);
  });

  it("bloqueia quando o carregamento das localizações falhou", () => {
    // O catch era mudo: a tela ficava idêntica a "você não tem localização".
    expect(canConfirmMove({ ...PRONTO, optionsStatus: "error" })).toBe(false);
  });

  it("bloqueia quando nenhuma peça está selecionada", () => {
    expect(canConfirmMove({ ...PRONTO, selectedCount: 0 })).toBe(false);
  });

  it("bloqueia enquanto a requisição está em voo", () => {
    expect(canConfirmMove({ ...PRONTO, isMoving: true })).toBe(false);
  });

  // Controle positivo: a guarda não pode travar o caminho legítimo.
  it("libera quando há destino, opções prontas e nada em voo", () => {
    expect(canConfirmMove(PRONTO)).toBe(true);
  });
});

describe("describeMoveBlocker — dizer POR QUE está bloqueado", () => {
  it("pede o destino quando ele é o que falta", () => {
    expect(
      describeMoveBlocker({ ...PRONTO, targetLocationId: null }),
    ).toMatch(/destino/i);
  });

  it("avisa que as localizações estão carregando", () => {
    expect(describeMoveBlocker({ ...PRONTO, optionsStatus: "loading" })).toMatch(
      /carregando/i,
    );
  });

  it("avisa quando o carregamento falhou, em vez de ficar mudo", () => {
    expect(describeMoveBlocker({ ...PRONTO, optionsStatus: "error" })).toMatch(
      /não foi possível/i,
    );
  });

  it("não inventa impedimento quando está tudo certo", () => {
    expect(describeMoveBlocker(PRONTO)).toBeNull();
  });
});

describe("describeUnbindConfirm — desvincular vira ação explícita", () => {
  it("o texto diz, em palavras, que a peça ficará SEM localização", () => {
    const t = describeUnbindConfirm({ count: 4, locationCode: "1P2CX102" });
    expect(t.description).toMatch(/sem localização/i);
  });

  it("avisa que a peça some da tela de Localizações", () => {
    const t = describeUnbindConfirm({ count: 4 });
    expect(t.description).toMatch(/Localizações/);
  });

  it("aponta o caminho correto para quem queria mover, não desvincular", () => {
    const t = describeUnbindConfirm({ count: 4 });
    expect(t.description).toMatch(/bot(ã|a)o Mover/i);
  });

  it("nomeia a peça no caminho individual", () => {
    const t = describeUnbindConfirm({
      count: 1,
      productName: "Motor Arranque Corolla",
      locationCode: "1P1 CX58",
    });
    expect(t.description).toContain("Motor Arranque Corolla");
    expect(t.description).toContain("1P1 CX58");
  });

  it("informa a quantidade no caminho em lote", () => {
    const t = describeUnbindConfirm({ count: 12 });
    expect(t.title).toContain("12");
  });
});

describe("describeMoveOutcome — no-op nunca mais vira toast verde", () => {
  it("nunca devolve tom success quando count é 0", () => {
    const r = describeMoveOutcome({
      requested: 5,
      count: 0,
      targetLabel: "1P1 CX58",
      serverMessage: '0 produto(s) movido(s) para "CX58"',
    });
    expect(r.tone).toBe("warning");
    expect(r.message).not.toBe('0 produto(s) movido(s) para "CX58"');
  });

  it("nunca devolve tom success quando nada moveu, mesmo com count alto", () => {
    // O `updateMany` não tem predicado de origem: peça que JÁ estava no destino
    // entra no `count` sem ter saído do lugar.
    const r = describeMoveOutcome({
      requested: 5,
      count: 5,
      moved: 0,
      alreadyThere: 5,
      targetLabel: "1P1 CX58",
      serverMessage: '5 produto(s) movido(s) para "CX58"',
    });
    expect(r.tone).toBe("warning");
  });

  it("avisa quando só parte das peças mudou de lugar", () => {
    const r = describeMoveOutcome({
      requested: 10,
      count: 10,
      moved: 7,
      alreadyThere: 3,
      targetLabel: "1P1 CX58",
    });
    expect(r.tone).toBe("warning");
    expect(r.message).toContain("7");
    expect(r.message).toContain("10");
    expect(r.message).toMatch(/já estava/i);
  });

  it("desvincular com count 0 também é aviso", () => {
    const r = describeMoveOutcome({ requested: 3, count: 0, targetLabel: null });
    expect(r.tone).toBe("warning");
    expect(r.message).toMatch(/desvinculada/i);
  });

  // Controle negativo: o caminho feliz não pode ser reescrito nem rebaixado.
  it("preserva a mensagem do servidor no caminho feliz", () => {
    const r = describeMoveOutcome({
      requested: 3,
      count: 3,
      moved: 3,
      targetLabel: "GAL-1 > 1P1 CX58",
      serverMessage: '3 produto(s) movido(s) para "CX58"',
    });
    expect(r.tone).toBe("success");
    expect(r.message).toBe('3 produto(s) movido(s) para "CX58"');
  });

  it("cai para o count quando o servidor não mandou os campos novos", () => {
    // Compatibilidade: front novo contra API antiga (deploy em duas etapas).
    const r = describeMoveOutcome({
      requested: 2,
      count: 2,
      targetLabel: "1P1 CX58",
      serverMessage: "ok",
    });
    expect(r.tone).toBe("success");
  });
});
