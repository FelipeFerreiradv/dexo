import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  BARRAS,
  BIN_MINIMO,
  alturaDaBarra,
  alturaEmRepouso,
  binDaBarra,
  energiaDaBarra,
  tetoDaBarra,
} from "../components/bitz/bitz-espectro-math";

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

const meio = (BARRAS - 1) / 2;
const BINS = 512;
/** Frequência do centro de um bin, com FFT de 1024 a 48 kHz. */
const hz = (bin: number) => (bin * 48000) / 1024;

// ===========================================================================
// ⭐⭐ A MATEMÁTICA DA ONDA — testada com NÚMERO, não com texto de arquivo.
//
// ⚠️ ESTA SEÇÃO EXISTE POR CAUSA DE UM DEFEITO QUE FOI PARA A MÃO DO DONO.
// A primeira versão do espectro subiu com toda a mecânica certa — analisador
// ligado, laço rodando, contexto fechando — e a onda ficava PARADA. Os testes
// da época liam o código-fonte e estavam todos verdes, porque toda linha que
// eles procuravam existia mesmo. O que ninguém tinha perguntado era o número:
// as barras centrais liam o bin 0 da FFT, que é a componente contínua (0 Hz) e
// vale ~zero por definição — e o centro é justamente onde ficam as barras mais
// altas, as que a pessoa olha.
//
// Asserção sobre texto prova que a linha existe. Só a asserção sobre o valor
// prova que ela calcula certo.
// ===========================================================================

describe("⭐⭐ que frequência cada barra lê", () => {
  it("NENHUMA barra lê o bin 0 (contínua) nem o bin 1 (infrassom)", () => {
    for (let d = 0; d <= meio; d++) {
      const bin = binDaBarra(d, meio, BINS);
      expect(bin, `barra a ${d} do centro caiu no bin ${bin}`).toBeGreaterThanOrEqual(
        BIN_MINIMO,
      );
    }
  });

  it("⭐ o CENTRO fica na fundamental da voz humana (85–255 Hz)", () => {
    // É a faixa onde a fala tem mais energia, e o centro é a parte mais visível
    // da onda. Mandá-lo para os agudos deixaria a onda tímida na fala normal.
    const centro = hz(binDaBarra(0, meio, BINS));
    expect(centro).toBeGreaterThan(60);
    expect(centro).toBeLessThan(260);
  });

  it("as pontas varrem os agudos, e param antes do inaudível", () => {
    const ponta = hz(binDaBarra(meio, meio, BINS));
    expect(ponta).toBeGreaterThan(4000);
    expect(ponta).toBeLessThan(9000);
  });

  it("a distribuição é monotônica — cada barra abre mais que a anterior", () => {
    let anterior = -1;
    for (let d = 0; d <= meio; d++) {
      const bin = binDaBarra(d, meio, BINS);
      expect(bin).toBeGreaterThanOrEqual(anterior);
      anterior = bin;
    }
  });

  it("⚠️ metade das barras cobre a região da fala (até ~2 kHz)", () => {
    // Se a curva jogar quase tudo para os agudos, a onda fica parada numa
    // conversa normal — que foi exatamente o sintoma relatado.
    let naFala = 0;
    for (let d = 0; d <= meio; d++) {
      if (hz(binDaBarra(d, meio, BINS)) <= 2000) naFala++;
    }
    expect(naFala / (meio + 1)).toBeGreaterThan(0.5);
  });

  it("nunca estoura o array de faixas, nem com FFT pequena", () => {
    for (const bins of [32, 64, 128, 512, 1024]) {
      for (let d = 0; d <= meio; d++) {
        const bin = binDaBarra(d, meio, bins);
        expect(bin).toBeLessThan(bins);
        expect(bin).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe("⭐ silêncio é achatado, fala é grande", () => {
  it("o ruído de sala vira ZERO, não uma barriga permanente", () => {
    // `getByteFrequencyData` começa a janela em −100 dB, então sala quieta
    // devolve 40–60 em várias faixas. Sem descontar, a onda tem barriga e o
    // contraste entre calado e falando some.
    expect(energiaDaBarra(0)).toBe(0);
    expect(energiaDaBarra(40)).toBe(0);
    expect(energiaDaBarra(46)).toBe(0);
  });

  it("⭐ fala normal enche mais da metade da onda", () => {
    // ~−50 dB numa faixa forte da voz é conversa normal a um palmo do
    // microfone. Se isso não move a onda, o recurso não cumpre a função.
    const alturaFalando = alturaDaBarra(180, 0);
    expect(alturaFalando).toBeGreaterThan(0.55);
  });

  it("e o silêncio fica perto do chão", () => {
    expect(alturaDaBarra(40, 0)).toBeLessThan(0.06);
  });

  it("⚠️ a diferença entre calado e falando é de MÚLTIPLAS vezes", () => {
    // A asserção que traduz o pedido do dono: "quando eu falar, ele tem que se
    // mexer". Um fator pequeno seria movimento invisível a olho nu.
    const calado = alturaDaBarra(45, 0);
    const falando = alturaDaBarra(180, 0);
    expect(falando / calado).toBeGreaterThan(8);
  });

  it("é monotônica: mais volume nunca dá barra menor", () => {
    let anterior = -1;
    for (let byte = 0; byte <= 255; byte += 5) {
      const h = alturaDaBarra(byte, 0.3);
      expect(h).toBeGreaterThanOrEqual(anterior);
      anterior = h;
    }
    expect(energiaDaBarra(255)).toBeCloseTo(1, 5);
  });
});

describe("a silhueta de fuso", () => {
  it("o centro é o mais alto e as pontas somem", () => {
    expect(tetoDaBarra(0)).toBeCloseTo(1, 5);
    expect(tetoDaBarra(1)).toBeCloseTo(0, 5);
    expect(tetoDaBarra(0.5)).toBeLessThan(tetoDaBarra(0.25));
  });

  it("no repouso a onda não é uma linha reta — é o fuso baixinho", () => {
    expect(alturaEmRepouso(0)).toBeGreaterThan(alturaEmRepouso(0.5));
    expect(alturaEmRepouso(0)).toBeLessThan(0.1);
  });
});

// ===========================================================================
// E as decisões que só o código-fonte pode contar.
// ===========================================================================

describe("⭐ a onda lê o áudio DE VERDADE", () => {
  it("usa AnalyserNode no stream que está sendo gravado", () => {
    expect(espectro).toContain("createAnalyser");
    expect(espectro).toContain("createMediaStreamSource");
    expect(espectro).toContain("getByteFrequencyData");
  });

  it("⭐⭐ NÃO conecta na saída de áudio — isso seria microfonia", () => {
    expect(espectroCodigo).not.toMatch(/\.destination/);
  });

  it("⭐⭐ lê o stream por REF, a cada quadro — não por prop de valor", () => {
    // O defeito: com o stream como prop, a onda dependia de o React
    // re-renderizar no instante certo entre `getUserMedia` resolver e o
    // `MediaRecorder` começar. Se naquele render fosse `null`, ficava parada
    // para sempre — sem erro, sem aviso, com a tela parecendo funcionar.
    expect(hook).toMatch(/streamRef,/);
    expect(painel).toMatch(/streamRef=\{voz\.streamRef\}/);
    expect(espectroCodigo).toContain("streamRef.current");
    // E a leitura acontece DENTRO do laço, não uma vez na montagem.
    const laco = espectroCodigo.slice(espectroCodigo.indexOf("passoDoQuadro"));
    expect(laco).toContain("streamRef.current");
  });

  it("⭐ o ref é zerado quando o microfone é solto", () => {
    const solta = hook.slice(
      hook.indexOf("const soltarMicrofone"),
      hook.indexOf("const enviar"),
    );
    expect(solta).toContain("streamRef.current = null");
  });
});

describe("⚠️ o custo por quadro", () => {
  it("⭐⭐ NENHUM useState dentro do laço de desenho", () => {
    const laco = espectroCodigo.slice(espectroCodigo.indexOf("const desenhar"));
    expect(laco).not.toMatch(/useState|setState|set[A-Z]\w*\(/);
    expect(espectro).toContain("requestAnimationFrame");
  });

  it("⭐ cancela o quadro e FECHA o AudioContext ao desmontar", () => {
    const limpeza = espectroCodigo.slice(
      espectroCodigo.lastIndexOf("return () => {"),
    );
    expect(limpeza).toContain("cancelAnimationFrame");
    expect(limpeza).toMatch(/close\(\)/);
    expect(limpeza).toContain("disconnect");
  });

  it("desenha na densidade da tela, senão a barra fica borrada", () => {
    expect(espectro).toContain("devicePixelRatio");
  });
});

describe("⭐ movimento reduzido acalma a onda — NÃO a congela", () => {
  it("continua reagindo à voz, só que devagar", () => {
    // `prefers-reduced-motion` tira movimento DECORATIVO. Esta onda é a única
    // confirmação visual de que o microfone está captando: congelá-la remove a
    // informação junto com a animação, e quem ligou a preferência fica sem
    // saber se pode falar. A primeira versão congelava.
    expect(espectroCodigo).toContain("prefers-reduced-motion");
    expect(espectroCodigo).toMatch(/SUBIDA_CALMA|DESCIDA_CALMA/);
    // A guarda NÃO pode desviar o laço inteiro.
    expect(espectroCodigo).not.toMatch(/if \(\s*(semMovimento|calmo)\s*\|\|/);
  });
});

describe("⚠️ a onda é enfeite, nunca caminho crítico", () => {
  it("navegador sem AudioContext cai no repouso, não lança", () => {
    expect(espectro).toMatch(/webkitAudioContext/);
    expect(espectroCodigo).toMatch(/if \(!Contexto/);
    expect(espectroCodigo).toMatch(/try \{[\s\S]*catch/);
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
    expect(escuta).toContain("onCancelar");
    expect(escuta).toContain("onParar");
    expect(escuta).toMatch(/Cancelar/);
    expect(escuta).toMatch(/Pronto/);
    expect(escuta).toMatch(/Escape/);
    expect(escuta).toMatch(/apagado depois de transcrito/i);
  });

  it("⭐ é escura em QUALQUER tema, e isso está declarado", () => {
    expect(escuta).toContain("#0e1f2a");
    expect(escuta).toMatch(/em qualquer tema|EM QUALQUER TEMA/i);
  });

  it("⚠️ o halo que pulsa NÃO carrega classe de translate", () => {
    // `bitz-escuta-aura` anima `transform: scale()`. Um `translate` de
    // posicionamento no MESMO elemento é sobrescrito no primeiro quadro e o
    // brilho salta para o canto.
    const i = escuta.indexOf("bitz-escuta-aura");
    const linha = escuta.slice(Math.max(0, i - 400), i + 120);
    expect(linha).not.toMatch(/-translate-[xy]-1\/2[^"]*bitz-escuta-aura/);
  });
});
