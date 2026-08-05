import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { CACHE_KEY_FIELDS } from "../app/marketplaces/lib/category-suggest-v2";

// ──────────────────────────────────────────────────────────
// GUARDA DE DERIVA ENTRE A CHAVE DE CACHE E O QUE O CALCULO LE.
//
// `contextCacheSuffix` monta a chave do `suggestResultCache` com
// `CACHE_KEY_FIELDS` — os campos do contexto que de fato entram no calculo da
// sugestao. Antes ela usava `CONTEXT_FIELDS` (9 campos), o que era seguro POR
// CONSTRUCAO: qualquer campo novo entrava na chave sozinho.
//
// Ao reduzir para 4, essa seguranca automatica foi trocada por uma lista
// manual. O modo de falha e silencioso e caro: se alguem passar a ler
// `input.sourceVehicle` (ou qualquer outro) no ranking sem acrescentar o campo
// aqui, duas requisicoes que agora produzem respostas DIFERENTES continuarao
// compartilhando a mesma entrada de cache — e o servico devolvera a resposta
// errada, por ate 1 hora, sem erro nenhum no log.
//
// Este spec fecha esse buraco: ele varre o servico atras de leituras de
// `input.<campo>` e exige que toda leitura esteja coberta pela chave. E a
// contrapartida que torna a otimizacao aceitavel.
// ──────────────────────────────────────────────────────────

const FONTE = fs.readFileSync(
  path.resolve(
    __dirname,
    "..",
    "app",
    "marketplaces",
    "services",
    "category-suggestion.service.ts",
  ),
  "utf8",
);

/** `title` nao entra no sufixo porque ja e o corpo da chave. */
const FORA_DO_SUFIXO = new Set(["title"]);

function camposLidosDoContexto(): string[] {
  const lidos = new Set<string>();
  // Casa `input.brand`, `input.partNumber?.trim()`, `input.year ?? null` etc.
  const re = /\binput\.([A-Za-z_][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(FONTE)) !== null) {
    const campo = m[1];
    if (!FORA_DO_SUFIXO.has(campo)) lidos.add(campo);
  }
  return [...lidos].sort();
}

describe("chave do cache cobre tudo que o calculo le", () => {
  it("todo `input.<campo>` lido pelo serviço está em CACHE_KEY_FIELDS", () => {
    const lidos = camposLidosDoContexto();
    const naChave = new Set<string>(CACHE_KEY_FIELDS as readonly string[]);
    const descobertos = lidos.filter((c) => !naChave.has(c));

    expect(
      descobertos,
      `O serviço passou a ler ${descobertos.join(", ")} do contexto, mas esse(s) ` +
        `campo(s) não entram na chave do cache (CACHE_KEY_FIELDS). Duas ` +
        `requisições com respostas diferentes passariam a compartilhar a mesma ` +
        `entrada. Acrescente o campo em CACHE_KEY_FIELDS ` +
        `(app/marketplaces/lib/category-suggest-v2.ts).`,
    ).toEqual([]);
  });

  it("a varredura realmente encontra as leituras (senão o guard seria vazio)", () => {
    // Sem esta âncora, um refactor que renomeasse `input` faria a regex não
    // casar nada e o teste acima passaria sempre, sem proteger coisa alguma.
    const lidos = camposLidosDoContexto();
    expect(lidos).toContain("brand");
    expect(lidos).toContain("model");
    expect(lidos).toContain("year");
    expect(lidos).toContain("partNumber");
  });
});
