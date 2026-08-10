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

const hook = lerCodigo("hooks/use-bitz-audio.ts");
const capacidades = lerCodigo("hooks/use-bitz-capacidades.ts");
const escuta = lerCodigo("components/bitz/bitz-escuta.tsx");
const composer = lerCodigo("components/bitz/bitz-composer.tsx");
const painel = lerCodigo("components/bitz/bitz-panel.tsx");

// ===========================================================================
// FASE 7 — a gravação de voz, do lado do navegador.
//
// A suíte roda em `environment: "node"`, sem jsdom e sem `MediaRecorder`, então
// estas verificações são sobre o TEXTO-FONTE. É o precedente da casa para o
// contrato de UI (`ai-widget-contract.spec.ts`), e cobre exatamente os erros
// que dariam para cometer aqui — todos eles invisíveis num teste de unidade:
// pedir o microfone cedo demais, deixar a trilha aberta, e mandar direto uma
// transcrição que o lojista não conferiu.
// ===========================================================================

describe("⭐ permissão de microfone", () => {
  it("NUNCA é pedida na montagem — só por gesto do usuário", () => {
    // Pedir no mount faz o navegador mostrar o balão sozinho, o lojista nega
    // por reflexo, e o recurso fica bloqueado no domínio sem caminho de volta
    // dentro do app. Mesmo precedente de `app/scan/components/qr-camera.tsx`.
    const efeitos = hook.match(/React\.useEffect\([\s\S]*?\n  \}/g) ?? [];
    for (const efeito of efeitos) {
      expect(efeito, "getUserMedia dentro de useEffect").not.toContain(
        "getUserMedia",
      );
    }
    // Ela mora na função que o botão chama.
    expect(hook).toMatch(/const gravar = React\.useCallback\(/);
    const gravar = hook.slice(hook.indexOf("const gravar"));
    expect(gravar).toContain("getUserMedia");
  });

  it("a máquina de estados é explícita, como no scanner de QR", () => {
    for (const estado of ["parado", "pedindo", "gravando", "enviando", "erro"]) {
      expect(hook).toContain(`"${estado}"`);
    }
  });
});

describe("⭐ a trilha do microfone é sempre solta", () => {
  it("existe UM ponto de desligamento, e ele para todas as trilhas", () => {
    // Um MediaStream vivo mantém a luz do microfone acesa e o indicador de
    // gravação na aba. É o tipo de vazamento que o cliente vê.
    expect(hook).toMatch(/getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/);
  });

  it("a desmontagem do painel solta o microfone", () => {
    // Fechar o chat no meio de uma gravação não pode deixar o microfone aberto.
    expect(hook).toMatch(/useEffect\(\(\) => soltarMicrofone, \[soltarMicrofone\]\)/);
  });

  it("⭐ o microfone é solto ANTES do upload, não depois", () => {
    // Segurar a trilha durante o envio deixaria a luz acesa sem estar gravando
    // — o usuário acharia que ainda está sendo ouvido.
    const onstop = hook.slice(
      hook.indexOf("recorder.onstop"),
      hook.indexOf("recorder.start()"),
    );
    expect(onstop.indexOf("soltarMicrofone()")).toBeGreaterThan(-1);
    expect(onstop.indexOf("soltarMicrofone()")).toBeLessThan(
      onstop.indexOf("enviar(blob)"),
    );
  });

  it("o relógio do contador também é limpo junto", () => {
    const soltar = hook.slice(
      hook.indexOf("const soltarMicrofone"),
      hook.indexOf("const enviar"),
    );
    expect(soltar).toContain("clearInterval");
  });
});

describe("⭐ o áudio não vira pergunta sozinho", () => {
  it("a transcrição cai no CAMPO, e o envio continua sendo do usuário", () => {
    // Transcrição erra nome de peça. Mandar direto faria o Bitz responder a uma
    // pergunta que o lojista não fez, gastando uma mensagem da cota dele.
    const uso = painel.slice(
      painel.indexOf("const voz = useBitzAudio"),
      painel.indexOf("const escutando"),
    );
    expect(uso).toContain("setDraft");
    expect(uso, "não pode chamar send/perguntar").not.toMatch(
      /\bsend\(|\bperguntar\(/,
    );
  });

  it("cancelar joga os bytes fora em vez de enviar", () => {
    expect(hook).toContain("canceladoRef");
    const onstop = hook.slice(
      hook.indexOf("recorder.onstop"),
      hook.indexOf("recorder.start()"),
    );
    // O `return` do cancelamento vem ANTES da montagem do blob e do envio.
    expect(onstop.indexOf("canceladoRef.current")).toBeLessThan(
      onstop.indexOf("new Blob"),
    );
  });

  it("a tela de escuta tem as DUAS saídas, e elas são diferentes", () => {
    expect(escuta).toContain("onCancelar");
    expect(escuta).toContain("onParar");
    expect(escuta).toMatch(/Cancelar/);
    expect(escuta).toMatch(/Pronto/);
    // Esc é a saída que não custa nada.
    expect(escuta).toMatch(/Escape/);
  });
});

describe("⭐ o microfone só aparece quando funciona", () => {
  it("o composer mantém o placeholder quando não há `onMicrofone`", () => {
    // Botão que sempre falha é pior que botão nenhum: o lojista grava, espera
    // e leva um erro.
    expect(composer).toMatch(/onMicrofone \?/);
    expect(composer).toContain("em breve");
  });

  it("o painel só passa `onMicrofone` quando o servidor confirma", () => {
    expect(painel).toMatch(
      /onMicrofone=\{audioDisponivel \? voz\.gravar : undefined\}/,
    );
  });

  it("a sonda de capacidade falha FECHADA", () => {
    // Sem resposta, `audio` fica false e o microfone não aparece.
    expect(capacidades).toMatch(/audio: false/);
    expect(capacidades).toContain("Boolean(data?.audio)");
  });

  it("⭐ a sonda NÃO entrou no /ai/entitlement, que roda em toda página", () => {
    // Aquela sonda decide se o mascote aparece e é chamada em toda navegação.
    // Esta informação só interessa a quem ABRIU o chat.
    expect(capacidades).toContain("/ai/capacidades");
    const entitlement = lerCodigo("hooks/use-bitz-entitlement.ts");
    expect(entitlement).not.toContain("capacidades");
    expect(entitlement).not.toContain("audio");
  });

  it("no máximo UMA consulta por carregamento de página", () => {
    // O painel abre e fecha dezenas de vezes por dia; a capacidade do servidor
    // não muda entre um clique e outro.
    expect(capacidades).toMatch(/^let cache/m);
    expect(capacidades).toMatch(/emVoo \?\?=/);
  });
});

describe("limites e privacidade", () => {
  it("a duração é limitada no navegador", () => {
    const max = Number(hook.match(/MAX_SEGUNDOS = (\d+)/)?.[1] ?? "0");
    expect(max).toBeGreaterThan(0);
    expect(max).toBeLessThanOrEqual(120);
    // O corte por tempo tem que ser automático, não um pedido educado.
    expect(hook).toMatch(/>= MAX_SEGUNDOS\) parar\(\)/);
  });

  it("⭐ o aviso de que o áudio é apagado está NA TELA", () => {
    // Privacidade que só existe num termo que ninguém lê não conta.
    expect(escuta).toMatch(/apagado depois de transcrito/i);
  });

  it("o áudio nunca é gravado em disco nem em storage do navegador", () => {
    expect(hook).not.toMatch(/localStorage|sessionStorage|indexedDB|createObjectURL/);
  });

  it("nenhuma chave ou nome de provedor no código de cliente", () => {
    for (const [nome, src] of [
      ["use-bitz-audio", hook],
      ["use-bitz-capacidades", capacidades],
      ["bitz-escuta", escuta],
    ] as const) {
      expect(src, nome).not.toMatch(
        /API_KEY|gemini|deepseek|authorization|Bearer/i,
      );
    }
  });

  it("o FormData vai sem Content-Type manual — o navegador põe o boundary", () => {
    const enviar = hook.slice(hook.indexOf("const enviar"), hook.indexOf("const parar"));
    expect(enviar).toContain("new FormData()");
    expect(enviar, "boundary quebrado").not.toMatch(/Content-Type|content-type/);
  });
});

describe("mensagens de erro", () => {
  it("traduzem o erro do navegador em português, sem nome técnico", () => {
    const fn = hook.slice(
      hook.indexOf("function mensagemDoErro"),
      hook.indexOf("export function useBitzAudio"),
    );
    for (const caso of ["NotAllowedError", "NotFoundError", "NotReadableError"]) {
      expect(fn).toContain(caso);
    }
    // O nome técnico é lido, nunca mostrado.
    expect(fn).not.toMatch(/return[^;]*NotAllowedError/);
  });

  it("⭐ toda falha de áudio oferece a saída que continua existindo", () => {
    // O chat inteiro segue funcionando por escrito.
    expect(hook).toMatch(/escrever a pergunta/);
  });

  it("o erro aparece colado no composer, não num toast que some", () => {
    expect(painel).toContain("voz.erro");
    expect(painel).toMatch(/role="alert"/);
  });
});
