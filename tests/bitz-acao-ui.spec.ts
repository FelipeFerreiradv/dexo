import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const raiz = join(__dirname, "..");

/** Lê o fonte SEM comentários — eles citam de propósito o que NÃO se deve fazer. */
function lerCodigo(rel: string): string {
  return readFileSync(join(raiz, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const hook = lerCodigo("hooks/use-bitz-acao.ts");
const cartao = lerCodigo("components/bitz/bitz-acao.tsx");
const chat = lerCodigo("hooks/use-bitz-chat.ts");
const mensagem = lerCodigo("components/bitz/bitz-message.tsx");

// ===========================================================================
// FASE 9 — a confirmação humana, do lado do navegador.
//
// A suíte roda em `environment: "node"`, então estas verificações são sobre o
// TEXTO-FONTE — precedente da casa (`ai-widget-contract.spec.ts`). Elas cobrem
// os erros que dariam para cometer aqui, todos invisíveis num teste de unidade:
// mandar o payload junto do clique, deixar o cartão sumir depois de decidido, e
// esconder o aviso de marketplace abaixo dos botões.
// ===========================================================================

describe("⭐ o clique manda só um ID", () => {
  it("⭐⭐ a requisição de confirmar NÃO tem corpo", () => {
    // Se o payload viajasse pelo cliente, `POST /ai/acoes/:id/confirmar` seria
    // uma rota de escrita genérica com nome de confirmação — e um `curl`
    // mandaria `{preco: 1}` junto do "confirmo".
    const chamar = hook.slice(hook.indexOf("const chamar"), hook.length);
    expect(chamar).toContain('method: "POST"');
    expect(chamar, "corpo na confirmação").not.toMatch(/body:/);
    expect(chamar, "corpo na confirmação").not.toMatch(/JSON\.stringify/);
  });

  it("o id vai codificado na URL", () => {
    expect(hook).toContain("encodeURIComponent(acaoId)");
  });

  it("⭐ clique duplo não dispara duas requisições", () => {
    // A idempotência do servidor cobre o caso; esta guarda evita a corrida
    // chegar lá — e evita dois spinners disputando o mesmo estado.
    expect(hook).toContain("emVooRef");
    expect(hook).toMatch(/if \(emVooRef\.current\) return/);
  });

  it("⚠️ perda de conexão NÃO afirma que nada mudou", () => {
    // O servidor pode ter executado antes de a resposta se perder. Dizer "nada
    // foi alterado" ali seria mentir, e o lojista clicaria de novo.
    const captura = hook.slice(hook.indexOf("} catch {"), hook.length);
    expect(captura).toMatch(/Confira na tela/i);
    expect(captura).not.toMatch(/Nada foi alterado/i);
  });
});

describe("⭐ o cartão conta a verdade", () => {
  it("mostra `de → para` quando há valor anterior, e só `para` na criação", () => {
    // Um travessão no lugar do "de" sugeriria que havia valor e foi apagado.
    expect(cartao).toContain("c.de != null");
    expect(cartao).toContain("line-through");
  });

  it("⭐ o AVISO fica ACIMA dos botões", () => {
    // Quem decide precisa ver a consequência de marketplace ANTES de decidir.
    const posAviso = cartao.indexOf("acao.preview.aviso");
    const posBotoes = cartao.indexOf("Confirmar");
    expect(posAviso).toBeGreaterThan(-1);
    expect(posAviso).toBeLessThan(posBotoes);
  });

  it("⭐ o cartão NÃO some depois de decidido", () => {
    // Sumir deixaria a conversa dizendo "preparei o cadastro" sem nada em
    // volta, e o lojista sem saber se clicou ou imaginou que clicou.
    expect(cartao).toMatch(/estado === "confirmada"/);
    expect(cartao).toMatch(/estado === "cancelada"/);
    expect(cartao).toMatch(/Cancelado — nada foi alterado/);
  });

  it("os dois botões existem e desabilitam durante o envio", () => {
    expect(cartao).toContain("Confirmar");
    expect(cartao).toContain("Cancelar");
    expect(cartao).toMatch(/disabled=\{enviando\}/);
  });

  it("o erro do servidor aparece no cartão, não num toast", () => {
    expect(cartao).toMatch(/role="alert"/);
  });
});

describe("⭐ o cartão fica preso à mensagem que o explicou", () => {
  it("é renderizado DENTRO da bolha do assistente", () => {
    // Solto no rodapé, pareceria de outra pergunta — e o lojista confirmaria
    // uma alteração lendo a frase errada.
    expect(mensagem).toContain("message.acoes");
    expect(mensagem).toContain("<BitzAcaoCard");
  });

  it("⭐ sem proposta, a bolha continua exatamente como era", () => {
    expect(chat).toMatch(/\.\.\.\(acoes\.length \? \{ acoes \} : \{\}\)/);
  });

  it("propostas malformadas do servidor são descartadas, não quebram o chat", () => {
    expect(chat).toContain("lerAcoes(");
    expect(hook).toContain("export function lerAcoes");
    expect(hook).toMatch(/typeof a\.id === "string"/);
  });
});

describe("⭐ a decisão sobrevive ao fechar e reabrir o painel", () => {
  // ⚠️ Conserto de um achado: o `DialogPrimitive.Content` do Radix DESMONTA ao
  // fechar, levando junto o `useState` do cartão. Um cartão já executado voltava
  // a "Confira antes de confirmar", com o botão ativo — e o lojista, em dúvida
  // se o preço tinha mudado, clicava de novo.
  it("a decisão é gravada na MENSAGEM, que vive um nível acima", () => {
    expect(chat).toContain("const decidirAcao");
    expect(chat).toMatch(/decidida: status/);
    expect(chat).toContain("decidirAcao");
  });

  it("o cartão nasce do estado que veio da mensagem", () => {
    expect(hook).toMatch(/opts\?\.decidida \?\? "pendente"/);
    expect(cartao).toContain("decidida: acao.decidida");
  });

  it("e sobe a decisão assim que ela acontece", () => {
    expect(hook).toContain("opts?.aoDecidir?.(acaoId, decidido)");
    expect(mensagem).toContain("aoDecidir={aoDecidirAcao}");
  });
});

describe("higiene", () => {
  it("nenhuma chave, provedor ou modelo no código de cliente", () => {
    for (const [nome, src] of [
      ["use-bitz-acao", hook],
      ["bitz-acao", cartao],
    ] as const) {
      expect(src, nome).not.toMatch(
        /API_KEY|gemini|deepseek|authorization|Bearer/i,
      );
    }
  });

  it("⭐ o navegador não guarda proposta nenhuma", () => {
    // A proposta vive no servidor. Cache local abriria a porta para confirmar
    // uma coisa vendo outra.
    expect(hook).not.toMatch(/localStorage|sessionStorage|indexedDB/);
  });

  it("não existe botão de EXCLUIR em lugar nenhum do cartão", () => {
    expect(cartao).not.toMatch(/excluir|apagar|deletar/i);
  });
});
