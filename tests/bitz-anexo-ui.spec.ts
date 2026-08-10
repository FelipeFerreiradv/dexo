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

const hook = lerCodigo("hooks/use-bitz-anexo.ts");
const capacidades = lerCodigo("hooks/use-bitz-capacidades.ts");
const chat = lerCodigo("hooks/use-bitz-chat.ts");
const cartao = lerCodigo("components/bitz/bitz-anexo.tsx");
const composer = lerCodigo("components/bitz/bitz-composer.tsx");
const painel = lerCodigo("components/bitz/bitz-panel.tsx");

// ===========================================================================
// FASE 8 — o anexo, do lado do navegador.
//
// A suíte roda em `environment: "node"`, sem jsdom, sem `<input type=file>` e
// sem `createImageBitmap`, então estas verificações são sobre o TEXTO-FONTE. É
// o precedente da casa (`ai-widget-contract.spec.ts`, `bitz-audio-ui.spec.ts`),
// e cobre exatamente os erros que dariam para cometer aqui — todos invisíveis
// num teste de unidade: mandar a leitura sem o lojista conferir, perder a
// rotação EXIF da foto, deixar o anexo grudado na conversa toda, e oferecer um
// clipe que sempre falha.
// ===========================================================================

describe("⭐ ler não é perguntar", () => {
  it("o cartão da leitura fica ACIMA do composer, e é o lojista que envia", () => {
    // Se a leitura virasse pergunta sozinha, um código lido errado viraria uma
    // resposta certa sobre a peça errada — e gastaria uma mensagem da cota.
    expect(painel).toContain("<BitzAnexo");
    expect(hook, "o hook do anexo não pode chamar /ai/chat").not.toContain(
      "/ai/chat",
    );
  });

  it("⭐ a leitura INTEIRA é mostrável — nada viaja escondido", () => {
    // Fechado o cartão mostra o resumo; aberto, tudo que vai junto da pergunta.
    expect(cartao).toContain("anexo.leitura");
    expect(cartao).toMatch(/aria-expanded/);
  });

  it("⭐ o anexo SAI DA MESA ao enviar — não gruda na conversa inteira", () => {
    // Deixá-lo colado repetiria a mesma foto em toda pergunta seguinte, e o
    // lojista pagaria o contexto dela sem nunca ter pedido.
    const perguntar = painel.slice(
      painel.indexOf("const perguntar"),
      painel.indexOf("return ("),
    );
    expect(perguntar).toContain("anexo.remover()");
    expect(perguntar).toContain("send(");
  });
});

describe("⭐ o clipe só aparece quando o servidor sabe ler", () => {
  it("a lista de extensões vem do SERVIDOR, nunca chumbada no front", () => {
    // Uma lista fixa aqui divergiria da realidade no dia em que o cliente
    // trocasse a rota de imagem, e o lojista escolheria uma foto para receber
    // erro.
    expect(capacidades).toContain("/ai/capacidades");
    expect(painel).toContain("aceita={extensoesAceitas}");
    expect(composer).toContain("aceita!.join(\",\")");
  });

  it("sem extensão nenhuma, volta o placeholder 'em breve'", () => {
    expect(composer).toContain("const podeAnexar = !!onArquivo && !!aceita?.length");
    expect(composer).toContain("EmBreve");
  });

  it("falha da sonda é FECHADA: nem microfone nem clipe", () => {
    expect(capacidades).toMatch(/anexos: \[\]/);
    expect(capacidades).toMatch(/audio: false/);
  });

  it("extensão que não parece extensão é descartada antes do accept", () => {
    // Lixo no `accept` faz o navegador ignorar a lista INTEIRA, e o lojista
    // veria "todos os arquivos".
    expect(capacidades).toMatch(/\\\.\[a-z0-9\]\{1,8\}\$/);
  });
});

describe("⭐ a redução da foto no navegador", () => {
  it("⭐⭐ mantém a ORIENTAÇÃO da câmera", () => {
    // Sem `imageOrientation: "from-image"`, o canvas desenha os pixels crus e a
    // peça fotografada em pé chega DEITADA ao modelo, que lê o código ao
    // contrário ou não lê. É um bug de leitura causado por uma otimização de
    // upload, e ninguém liga uma coisa à outra.
    expect(hook).toContain('imageOrientation: "from-image"');
  });

  it("falha de redução volta ao ORIGINAL, nunca deixa de enviar", () => {
    // ⚠️ Asserção específica de propósito: `toContain("catch")` +
    // `toContain("return file")` passava mesmo trocando o corpo do catch por
    // `throw err` — havia três `return file` antes dele. Com o throw, uma foto
    // corrompida cairia no catch externo de `escolher` e o lojista leria "Sem
    // conexão para enviar o arquivo", que é mentira.
    const reduzir = hook.slice(
      hook.indexOf("async function reduzirImagem"),
      hook.indexOf("const ehImagem"),
    );
    expect(reduzir).toMatch(/catch\s*\{\s*return file;\s*\}/);
    expect(reduzir).not.toMatch(/catch[\s\S]{0,40}throw/);
  });

  it("⭐ trocar de arquivo DESCARTA o anterior no ato da escolha", () => {
    // Sem isto, a pergunta viajaria com a leitura da peça errada enquanto o
    // arquivo novo carrega — ou depois de ele falhar.
    const escolher = hook.slice(
      hook.indexOf("const escolher"),
      hook.indexOf("const remover"),
    );
    const antesDoFetch = escolher.slice(0, escolher.indexOf("fetch("));
    expect(antesDoFetch).toContain("setAnexo(null)");
  });

  it("⭐ enviar fica bloqueado enquanto a leitura está no ar", () => {
    // A leitura já foi paga; deixar a pergunta subir sem ela joga fora uma das
    // 15 do dia e entrega um "não vi foto nenhuma" que o lojista não entende.
    expect(painel).toContain('aguardandoAnexo={anexo.estado === "lendo"}');
    // No submit TAMBÉM, e não só no botão: o Enter não passa pelo botão.
    expect(composer).toMatch(/if \(!texto \|\| disabled \|\| aguardandoAnexo\)/);
    expect(composer).toContain("disabled={disabled || aguardandoAnexo}");
  });

  it("só imagem é reduzida — XML de NF-e vai como está", () => {
    // Passar um XML por canvas o destruiria.
    expect(hook).toContain("ehImagem(file) ? await reduzirImagem(file) : file");
  });
});

describe("⭐ corrida e limpeza", () => {
  it("trocar de arquivo invalida a leitura anterior que ainda está no ar", () => {
    // Sem isto, a resposta da PRIMEIRA leitura chegaria depois e sobrescreveria
    // a segunda: o lojista veria o cartão da foto que ele descartou.
    expect(hook).toContain("pedidoRef");
    expect(hook).toContain("meu !== pedidoRef.current");
  });

  it("remover invalida o que está em voo, não só o que está na tela", () => {
    const remover = hook.slice(
      hook.indexOf("const remover"),
      hook.indexOf("const limparErro"),
    );
    expect(remover).toContain("pedidoRef.current++");
    expect(remover).toContain("setAnexo(null)");
  });

  it("escolher o MESMO arquivo duas vezes seguidas volta a disparar", () => {
    // O `<input type=file>` não emite `change` quando o valor não muda. Sem
    // zerar, trocar a foto, se arrepender e voltar deixaria o clipe mudo.
    expect(composer).toContain("e.target.value = \"\"");
  });
});

describe("⭐ nada de arquivo guardado no navegador", () => {
  it("o arquivo não vai para storage nenhum, nem vira URL persistente", () => {
    expect(hook).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    expect(hook).not.toMatch(/createObjectURL/);
  });

  it("nenhuma chave ou nome de provedor no código de cliente", () => {
    for (const [nome, src] of [
      ["use-bitz-anexo", hook],
      ["bitz-anexo", cartao],
      ["use-bitz-chat", chat],
    ] as const) {
      expect(src, nome).not.toMatch(
        /API_KEY|gemini|deepseek|authorization|Bearer/i,
      );
    }
  });

  it("o FormData vai sem Content-Type manual — o navegador põe o boundary", () => {
    const escolher = hook.slice(
      hook.indexOf("const escolher"),
      hook.indexOf("const remover"),
    );
    expect(escolher).toContain("new FormData()");
    expect(escolher, "boundary quebrado").not.toMatch(/content-type/i);
  });
});

describe("o corpo do /ai/chat", () => {
  it("⭐ sem anexo, o corpo é byte a byte o de antes da Fase 8", () => {
    // `anexos` só aparece quando existe: um campo sempre presente mudaria o
    // contrato para todo mundo, inclusive para quem nunca vai anexar nada.
    expect(chat).toContain("comLeitura.length");
    expect(chat).toMatch(/\.\.\.\(comLeitura\.length[\s\S]{0,200}anexos:/);
  });

  it("só o que TEM leitura viaja", () => {
    expect(chat).toContain("filter((a) => a?.leitura?.trim())");
  });

  it("a bolha do usuário mostra só o RÓTULO, não a leitura inteira", () => {
    const mensagem = lerCodigo("components/bitz/bitz-message.tsx");
    expect(mensagem).toContain("message.anexos");
    expect(mensagem).not.toContain("a.leitura");
  });
});
