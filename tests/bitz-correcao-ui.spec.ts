import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { fraseDeCorrecao } from "../components/bitz/bitz-constants";

const raiz = join(__dirname, "..");

/** Lê o fonte SEM comentários — eles citam de propósito o que NÃO se deve fazer. */
function lerCodigo(rel: string): string {
  return readFileSync(join(raiz, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const cartao = lerCodigo("components/bitz/bitz-acao.tsx");
const hook = lerCodigo("hooks/use-bitz-acao.ts");
const mensagem = lerCodigo("components/bitz/bitz-message.tsx");
const composer = lerCodigo("components/bitz/bitz-composer.tsx");

// ===========================================================================
// P3.1 — o caminho de correção.
//
// O atrito que ele tira: trocar UM campo de uma proposta custava reditar a
// frase inteira. Num cadastro de sucata com marca, modelo, ano, cor, placa e
// custo, ditar tudo de novo por causa da cor é o que faz o lojista desistir do
// chat e voltar para o formulário.
//
// ⚠️ HONESTIDADE SOBRE O QUE ESTE SPEC PROVA. A suíte roda em
// `environment: "node"` e o repositório não tem `@testing-library/react`: não
// há como RENDERIZAR o cartão aqui. Então:
//
//   - `fraseDeCorrecao` é pura e testada DE VERDADE, executando;
//   - as duas garantias estruturais são conferidas no TEXTO-FONTE, precedente
//     da casa (`bitz-acao-ui.spec.ts`, `ai-widget-contract.spec.ts`). Elas
//     provam que a linha existe, não que ela roda — e isso está dito aqui em
//     vez de ficar implícito.
// ===========================================================================

describe("⭐ a frase que abre o campo", () => {
  it("manda REFAZER — é uma proposta nova, não uma edição da antiga", () => {
    expect(fraseDeCorrecao("Cadastrar sucata")).toMatch(/^Refaz /);
  });

  it("cita a proposta, para o modelo saber o que reaproveitar", () => {
    expect(fraseDeCorrecao("Cadastrar sucata")).toContain("cadastrar sucata");
  });

  it("⚠️ termina com ESPAÇO — senão vira '…, masa cor é prata'", () => {
    const f = fraseDeCorrecao("Cadastrar sucata");
    expect(f.endsWith(" ")).toBe(true);
    // E a emenda com o que o lojista dita tem de sair legível.
    expect(`${f}a cor é prata`).toBe(
      'Refaz "cadastrar sucata", mas a cor é prata',
    );
  });

  it("título torto não quebra a frase", () => {
    expect(fraseDeCorrecao("  Preencher DADOS fiscais  ")).toBe(
      'Refaz "preencher dados fiscais", mas ',
    );
    expect(fraseDeCorrecao(undefined as any)).toBe('Refaz "", mas ');
  });
});

describe("⭐⭐ corrigir CANCELA antes de abrir o campo", () => {
  it("o cartão só chama `aoCorrigir` se o cancelamento voltou verdadeiro", () => {
    // Sem isto, um cancelamento que falhou deixaria a proposta velha pendente
    // ao lado da nova — duas propostas quase idênticas na tela, e o convite
    // para confirmar a errada.
    expect(cartao).toMatch(/if \(await cancelar\(\)\) aoCorrigir\?\./);
  });

  it("e o hook devolve `false` nos dois caminhos de falha", () => {
    // O `Promise<boolean>` existe só para o cartão poder decidir. Se o hook
    // voltasse `undefined` no erro, o `if` acima nunca barraria nada.
    expect(hook).toMatch(/Promise<boolean>/);
    // Falha de negócio (resposta com ok:false) e falha de rede (catch).
    const retornosFalse = hook.match(/return false;/g) ?? [];
    expect(retornosFalse.length).toBeGreaterThanOrEqual(2);
  });
});

describe("⚠️ só a última bolha oferece correção", () => {
  it("cartão de turno antigo não recebe `aoCorrigir`", () => {
    // Mesma regra das opções clicáveis: corrigir uma proposta de três turnos
    // atrás cancelaria de graça e abriria o campo fora de contexto.
    expect(mensagem).toMatch(
      /aoCorrigir=\{ehUltima \? aoCorrigirAcao : undefined\}/,
    );
  });
});

describe("⭐ o cursor vai para o FIM do campo", () => {
  it("o composer posiciona a seleção depois do texto", () => {
    // `focus()` sozinho pode devolver a seleção anterior — posição 0 num campo
    // recém-preenchido de fora —, e a correção sairia ANTES da frase.
    expect(composer).toMatch(
      /setSelectionRange\(el\.value\.length, el\.value\.length\)/,
    );
  });

  it("⚠️ o efeito depende do pedido de foco, NUNCA do valor digitado", () => {
    // Com `value` na lista, o cursor pularia para o fim a cada tecla e o
    // lojista não conseguiria editar o meio da própria frase.
    const efeito = composer.slice(composer.indexOf("focarNoFim"));
    expect(efeito).toMatch(/\}, \[focarNoFim\]\);/);
  });
});
