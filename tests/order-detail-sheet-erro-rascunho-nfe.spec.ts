import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// ──────────────────────────────────────────────────────────
// "Emitir NF-e" da tela de pedidos (order-detail-sheet.tsx) chama
// POST /fiscal/nfe/draft. Com a permissão "fiscal" cobrada na API, o colaborador
// sem acesso recebe 403 { message, code: "PAGE_FORBIDDEN" } — sem `error`. A tela
// lia só `err?.error` e mostraria "Verifique a configuração fiscal", mandando a
// pessoa mexer numa configuração que não é o problema.
//
// Em vez de só procurar a linha no fonte, o teste EXTRAI a expressão passada a
// setNfeError no ramo `!createRes.ok` e a avalia com as respostas reais da API.
// ──────────────────────────────────────────────────────────

const FONTE = fs.readFileSync(
  path.resolve(__dirname, "..", "app", "pedidos", "components", "order-detail-sheet.tsx"),
  "utf8",
);

function mensagemDeErro(): (err: unknown) => string {
  const ramo = FONTE.indexOf("if (!createRes.ok) {");
  expect(ramo, "ramo de erro do POST /fiscal/nfe/draft sumiu").toBeGreaterThan(-1);
  const inicio = FONTE.indexOf("setNfeError(", ramo);
  const fim = FONTE.indexOf(");", inicio);
  const expressao = FONTE.slice(inicio + "setNfeError(".length, fim).trim().replace(/,$/, "");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function("err", `return (${expressao});`) as (err: unknown) => string;
}

const FALLBACK = "Não foi possível criar o rascunho. Verifique a configuração fiscal.";

describe("order-detail-sheet — mensagem do erro ao criar o rascunho de NF-e", () => {
  const msg = mensagemDeErro();

  it("403 de permissão (só `message`) mostra o motivo real, não 'Verifique a configuração fiscal'", () => {
    expect(
      msg({
        message: "Seu acesso a esta área foi removido pelo administrador da conta.",
        code: "PAGE_FORBIDDEN",
        pageId: "fiscal",
      }),
    ).toBe("Seu acesso a esta área foi removido pelo administrador da conta.");
  });

  it("erro da rota fiscal (`error`) continua tendo precedência, como antes", () => {
    expect(msg({ error: "Configuração fiscal não encontrada", message: "outra" })).toBe(
      "Configuração fiscal não encontrada",
    );
  });

  it("corpo vazio ou não-JSON cai no texto de sempre", () => {
    expect(msg({})).toBe(FALLBACK);
    expect(msg(undefined)).toBe(FALLBACK);
  });
});
