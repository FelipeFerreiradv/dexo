import { describe, expect, it } from "vitest";

import {
  DEFAULT_INPUT_BUDGET_TOKENS,
  SUMMARY_MAX_CHARS,
  buildContextWindow,
  estimateMessagesTokens,
  estimateTokens,
} from "../app/ai/agent/context-window";
import type { AiMessage } from "../app/ai/core/types";

// ===========================================================================
// Janela de contexto. Custo é requisito de arquitetura: sem teto, uma conversa
// longa cresce o input linearmente e o gasto junto (o tráfego é ~15:1 a favor
// da entrada). Estes testes fixam o teto e o resumo do que sai dele.
// ===========================================================================

const msg = (role: AiMessage["role"], content: string): AiMessage => ({
  role,
  content,
});

describe("estimativa de tokens", () => {
  it("~4 chars por token", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  it("soma o overhead por mensagem", () => {
    expect(estimateMessagesTokens([msg("user", "a".repeat(400))])).toBe(104);
  });
});

describe("buildContextWindow", () => {
  it("histórico curto: passa inteiro e não gera resumo", () => {
    const history = [msg("user", "oi"), msg("assistant", "ola")];

    const r = buildContextWindow({ history });

    expect(r.messages).toHaveLength(2);
    expect(r.dropped).toBe(0);
    expect(r.summary).toBeNull();
  });

  it("estourou o orçamento: mantém as mais RECENTES e descarta as antigas", () => {
    // 40 mensagens de ~500 tokens = ~20k, bem acima do orçamento de 8k.
    const history = Array.from({ length: 40 }, (_, i) =>
      msg(i % 2 === 0 ? "user" : "assistant", `m${i} ${"x".repeat(2000)}`),
    );

    const r = buildContextWindow({ history });

    expect(r.dropped).toBeGreaterThan(0);
    expect(r.estimatedTokens).toBeLessThanOrEqual(DEFAULT_INPUT_BUDGET_TOKENS);
    // A última mensagem NUNCA pode sumir — é a pergunta atual.
    expect(r.messages[r.messages.length - 1]).toEqual(history[39]);
  });

  it("fixedCost (system prompt, RAG, tools) sai do mesmo orçamento", () => {
    const history = Array.from({ length: 20 }, (_, i) =>
      msg("user", `m${i} ${"x".repeat(2000)}`),
    );

    const semCusto = buildContextWindow({ history });
    const comCusto = buildContextWindow({ history, fixedCost: 6000 });

    expect(comCusto.messages.length).toBeLessThan(semCusto.messages.length);
  });

  it("uma única mensagem gigante ainda entra (senão o Bitz responderia ao vazio)", () => {
    const history = [msg("user", "x".repeat(100_000))];

    const r = buildContextWindow({ history });

    expect(r.messages).toHaveLength(1);
    expect(r.dropped).toBe(0);
  });

  it("o que sai da janela vira resumo EXTRATIVO (sem chamar LLM)", () => {
    const history = [
      msg("user", "quanto vendi em julho?"),
      msg("assistant", "R$ 84.320,00 em 213 pedidos."),
      ...Array.from({ length: 20 }, (_, i) =>
        msg("user", `depois ${i} ${"x".repeat(2000)}`),
      ),
    ];

    const r = buildContextWindow({ history });

    expect(r.summary).toContain("quanto vendi em julho?");
    expect(r.summary).toContain("Usuário:");
  });

  it("resumo anterior é preservado e concatenado", () => {
    const history = Array.from({ length: 20 }, (_, i) =>
      msg("user", `m${i} ${"x".repeat(2000)}`),
    );

    const r = buildContextWindow({
      history,
      previousSummary: "Usuário: pergunta bem antiga",
    });

    expect(r.summary).toContain("pergunta bem antiga");
  });

  it("resumo tem teto e corta pelo INÍCIO (o passado distante importa menos)", () => {
    const history = Array.from({ length: 30 }, (_, i) =>
      msg("user", `m${i} ${"x".repeat(2000)}`),
    );

    const r = buildContextWindow({
      history,
      previousSummary: "A".repeat(5000),
    });

    expect(r.summary!.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(r.summary!.startsWith("…")).toBe(true);
  });

  it("histórico vazio não quebra", () => {
    const r = buildContextWindow({ history: [] });
    expect(r.messages).toEqual([]);
    expect(r.summary).toBeNull();
  });
});
