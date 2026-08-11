import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../app/lib/prisma", () => ({
  default: { systemLog: { create: async () => ({}) } },
}));

import { runTurn } from "../app/ai/agent/orchestrator";
import { scopeFromRequest } from "../app/ai/core/scope";
import {
  __pendingMockCompletions,
  __pushMockCompletion,
  __resetMockProvider,
} from "../app/ai/core/mock.provider";

// ===========================================================================
// ⭐ RESERVA E DEVOLUÇÃO DE COTA CAEM NO MESMO DIA.
//
// O contador de cota é por DIA UTC (`ProviderDailyUsage.day`). A reserva sobe
// o contador antes de chamar o modelo; a devolução desce quando nada foi
// cobrado. As duas TÊM que mirar a mesma linha.
//
// O defeito que este arquivo existe para impedir: `runTurn` passava `input.now`
// para as duas, e produção NUNCA manda `now` — `ai.routes.ts` monta o input sem
// ele. Com `undefined`, cada camada resolvia `new Date()` por conta própria, em
// momentos diferentes. Um turno que começa às 23:59:5x UTC e falha alguns
// segundos depois reservava no dia velho e DEVOLVIA NO DIA NOVO: decrementava
// um contador onde nunca reservou nada e liberava, de graça, um slot do dia
// seguinte.
//
// Janela pequena — a duração de um turno, uma vez por dia — e silenciosa, que é
// a pior combinação: some no meio do ruído e nunca é investigada.
//
// A verificação é comportamental de propósito. Um teste que só lesse o
// texto-fonte passaria com `now: agora` escrito nos dois lugares mesmo que
// `agora` fosse recalculado — o que importa é o VALOR que chega ao banco.
// ===========================================================================

const req = (user: unknown) => ({ user }) as any;
const ADMIN = { id: "a", dataOwnerId: "TENANT-A", parentUserId: null };

/** Instante a 600 ms da virada de dia UTC. */
const VESPERA = new Date("2026-08-07T23:59:59.400Z");

/**
 * Dublê que registra o `day` de cada toque no contador e faz o relógio andar
 * DEPOIS da reserva.
 *
 * O avanço é disparado de dentro do próprio `updateMany` porque é assim que o
 * turno real gasta tempo: a reserva acontece, o provedor demora, e só então a
 * devolução. Sem cruzar a meia-noite no meio, o teste passaria com o defeito.
 */
function montarDb(avancarMsAposReserva: number) {
  const toques: Array<{ provider: string; day: string; delta: number }> = [];
  let reservas = 0;

  return {
    toques,
    db: {
      aiConversation: {
        create: async ({ data }: any) => ({ id: "c1", summary: null, ...data }),
        findFirst: async () => null,
        update: async () => ({}),
      },
      aiMessage: {
        create: async ({ data }: any) => data,
        findMany: async () => [],
      },
      providerDailyUsage: {
        findUnique: async () => null,
        create: async () => ({ count: 1 }),
        upsert: async () => ({ count: 1 }),
        updateMany: async ({ where, data }: any) => {
          const delta = data?.count?.increment ?? -(data?.count?.decrement ?? 0);
          toques.push({ provider: where.provider, day: where.day, delta });
          reservas += delta > 0 ? 1 : 0;
          // Depois das duas reservas (tenant + global), o relógio vira.
          if (reservas === 2 && delta > 0) {
            vi.setSystemTime(
              new Date(VESPERA.getTime() + avancarMsAposReserva),
            );
          }
          return { count: 1 };
        },
      },
    },
  };
}

beforeEach(() => {
  // ⚠️ OBRIGATÓRIO, e não é zelo: o vitest carrega o `.env` do projeto, e o
  // `.env` de desenvolvimento tem `AI_PROVIDER=gemini`. Sem fixar aqui, o turno
  // roda contra o provedor de verdade, `provider.chat` estoura sem rede, o
  // `catch` de `chamar()` devolve `erro_provedor` e a FILA DO MOCK NUNCA É
  // CONSUMIDA — o teste passa pelo caminho errado, provando outra coisa.
  // Mesmo cuidado de tests/ai-advisory-turn.spec.ts:106-107.
  vi.stubEnv("NEXT_PUBLIC_AI_MODULE_ENABLED", "true");
  vi.stubEnv("AI_PROVIDER", "mock");
  __resetMockProvider();
  vi.useFakeTimers();
  vi.setSystemTime(VESPERA);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  __resetMockProvider();
});

describe("cota diária na virada do dia UTC", () => {
  it("⭐ o refund devolve no MESMO dia da reserva, mesmo cruzando a meia-noite", async () => {
    // Provedor falha sem reportar uso nenhum ⇒ é o caso em que devolver a cota
    // é justo, e o único caminho que chama `refundAiTurn`.
    __pushMockCompletion({ ok: false, reason: "timeout" });

    const espiao = montarDb(1_000); // +1 s ⇒ já é dia 08 quando o refund roda.

    const r = await runTurn({
      dataOwnerId: "TENANT-A",
      actorUserId: "a",
      message: "quanto eu vendi ontem?",
      db: espiao.db as any,
      scope: scopeFromRequest(req(ADMIN)) ?? undefined,
    });

    expect(r.degraded).toBe(true);

    const reservas = espiao.toques.filter((t) => t.delta > 0);
    const devolucoes = espiao.toques.filter((t) => t.delta < 0);

    // Guarda do próprio teste: sem reserva e sem devolução ele passaria vazio.
    expect(reservas.length, "reservas").toBe(2);
    expect(devolucoes.length, "devoluções").toBe(2);

    // O relógio realmente virou no meio do turno — senão não há o que provar.
    expect(new Date().toISOString().slice(0, 10)).toBe("2026-08-08");
    // E a falha veio da resposta encenada, não de um provedor real quebrando.
    expect(__pendingMockCompletions(), "resposta do mock não usada").toBe(0);

    for (const t of [...reservas, ...devolucoes]) {
      expect(t.day, `${t.provider} tocou o dia ${t.day}`).toBe("2026-08-07");
    }
  });

  it("dentro do mesmo dia o comportamento é idêntico ao de antes", async () => {
    __pushMockCompletion({ ok: false, reason: "timeout" });

    const espiao = montarDb(100); // +100 ms ⇒ continua dia 07.

    await runTurn({
      dataOwnerId: "TENANT-A",
      actorUserId: "a",
      message: "oi",
      db: espiao.db as any,
      scope: scopeFromRequest(req(ADMIN)) ?? undefined,
    });

    expect(espiao.toques.every((t) => t.day === "2026-08-07")).toBe(true);
    // Tenant e global, reservados e devolvidos — nem a mais, nem a menos.
    expect(espiao.toques.map((t) => `${t.provider}${t.delta > 0 ? "+" : "-"}`)).toEqual([
      "ai:tenant:TENANT-A+",
      "ai:global+",
      "ai:tenant:TENANT-A-",
      "ai:global-",
    ]);
  });

  it("turno que consumiu o modelo NÃO devolve cota — a guarda anterior segue de pé", async () => {
    // Uma chamada reportou tokens e a seguinte falhou: o provedor já cobrou, e
    // devolver o slot aqui faria o contador voltar enquanto a fatura sobe.
    __pushMockCompletion({
      content: "",
      toolCalls: [{ id: "1", name: "relatorio_vendas", args: {} }],
      usage: { inputTokens: 120, outputTokens: 8 },
    });
    __pushMockCompletion({ ok: false, reason: "erro_provedor" });

    const espiao = montarDb(1_000);

    await runTurn({
      dataOwnerId: "TENANT-A",
      actorUserId: "a",
      message: "quanto eu vendi em julho?",
      db: espiao.db as any,
      scope: scopeFromRequest(req(ADMIN)) ?? undefined,
    });

    // Guarda do próprio teste: se a fila do mock não tivesse sido consumida, o
    // turno teria falhado por outro motivo e a ausência de refund não provaria
    // nada. Zero pendentes = as duas respostas encenadas foram usadas.
    expect(__pendingMockCompletions(), "respostas do mock não usadas").toBe(0);
    expect(espiao.toques.filter((t) => t.delta > 0).length).toBe(2);
    expect(espiao.toques.filter((t) => t.delta < 0)).toEqual([]);
  });
});
