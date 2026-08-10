import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const lerCodigo = (rel: string) =>
  readFileSync(join(__dirname, "..", rel), "utf8");

/**
 * O CÓDIGO sem os comentários — mesmo recurso de `ai-privacy.spec.ts`.
 *
 * ⚠️ Nasceu de um falso positivo real deste arquivo: a asserção de "não conecta
 * na saída de áudio" batia no COMENTÁRIO que explica por que não se deve
 * conectar. Apagar o comentário para o teste passar seria apagar justamente a
 * frase que impede alguém de reintroduzir a microfonia.
 */
const semComentarios = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const espectro = lerCodigo("components/bitz/bitz-espectro.tsx");
const espectroCodigo = semComentarios(espectro);
const escuta = lerCodigo("components/bitz/bitz-escuta.tsx");
const hook = lerCodigo("hooks/use-bitz-audio.ts");
const painel = lerCodigo("components/bitz/bitz-panel.tsx");

// ===========================================================================
// O ESPECTRO DE ONDAS da tela de escuta.
//
// ⚠️ ESTES TESTES LEEM O CÓDIGO-FONTE, e é o padrão da casa para UI neste
// repositório (`bitz-audio-ui.spec.ts`, `bitz-anexo-ui.spec.ts`): a suíte roda
// em `environment: "node"`, sem DOM, sem canvas e sem Web Audio. Não dá para
// afirmar que a onda desenha bonito; dá para afirmar que as decisões que
// tornam esta tela segura e barata continuam no lugar — que é onde mora a
// regressão silenciosa.
// ===========================================================================

describe("⭐ a onda lê o áudio DE VERDADE", () => {
  it("usa AnalyserNode no stream que está sendo gravado", () => {
    // A alternativa (CSS ou vídeo em loop) se mexe igual no silêncio e na fala,
    // e responde "estou te ouvindo" quando a resposta é "não".
    expect(espectro).toContain("createAnalyser");
    expect(espectro).toContain("createMediaStreamSource");
    expect(espectro).toContain("getByteFrequencyData");
  });

  it("⭐⭐ NÃO conecta na saída de áudio — isso seria microfonia", () => {
    // Ligar o analisador em `destination` devolve a própria voz pelo
    // alto-falante, com atraso. Em quem estiver sem fone, apita.
    expect(espectroCodigo).not.toMatch(/\.destination/);
  });

  it("o stream sai do hook e chega ao espectro pelo painel", () => {
    expect(hook).toMatch(/stream,/);
    expect(painel).toMatch(/stream=\{voz\.stream\}/);
    expect(escuta).toContain("<BitzEspectro");
  });

  it("⭐ o stream volta a null quando o microfone é solto", () => {
    // A onda não pode sobreviver ao microfone: desenhar depois do `stop()` das
    // trilhas sugeriria que ainda está gravando.
    const solta = hook.slice(
      hook.indexOf("const soltarMicrofone"),
      hook.indexOf("const enviar"),
    );
    expect(solta).toContain("setStream(null)");
  });
});

describe("⚠️ o custo por quadro", () => {
  it("⭐⭐ NENHUM useState dentro do laço de desenho", () => {
    // 60 quadros por segundo virando 60 renders do React travariam o painel
    // inteiro no celular do galpão — que é exatamente onde o áudio é usado.
    const laco = espectroCodigo.slice(espectroCodigo.indexOf("const desenhar"));
    expect(laco).not.toMatch(/useState|setState|set[A-Z]\w*\(/);
    expect(espectro).toContain("requestAnimationFrame");
  });

  it("⭐ cancela o quadro e FECHA o AudioContext ao desmontar", () => {
    // O navegador limita quantos AudioContext uma aba pode ter (~6 no Chrome).
    // Vazar um por gravação faria o sétimo áudio do dia lançar — e o sintoma
    // apareceria como "a onda parou", longe da causa.
    const limpeza = espectro.slice(espectro.lastIndexOf("return () => {"));
    expect(limpeza).toContain("cancelAnimationFrame");
    expect(limpeza).toMatch(/close\(\)/);
    expect(limpeza).toContain("disconnect");
  });

  it("respeita prefers-reduced-motion, sem laço nenhum", () => {
    expect(espectro).toContain("prefers-reduced-motion");
  });

  it("desenha na densidade da tela, senão a barra fica borrada", () => {
    expect(espectro).toContain("devicePixelRatio");
  });
});

describe("⚠️ a onda é enfeite, nunca caminho crítico", () => {
  it("navegador sem AudioContext cai na linha de base, não lança", () => {
    expect(espectro).toMatch(/webkitAudioContext/);
    expect(espectro).toMatch(/if \(!Contexto\)/);
    // E o caminho vivo inteiro está dentro de um try: um navegador que recuse o
    // contexto não pode derrubar a gravação, que é o que o lojista quer.
    expect(espectro).toMatch(/try \{[\s\S]*catch/);
  });

  it("a canvas é aria-hidden — quem anuncia é o cronômetro", () => {
    expect(espectro).toContain("aria-hidden");
  });
});

describe("a tela de escuta depois do redesenho", () => {
  it("⭐ o mascote saiu; o espectro é o protagonista", () => {
    expect(escuta).not.toContain("BitzMascot");
  });

  it("⚠️ as duas saídas e o aviso de privacidade continuam de pé", () => {
    // O que o redesenho NÃO podia levar junto. `bitz-audio-ui.spec.ts` também
    // prende isso; aqui é o lembrete de que estilo não move comportamento.
    expect(escuta).toContain("onCancelar");
    expect(escuta).toContain("onParar");
    expect(escuta).toMatch(/Cancelar/);
    expect(escuta).toMatch(/Pronto/);
    expect(escuta).toMatch(/Escape/);
    expect(escuta).toMatch(/apagado depois de transcrito/i);
  });

  it("⭐ é escura em QUALQUER tema, e isso está declarado", () => {
    // A única superfície do sistema que não segue o tema do usuário. Se um dia
    // alguém trocar por tokens, este teste pergunta se foi de propósito.
    expect(escuta).toContain("#0e1f2a");
    expect(escuta).toMatch(/em qualquer tema|EM QUALQUER TEMA/i);
  });

  it("⚠️ o halo que pulsa NÃO carrega classe de translate", () => {
    // `bitz-escuta-aura` anima `transform: scale()`. Um `translate` de
    // posicionamento no MESMO elemento é sobrescrito no primeiro quadro e o
    // brilho salta para o canto — quase foi para produção assim.
    const i = espectro.length && escuta.indexOf("bitz-escuta-aura");
    const linha = escuta.slice(i - 400, i + 120);
    expect(linha).not.toMatch(/-translate-[xy]-1\/2[^"]*bitz-escuta-aura/);
  });
});
