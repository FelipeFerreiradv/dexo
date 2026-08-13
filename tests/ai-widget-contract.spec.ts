import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ===========================================================================
// Contrato do widget do Bitz, verificado no TEXTO-FONTE.
//
// Por que source-parsing e não render: a suíte roda com `environment: "node"`
// (vitest.config.ts:128), sem jsdom. Montar o widget exigiria jsdom +
// next-auth + next/dynamic mockados — muita cerimônia para provar invariantes
// que são, na verdade, sobre o CÓDIGO, não sobre o comportamento em runtime.
//
// Precedente exato desta abordagem no repositório:
// tests/dashboard-routes-page-gate.spec.ts, que varre dashboard.routes.ts
// procurando drift de `preHandler`.
//
// O que este spec protege é a promessa central da REGRA ZERO: o Bitz não pode
// mudar nada para quem não o tem.
// ===========================================================================

const raiz = join(__dirname, "..");
const ler = (p: string) => readFileSync(join(raiz, p), "utf8");

/**
 * Fonte SEM comentários.
 *
 * Necessário para as asserções negativas: os comentários deste módulo citam de
 * propósito o que NÃO se deve fazer ("nada de cadeado", "toasts em z-[100]",
 * "SEM rehype-raw"), e um `not.toContain` ingênuo casaria justamente com a
 * documentação da regra em vez de com a violação dela.
 *
 * Remove, nesta ordem:
 *  1. blocos `{/* ... *\/}` e `/* ... *\/` INTEIROS, inclusive multi-linha;
 *  2. o que sobrar de linha que começa com `//`, `*`, `/*` ou `{/*`.
 *
 * ⚠️ O passo 1 é load-bearing e chegou tarde. Filtrar só por início de linha
 * deixa passar as linhas de CONTINUAÇÃO de um comentário JSX multi-linha — e
 * como os comentários deste módulo citam de propósito o que NÃO se deve fazer
 * (`<button>`, `<div onClick>`, `new Image()`), uma asserção negativa casava
 * com a documentação da regra em vez de com a violação dela, e uma asserção de
 * posição achava a tag dentro do comentário antes da tag de verdade. Foram dois
 * testes verdes/vermelhos pelo motivo errado até isto ser corrigido.
 *
 * O `https://` dentro de string continua intacto: só `/*` abre bloco.
 */
const lerCodigo = (p: string) =>
  ler(p)
    .replace(/\{?\/\*[\s\S]*?\*\/\}?/g, "")
    .split("\n")
    .filter((linha) => {
      const t = linha.trim();
      return !(
        t.startsWith("//") ||
        t.startsWith("*") ||
        t.startsWith("/*") ||
        t.startsWith("{/*")
      );
    })
    .join("\n");

describe("montagem em components/main-layout.tsx", () => {
  const layout = ler("components/main-layout.tsx");

  it("o Bitz é montado FORA do SidebarInset (que é o <main>)", () => {
    const fimDoInset = layout.indexOf("</SidebarInset>");
    const bitz = layout.indexOf("<BitzRoot");
    expect(fimDoInset).toBeGreaterThan(0);
    expect(bitz).toBeGreaterThan(fimDoInset);
  });

  it("o layout existente segue intacto: provider, sidebar, header e main", () => {
    expect(layout).toContain("<SidebarProvider>");
    expect(layout).toContain("<AppSidebar session={session} />");
    expect(layout).toContain("<AppHeader session={session} />");
    expect(layout).toContain(
      '<main className="flex-1 min-w-0 p-4 md:p-6">{children}</main>',
    );
  });

  it("nenhuma classe foi acrescentada ao <main> nem ao SidebarInset", () => {
    // Se alguém precisar dar padding ao main por causa do widget, é sinal de
    // que o widget deixou de ser `fixed` e passou a ocupar espaço no fluxo.
    expect(layout).not.toMatch(/<SidebarInset\s+className/);
    expect(layout).toMatch(/<main className="flex-1 min-w-0 p-4 md:p-6">/);
  });
});

describe("bitz-root — a fronteira que mantém o shell leve", () => {
  const root = ler("components/bitz/bitz-root.tsx");

  it("carrega o widget por dynamic(), não por import estático", () => {
    expect(root).toContain("dynamic(");
    expect(root).toContain('import("./bitz-widget")');
    expect(root).toContain("ssr: false");
  });

  it("não importa mascote, hooks nem painel (isso mora no chunk dinâmico)", () => {
    expect(root).not.toContain("bitz-mascot");
    expect(root).not.toContain("bitz-panel");
    expect(root).not.toContain("use-bitz-");
    expect(root).not.toContain("lucide-react");
  });

  it("checa a flag de build e a sessão ANTES de renderizar o widget", () => {
    expect(root).toContain("if (!AI_MODULE_ENABLED) return null;");
    expect(root).toContain("if (!session?.user) return null;");
  });
});

describe("gates do widget", () => {
  const widget = ler("components/bitz/bitz-widget.tsx");
  const hook = ler("hooks/use-bitz-entitlement.ts");

  it("sem o plano do tenant o launcher não é renderizado", () => {
    expect(widget).toContain("if (!enabled) return null;");
  });

  it("nada de cadeado nem upsell: quem não contratou não descobre que existe", () => {
    expect(lerCodigo("components/bitz/bitz-widget.tsx")).not.toMatch(
      /upgrade|contrate|assine|bloqueado|cadeado/i,
    );
  });

  it("a sonda de entitlement não dispara com a flag desligada", () => {
    const efeito = hook.slice(hook.indexOf("React.useEffect"));
    expect(efeito).toMatch(/if \(!AI_MODULE_ENABLED\) return;/);
  });

  it("a sonda começa em false, para não haver flash do mascote", () => {
    expect(hook).toContain("React.useState(false)");
  });

  it("a URL da API é concatenada (o api-auth-bridge casa por startsWith)", () => {
    expect(hook).toContain("`${getApiBaseUrl()}/ai/entitlement`");
    // Header manual quebraria a injeção do Bearer pelo bridge.
    expect(hook).not.toMatch(/headers:\s*\{[^}]*authorization/i);
  });
});

describe("z-index e posicionamento — o mapa levantado na Fase 0", () => {
  const widget = ler("components/bitz/bitz-widget.tsx");
  const panel = ler("components/bitz/bitz-panel.tsx");

  it("launcher em z-40: acima do conteúdo (máx z-30), abaixo de Radix e toasts", () => {
    expect(widget).toMatch(/fixed right-4 bottom-20 z-40/);
  });

  it("launcher livra a faixa dos toasts no mobile (bottom-4 em 17 telas)", () => {
    expect(widget).toContain("bottom-20");
  });

  // -------------------------------------------------------------------------
  // ⭐⭐ O LAUNCHER TEM DE FICAR FIXO — e o teste acima NÃO pegava a quebra.
  //
  // Em 13/08/2026 o badge de alerta entrou trazendo um `relative` na MESMA
  // lista de classes do `fixed`, para "sustentar" o ponto. `fixed` e `relative`
  // são a mesma propriedade CSS, e o Tailwind emite `relative` DEPOIS de
  // `fixed` na ordem canônica de posicionamento: `relative` venceu, o mascote
  // voltou para o fluxo do documento e passou a ROLAR COM A PÁGINA.
  //
  // ⚠️ E a asserção logo acima continuou VERDE o tempo todo, porque a string
  // `fixed right-4 bottom-20 z-40` seguia lá. Ela provava a PRESENÇA da classe
  // certa; o que faltava era provar a AUSÊNCIA de uma classe que a anula. É a
  // lição desta dupla: numa cascata, presença não é efeito.
  //
  // (O `relative` era desnecessário desde o começo: `position: absolute`
  // resolve contra o ancestral posicionado mais próximo, e `fixed` já é um.)
  // -------------------------------------------------------------------------
  const POSICIONAMENTO = /\b(relative|absolute|sticky|static)\b/;

  it("⭐⭐ o launcher não carrega uma segunda classe de posicionamento", () => {
    const codigo = lerCodigo("components/bitz/bitz-widget.tsx");
    const inicio = codigo.indexOf("fixed right-4 bottom-20 z-40");
    expect(inicio, "a classe do launcher sumiu").toBeGreaterThan(-1);

    // Da classe do launcher até o fim do `cn(...)` dele.
    const listaDoLauncher = codigo.slice(inicio, codigo.indexOf(")}", inicio));

    expect(
      listaDoLauncher,
      "`relative`/`absolute`/`sticky` na lista do launcher ANULAM o `fixed` e o mascote passa a rolar com a página",
    ).not.toMatch(POSICIONAMENTO);
  });

  it("⚠️ nenhum literal do módulo mistura duas classes de posicionamento", () => {
    // A mesma quebra, na forma geral: duas utilitárias de `position` dentro do
    // MESMO literal de string é sempre defeito — uma delas nunca vale.
    for (const arquivo of [
      "components/bitz/bitz-widget.tsx",
      "components/bitz/bitz-panel.tsx",
      "components/bitz/bitz-alerta.tsx",
      "components/bitz/bitz-acao.tsx",
    ]) {
      const codigo = lerCodigo(arquivo);
      for (const [literal] of codigo.matchAll(/"[^"\n]*\bfixed\b[^"\n]*"/g)) {
        expect(literal, `${arquivo}: duas classes de position no mesmo literal`)
          .not.toMatch(POSICIONAMENTO);
      }
    }
  });

  it("painel docado em z-40; tela cheia em z-50 (ali ele É o modal da vez)", () => {
    expect(panel).toContain("inset-0 z-50 rounded-none");
    expect(panel).toContain("z-40 rounded-3xl border");
  });

  it("nunca usa z-[100]: toast tem que aparecer por cima do Bitz", () => {
    // ⚠️ A entrada entrou nesta lista tarde: ela é a TERCEIRA camada sobreposta
    // do módulo e nasceu fora do guarda, que só conhecia launcher e painel.
    for (const arquivo of [
      "components/bitz/bitz-panel.tsx",
      "components/bitz/bitz-widget.tsx",
      "components/bitz/bitz-entrada.tsx",
      "components/bitz/bitz-apresentacao.tsx",
    ]) {
      expect(lerCodigo(arquivo), arquivo).not.toContain("z-[100]");
    }
  });

  it("o overlay da entrada fica em z-50, como o painel em tela cheia", () => {
    const entrada = lerCodigo("components/bitz/bitz-entrada.tsx");
    expect(entrada).toContain("fixed inset-0 z-50");
  });
});

describe("tela cheia disponível em QUALQUER tela", () => {
  const panel = ler("components/bitz/bitz-panel.tsx");
  const widget = ler("components/bitz/bitz-widget.tsx");

  it("há um botão explícito de expandir/reduzir no cabeçalho", () => {
    expect(panel).toContain("Expandir para tela cheia");
    expect(panel).toContain("Reduzir");
    expect(panel).toContain("onModeChange");
  });

  it("o modo full-screen ocupa a viewport inteira (inset-0), sem max-width", () => {
    expect(panel).toMatch(/isFull\s*\n?\s*\?\s*"inset-0 z-50 rounded-none"/);
  });

  it("mobile abre em tela cheia por padrão; desktop abre docado", () => {
    expect(widget).toContain('setMode(isMobile ? "fullscreen" : "docked")');
  });

  it("modal só no full-screen: docado não trava scroll nem clique fora", () => {
    expect(panel).toContain("modal={isFull}");
    expect(panel).toContain("if (!isFull) e.preventDefault();");
  });
});

describe("prefers-reduced-motion — o Bitz é o primeiro do repo a respeitar", () => {
  const arquivos = [
    "components/bitz/bitz-mascot.tsx",
    "components/bitz/bitz-widget.tsx",
    "components/bitz/bitz-message.tsx",
    "components/bitz/bitz-panel.tsx",
    "components/bitz/bitz-composer.tsx",
    "components/bitz/bitz-empty-state.tsx",
    "components/bitz/bitz-entrada.tsx",
    "components/bitz/bitz-apresentacao.tsx",
  ];

  it.each(arquivos)("%s gateia movimento com motion-reduce", (arquivo) => {
    const src = ler(arquivo);
    const temAnimacao = /animate-\[|animate-in|transition|hover:scale/.test(
      src,
    );
    if (!temAnimacao) return;
    expect(src).toMatch(
      /motion-reduce:(animate-none|transition-none|hover:scale-100)/,
    );
  });

  it("toda keyframe do Bitz é prefixada (não pode colidir com as do login)", () => {
    const css = ler("app/globals.css");
    const bitzKeyframes = css.match(/@keyframes bitz-[a-z]+/g) ?? [];
    expect(bitzKeyframes.length).toBeGreaterThanOrEqual(4);
    // As 4 keyframes originais do login continuam lá, intactas.
    for (const antiga of [
      "slow-float",
      "orbit-slow",
      "orbit-medium",
      "soft-pulse",
    ]) {
      expect(css).toContain(`@keyframes ${antiga}`);
    }
  });
});

describe("⭐ reabrir o chat mantém o usuário no FIM da conversa", () => {
  // O BUG: `DialogPrimitive.Content` do Radix é envolvido em
  // `Presence present={forceMount || open}`. Sem `forceMount`, FECHAR retira o
  // container de rolagem do DOM; ao reabrir, o nó é NOVO e nasce com
  // `scrollTop = 0`. O efeito de autoscroll não salvava: suas dependências
  // (`messages`, `pending`, `streaming`) têm identidade estável entre fechar e
  // abrir, então ele não roda. O usuário voltava para a primeira mensagem de
  // uma conversa longa.
  //
  // Confirmado empiricamente com @radix-ui/react-dialog 1.1.15 sob jsdom antes
  // da correção. Aqui a verificação é no texto-fonte porque a suíte roda em
  // `environment: "node"` (vitest.config.ts:128), sem DOM.
  const panel = lerCodigo("components/bitz/bitz-panel.tsx");

  it("o container de rolagem usa ref CALLBACK, não `useRef` puro", () => {
    // O callback roda no instante em que o nó entra no DOM — seja qual for o
    // motivo da remontagem, hoje o Radix e amanhã outra coisa.
    expect(panel).toContain("ref={fixarRolagem}");
    expect(panel).not.toContain("ref={scrollRef}");
  });

  it("o callback posiciona no fim ao montar", () => {
    const cb = panel.slice(
      panel.indexOf("const fixarRolagem"),
      panel.indexOf("}, []);", panel.indexOf("const fixarRolagem")),
    );
    expect(cb).toContain("scrollRef.current = el");
    expect(cb).toContain("el.scrollTop = el.scrollHeight");
  });

  it("⭐ o callback tem identidade ESTÁVEL — senão rola sozinho a cada render", () => {
    // Uma arrow inline (ou `useCallback` com dependências) faria o React
    // desanexar/reanexar o ref a cada render, e o container voltaria ao fim
    // enquanto o usuário tenta ler uma mensagem antiga lá em cima. É um bug
    // pior que o original, e é fácil de introduzir sem perceber.
    expect(panel).toMatch(
      /const fixarRolagem = React\.useCallback\([\s\S]*?\}, \[\]\);/,
    );
  });

  it("o autoscroll de mensagem nova continua existindo", () => {
    // O callback cobre a MONTAGEM; este efeito cobre mensagem nova e texto ao
    // vivo, que acontecem com o mesmo nó no DOM. Os dois são necessários.
    expect(panel).toMatch(
      /React\.useEffect\(\(\) => \{[\s\S]*?el\.scrollTop = el\.scrollHeight;[\s\S]*?\}, \[messages, pending, streaming\?\.content\]\);/,
    );
  });

  it("o painel NÃO usa forceMount — a correção não depende disso", () => {
    // `forceMount` manteria o container montado e também resolveria, mas ao
    // custo de deixar o chat inteiro (markdown, composer, imagens) no DOM com o
    // painel fechado, em toda página do ERP. O callback resolve sem esse preço.
    expect(panel).not.toContain("forceMount");
  });
});

describe("markdown do assistente", () => {
  const msg = ler("components/bitz/bitz-message.tsx");

  it("HTML cru fica DESABILITADO (saída de modelo é conteúdo não confiável)", () => {
    const codigo = lerCodigo("components/bitz/bitz-message.tsx");
    expect(codigo).not.toContain("rehype-raw");
    expect(codigo).not.toContain("dangerouslySetInnerHTML");
  });

  it("tabela rola dentro do próprio container, não empurra o painel", () => {
    expect(msg).toContain("overflow-x-auto");
  });
});

describe("composer — o lugar do áudio e do anexo já está reservado", () => {
  const composer = ler("components/bitz/bitz-composer.tsx");

  it("anexo e microfone aparecem, mas inativos (Fases 7 e 8)", () => {
    expect(composer).toContain("Anexar arquivo (em breve)");
    expect(composer).toContain("Falar com o Bitz (em breve)");
    expect(composer).toContain('aria-disabled="true"');
  });

  it("Enter envia e Shift+Enter quebra linha (mesma convenção de /mensagens)", () => {
    expect(composer).toContain('e.key === "Enter" && !e.shiftKey');
  });
});

describe("streaming no front — o texto ao vivo é PRÉVIA", () => {
  const hook = lerCodigo("hooks/use-bitz-chat.ts");
  const bolha = lerCodigo("components/bitz/bitz-message.tsx");

  it("pede NDJSON e decide pelo content-type da RESPOSTA", () => {
    // Quem decide se há streaming é o servidor. Sem essa checagem, um proxy
    // que devolvesse JSON faria o front esperar por quadros que nunca viriam.
    expect(hook).toContain("NDJSON_ACCEPT");
    expect(hook).toContain("content-type");
  });

  it("⭐ a mensagem do assistente nasce do quadro `fim`, nunca do texto ao vivo", () => {
    // O `streaming` é estado de UI e some no `finally`. Se algum dia ele virar
    // mensagem, a bolha poderá ficar diferente do que foi gravado no banco.
    expect(hook).toMatch(/case "fim":/);
    expect(hook).not.toMatch(/content:\s*streaming/);
  });

  it("conexão que cai no meio NÃO promove resposta parcial a resposta", () => {
    expect(hook).toContain("stream_interrompido");
  });

  it("⭐ a bolha em escrita e a definitiva são O MESMO desenho", () => {
    // Se divergirem, o texto PULA DE LUGAR no instante em que o quadro `fim`
    // chega e a bolha definitiva substitui a que estava sendo escrita. Por isso
    // as classes moram em constantes compartilhadas, e não repetidas à mão em
    // cinco lugares.
    const src = lerCodigo("components/bitz/bitz-message.tsx");
    expect(src).toContain("const BOLHA_BASE");
    expect(src).toContain("const BOLHA_DO_BITZ");
    // As duas usam as duas constantes, na mesma ordem.
    const usos = src.match(/cn\(\s*BOLHA_BASE,\s*\n?\s*BOLHA_DO_BITZ/g) ?? [];
    expect(usos.length, "bolhas usando BASE+BITZ").toBeGreaterThanOrEqual(2);
  });

  it("a bolha em escrita não desenha o bloco de Fontes", () => {
    // As fontes chegam no `fim`. Um card vazio durante a escrita pareceria
    // parte do texto que o modelo está redigindo.
    const streaming = bolha.slice(
      bolha.indexOf("export function BitzStreaming"),
      bolha.indexOf("RÓTULO_DA_CONSULTA"),
    );
    expect(streaming).not.toContain("BitzSources");
  });

  it("o indicador de consulta fala a língua do lojista, não o nome da tool", () => {
    expect(bolha).toContain("RÓTULO_DA_CONSULTA");
    expect(bolha).not.toMatch(/\{consultando\[0\]\}/);
  });
});

/**
 * Lê o cabeçalho de um WebP animado direto dos BYTES.
 *
 * O formato é RIFF: blocos `FourCC` + tamanho LE32. `ANIM` carrega o contador
 * de loop (0 = infinito) nos bytes 12-13; cada `ANMF` é um quadro e traz a
 * duração em 24 bits LE no offset 12 do próprio bloco.
 *
 * Existe porque as duas armadilhas que custaram rodadas nesta feature estavam
 * DENTRO do arquivo, não no código: um recorte que só pegava o robô parado, e
 * um contador de loop finito que fazia a imagem nascer congelada.
 */
function lerWebpAnimado(caminho: string) {
  const b = readFileSync(join(raiz, caminho));
  let off = 12;
  let loop: number | null = null;
  let quadros = 0;
  let duracaoMs = 0;
  let largura = 0;
  let altura = 0;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4);
    const sz = b.readUInt32LE(off + 4);
    if (id === "ANIM") loop = b.readUInt16LE(off + 12);
    if (id === "VP8X") {
      largura = 1 + (b[off + 12] | (b[off + 13] << 8) | (b[off + 14] << 16));
      altura = 1 + (b[off + 15] | (b[off + 16] << 8) | (b[off + 17] << 16));
    }
    if (id === "ANMF") {
      quadros++;
      const p = off + 8;
      duracaoMs += b[p + 12] | (b[p + 13] << 8) | (b[p + 14] << 16);
    }
    off += 8 + sz + (sz % 2);
  }
  return { loop, quadros, duracaoMs, largura, altura, kb: b.length / 1024 };
}

describe("os dois arquivos de animação", () => {
  it("⭐ são imagem, não vídeo — o material tem fundo branco e o Dexo tem tema escuro", () => {
    // MP4/H.264 não tem canal alpha: no tema escuro o fundo branco vira uma
    // placa luminosa atrás do robô. WebP animado tem alpha e é `<img>`.
    const animado = lerCodigo("components/bitz/bitz-mascot-animado.tsx");
    const entrada = lerCodigo("components/bitz/bitz-entrada.tsx");
    expect(animado).toContain("MASCOT.loop");
    expect(entrada).toContain("MASCOT.entrada");
    for (const src of [animado, entrada]) {
      expect(src).not.toMatch(/<video|playsInline|autoPlay/);
    }
    // O original tinha 4,9 MB, 4K e 10 s — peso permanente no repositório.
    expect(existsSync(join(raiz, "public/bitz/bitz-mascote-animacao.mp4"))).toBe(
      false,
    );
  });

  it("⭐ o LOOP tem loop_count 0 — em loop finito ele congela no painel", () => {
    const a = lerWebpAnimado("public/bitz/bitz-mascote-loop.webp");
    // 0 = infinito. Qualquer outro valor faz a imagem parar no último quadro
    // depois da última volta — e como o navegador compartilha UMA linha do
    // tempo por URL, ela nasce parada para quem chegar depois. Este arquivo
    // vive na apresentação, dentro de um painel que nunca desmonta: com loop
    // finito ele se mexeria uma vez e ficaria parado para sempre.
    expect(a.loop, "loop_count do arquivo de loop").toBe(0);
    // E precisa ter quadros de verdade: um webp "animado" de 1 quadro passaria
    // em todo o resto e não animaria nada.
    expect(a.quadros).toBeGreaterThan(10);
    expect(a.kb, `${Math.round(a.kb)} KB`).toBeLessThan(400);
  });

  it("⭐ a ENTRADA vai até o robô ir embora e PARA ANTES da volta ao começo", () => {
    const a = lerWebpAnimado("public/bitz/bitz-mascote-entrada.webp");
    // Loop 1: esta animação tem um fim narrativo (o robô sai do canto, se
    // apresenta e vai embora) e o componente que a exibe morre junto com ela.
    expect(a.loop, "loop_count da entrada").toBe(1);
    // O material original tem 10 s. Um recorte curto demais aqui significaria
    // que alguém reexportou só um pedaço — e o pedido foi a animação INTEIRA.
    expect(a.duracaoMs / 1000, "duração em segundos").toBeGreaterThanOrEqual(
      9.5,
    );
    // ⭐ E O TETO EXISTE PELO MOTIVO OPOSTO. O vídeo original foi autorado para
    // rodar em loop: os últimos 0,4 s EMENDAM a volta ao começo. Conferido
    // quadro a quadro no material: até 9,53 s só existe o robô indo embora; em
    // 9,60 s ele ainda está lá E a cabeça do quadro 0 já entra pela direita; de
    // 9,67 s em diante só existe o robô do começo. Tocando uma vez só, essa
    // emenda vira um solavanco — o robô some e reaparece do início. Reexportar
    // "o vídeo inteiro" traz o defeito de volta sem nada acusar, e é essa
    // regressão que este teto impede.
    expect(a.duracaoMs / 1000, "duração em segundos").toBeLessThanOrEqual(9.7);
    expect(a.quadros).toBeGreaterThan(100);
  });

  it("⭐ a constante de duração da entrada acompanha os BYTES do arquivo", () => {
    // Sem isto, reexportar o asset com outro corte deixa sobra de tela parada
    // no fim (constante alta demais) ou corta a animação no meio (baixa
    // demais), e nada acusa.
    const a = lerWebpAnimado("public/bitz/bitz-mascote-entrada.webp");
    const src = lerCodigo("components/bitz/bitz-entrada.tsx");
    const declarada = Number(
      src.match(/DURACAO_MS = ([\d_]+)/)?.[1].replace(/_/g, "") ?? "0",
    );
    expect(Math.abs(declarada - a.duracaoMs), "deriva em ms").toBeLessThan(700);
  });

  it("o megabyte da entrada é o preço de tocar UMA VEZ NA VIDA", () => {
    const a = lerWebpAnimado("public/bitz/bitz-mascote-entrada.webp");
    // 1 MB seria indefensável num enfeite recorrente. O que o torna aceitável é
    // o marco em `bitz-onboarding.ts`: quem já viu nunca mais pede o arquivo.
    expect(a.kb, `${Math.round(a.kb)} KB`).toBeLessThan(1600);
    const widget = lerCodigo("components/bitz/bitz-widget.tsx");
    expect(widget).toContain('jaPassou(usuarioId, "entrada")');
  });

  it("⭐ o marco só queima quando a animação APARECE, não no clique", () => {
    // A versão anterior queimava dentro de `abrir()`. Estava errado na direção
    // mais cara: qualquer falha — arquivo que não chega, teto de carregamento,
    // rede caída — virava perda DEFINITIVA de uma animação que só toca uma vez
    // na vida, sem o usuário nunca tê-la visto. Agora quem queima é o
    // `onComecou`, disparado no `onLoad` do primeiro quadro exibido.
    const widget = lerCodigo("components/bitz/bitz-widget.tsx");
    const abrir = widget.slice(
      widget.indexOf("const abrir"),
      widget.indexOf("if (!enabled)"),
    );
    expect(abrir).not.toContain("marcarPassou");
    expect(widget).toContain('onComecou={() => marcarPassou(usuarioId, "entrada")}');

    const entrada = lerCodigo("components/bitz/bitz-entrada.tsx");
    const aoCarregar = entrada.slice(
      entrada.indexOf("onLoad={"),
      entrada.indexOf("onError="),
    );
    expect(aoCarregar).toContain("onComecou?.()");
  });

  it("nenhuma das duas é exibida acima do tamanho nativo (borraria)", () => {
    const loop = lerWebpAnimado("public/bitz/bitz-mascote-loop.webp");
    const entrada = lerWebpAnimado("public/bitz/bitz-mascote-entrada.webp");

    const alturaApresentacao = Number(
      lerCodigo("components/bitz/bitz-apresentacao.tsx").match(
        /BitzMascotAnimado height=\{(\d+)\}/,
      )?.[1] ?? "9999",
    );
    expect(alturaApresentacao).toBeLessThanOrEqual(loop.altura);

    const alturaEntrada = Number(
      lerCodigo("components/bitz/bitz-entrada.tsx").match(
        /h-\[min\((\d+)px/,
      )?.[1] ?? "9999",
    );
    expect(alturaEntrada).toBeLessThanOrEqual(entrada.altura);
  });

  it("⭐ a PROPORÇÃO codificada acompanha os bytes do arquivo", () => {
    // `BitzMascotAnimado` calcula a largura a partir da altura pedida. Se o
    // asset for reexportado com outro enquadramento e este número ficar para
    // trás, o robô estica ou achata — e nada mais acusa.
    const loop = lerWebpAnimado("public/bitz/bitz-mascote-loop.webp");
    const src = lerCodigo("components/bitz/bitz-mascot-animado.tsx");
    const m = src.match(/PROPORCAO = (\d+) \/ (\d+)/);
    expect(Number(m?.[1]), "largura declarada").toBe(loop.largura);
    expect(Number(m?.[2]), "altura declarada").toBe(loop.altura);
  });

  it("cai no mascote estático quando o arquivo falha", () => {
    const animado = lerCodigo("components/bitz/bitz-mascot-animado.tsx");
    expect(animado).toContain("onError");
    expect(animado).toContain("BitzMascot");
  });

  it("⭐ o MASCOTE não é gateado por prefers-reduced-motion; a INTERFACE é", () => {
    // ⚠️ AQUI HAVIA DOIS TESTES EXIGINDO O CONTRÁRIO. Eles foram trocados por
    // este, e não afrouxados: a regra do produto mudou, com motivo.
    //
    // No Windows, "Efeitos de animação" é o mesmo interruptor que muita gente
    // desliga por DESEMPENHO, e o navegador reporta `reduce` igual. O efeito
    // prático era apagar as duas animações de marca para uma fatia enorme de
    // usuários que nunca pediram isso — inclusive na máquina do dono do
    // produto, onde custou quatro rodadas para ser isolado.
    //
    // O que continua valendo, e este teste protege: TODO movimento de interface
    // (transição, hover, escala, keyframe) segue respeitando a preferência.
    const mascote = lerCodigo("components/bitz/bitz-mascot-animado.tsx");
    const widget = lerCodigo("components/bitz/bitz-widget.tsx");
    expect(mascote).not.toContain("prefers-reduced-motion");
    expect(widget).not.toContain("prefers-reduced-motion");

    // E a entrada não vira armadilha para quem não quer vê-la: sai em um gesto.
    const entrada = lerCodigo("components/bitz/bitz-entrada.tsx");
    expect(entrada).toContain('e.key === "Escape"');
    expect(entrada).toContain("onClick={encerrar}");
  });

  it("⭐ a entrada NÃO desliza na horizontal — cortaria o robô na borda", () => {
    // A primeira versão começava em `translate(46px, ...)`, o que jogava metade
    // do robô PARA FORA da viewport nos primeiros quadros: ele aparecia cortado
    // pela borda direita em vez de apoiado nela. Quem entrega a caminhada é o
    // próprio WebP; o keyframe só assenta o quadro no lugar.
    const css = ler("app/globals.css");
    const kf = css.slice(
      css.indexOf("@keyframes bitz-entrada"),
      css.indexOf("}", css.indexOf("100% {", css.indexOf("@keyframes bitz-entrada"))),
    );
    expect(kf).toContain("translateY(");
    expect(kf).not.toMatch(/translate\(\s*-?\d/);
    expect(kf).not.toContain("translateX(");
  });

  it("⭐ o deslize de entrada só é aplicado depois que o arquivo chegou", () => {
    // Aplicado na montagem, os 720 ms correm enquanto o <img> ainda não tem
    // pixel algum: numa rede lenta a animação inteira termina antes de o robô
    // existir, e ele aparece de estalo já na posição final — matando justamente
    // a leitura de "saiu do canto da tela" que o usuário pediu.
    const entrada = lerCodigo("components/bitz/bitz-entrada.tsx");
    expect(entrada).toMatch(/carregou &&\s*"animate-\[bitz-entrada_/);
  });

  it("o <img> da entrada declara a proporção intrínseca do arquivo", () => {
    // Sem `width`/`height`, `w-auto` mede 0 px até os bytes chegarem e a aura
    // colapsa junto. Os números têm que bater com o VP8X do arquivo.
    const a = lerWebpAnimado("public/bitz/bitz-mascote-entrada.webp");
    const entrada = lerCodigo("components/bitz/bitz-entrada.tsx");
    expect(entrada).toContain(`width={${a.largura}}`);
    expect(entrada).toContain(`height={${a.altura}}`);
  });

  it("⭐ os bytes só saem do servidor depois que o usuário mexe", () => {
    // O peso aqui NÃO é JavaScript — são arquivos em /public. O que os mantém
    // fora do caminho de quem só quer usar o ERP é o <img> não existir até o
    // clique: o loop mora no chunk do painel e a entrada tem chunk próprio.
    //
    // ⚠️ O `import("./bitz-entrada")` tem que estar DENTRO de `abrir`, e não no
    // topo do módulo: import estático arrastaria o componente da entrada para o
    // chunk do widget, que é baixado por todo mundo que tem o Bitz — inclusive
    // quem já viu a animação e nunca mais vai vê-la.
    const widget = lerCodigo("components/bitz/bitz-widget.tsx");
    expect(widget).not.toMatch(/^import .*bitz-entrada/m);
    const corpoDoAbrir = widget.slice(
      widget.indexOf("const abrir"),
      widget.indexOf("if (!enabled)"),
    );
    expect(corpoDoAbrir).toMatch(/import\("\.\/bitz-entrada"\)/);
    expect(widget).toMatch(/\{entrando && Entrada && \(/);
    expect(widget).toContain("<Entrada");

    // E o ponto de entrada do shell não conhece nem o widget nem as animações —
    // é o `dynamic()` do bitz-root que mantém tudo isso fora de todas as
    // páginas quando o módulo está desligado.
    const root = lerCodigo("components/bitz/bitz-root.tsx");
    expect(root).not.toContain("bitz-mascot-animado");
    expect(root).not.toContain("bitz-entrada");
  });
});

describe("⭐ marco 1: a entrada toca no primeiro clique de todos, e só nele", () => {
  const widget = lerCodigo("components/bitz/bitz-widget.tsx");
  const abrir = widget.slice(
    widget.indexOf("const abrir"),
    widget.indexOf("if (!enabled)"),
  );

  // ⚠️ AQUI HAVIA UM TESTE EXIGINDO O CONTRÁRIO — "o marco é gravado ANTES de
  // tocar" —, escrito para que fechar a aba no meio dos 10 s não cobrasse o
  // usuário de novo. Ele foi REMOVIDO de propósito, não afrouxado: o
  // comportamento que ele pinava estava errado na direção mais cara. Queimar no
  // clique transformava qualquer falha (arquivo que não chega, teto de
  // carregamento, rede caída) em perda DEFINITIVA de uma animação que só toca
  // uma vez na vida — e o usuário nunca a via. Fechar a aba no meio custa, no
  // máximo, ver a animação uma segunda vez. O invariante que substitui está em
  // "o marco só queima quando a animação APARECE", acima.

  it("a chave é POR USUÁRIO — dono e balconista dividem a mesma máquina", () => {
    const onboarding = lerCodigo("components/bitz/bitz-onboarding.ts");
    expect(onboarding).toMatch(/\$\{PREFIXO\}\$\{marco\}:\$\{usuarioId\}/);
    expect(widget).toContain("session.user.id");
  });

  it("⭐ a leitura FALHA FECHADA: sem storage, não anima", () => {
    // localStorage lança em modo privado do Safari e com storage particionado.
    // Falhar aberto faria a entrada de 1 MB tocar em TODA abertura, para
    // sempre, justamente para quem está num navegador restrito.
    const onboarding = lerCodigo("components/bitz/bitz-onboarding.ts");
    const leitura = onboarding.slice(
      onboarding.indexOf("export function jaPassou"),
      onboarding.indexOf("export function marcarPassou"),
    );
    expect(leitura).toMatch(/catch\s*\{\s*return true;/);
  });

  it("⭐ o chunk do painel carrega DURANTE a animação, não depois", () => {
    // `setMounted(true)` antes de `setEntrando(true)` é o que transforma os
    // 10 s em tempo útil: quando o painel aparece, ele já está pronto.
    expect(abrir.indexOf("setMounted(true)")).toBeGreaterThan(-1);
    expect(abrir.indexOf("setMounted(true)")).toBeLessThan(
      abrir.indexOf("setEntrando(true)"),
    );
  });

  it("⭐ quem já viu não espera nada", () => {
    // O desvio rápido tem que vir ANTES de qualquer trabalho: sem isto, quem
    // abre o chat pela décima vez no dia pagaria o caminho da animação.
    expect(abrir).toContain('jaPassou(usuarioId, "entrada")');
    expect(abrir.indexOf("jaPassou")).toBeLessThan(
      abrir.indexOf("setEntrando(true)"),
    );
    expect(abrir).toContain("abrirDeFato();");
  });

  it("clique repetido durante a entrada não reinicia nada", () => {
    expect(widget).toMatch(/if \(entrando\) return/);
  });

  it("⭐ o launcher NÃO pré-carrega arquivo de animação no hover", () => {
    // O navegador mantém UMA linha do tempo por RECURSO, compartilhada entre
    // todos os <img> da mesma URL. Tocar o arquivo no hover fazia o <img> de
    // verdade nascer numa animação já adiantada — e com loop finito, já
    // ACABADA: um robô parado. Foi exatamente este bug, e custou várias rodadas
    // porque o arquivo, o servidor e o CSS estavam todos corretos.
    expect(widget).toMatch(/onPointerEnter/);
    expect(widget).not.toMatch(/new Image\(\)\.src/);
    expect(widget).not.toMatch(/fetch\(MASCOT\./);
  });

  it("⭐ o enfeite NÃO PODE trancar o Bitz — teto absoluto no widget", () => {
    // O cenário que este teste existe para impedir: o chunk da entrada não
    // chega. `entrando` fica true para sempre, o launcher some, `abrir()` volta
    // no `if (entrando) return` e o marco já foi queimado — o Bitz vira
    // INALCANÇÁVEL para aquele usuário até ele recarregar a página.
    expect(widget).toContain("TETO_DA_ENTRADA_MS");
    const teto = Number(
      widget.match(/TETO_DA_ENTRADA_MS = ([\d_]+)/)?.[1].replace(/_/g, "") ??
        "0",
    );
    const dur = Number(
      lerCodigo("components/bitz/bitz-entrada.tsx")
        .match(/DURACAO_MS = ([\d_]+)/)?.[1]
        .replace(/_/g, "") ?? "0",
    );
    // Frouxo o bastante para não cortar a animação no caso normal, apertado o
    // bastante para não ser uma eternidade no caso anormal.
    expect(teto).toBeGreaterThan(dur);
    expect(teto).toBeLessThanOrEqual(dur + 8_000);
    expect(abrir).toMatch(/setTimeout\(abrirDeFato, TETO_DA_ENTRADA_MS\)/);
  });

  it("⭐ chunk que falha abre o chat, não derruba a página", () => {
    // O repositório não tem error boundary nenhum: um chunk que falha dentro de
    // `dynamic()` lança DURANTE O RENDER e leva a árvore do React junto — a
    // página inteira do lojista, por causa de um enfeite. Com `import()`
    // manual, a falha cai no `.catch`.
    expect(widget).toMatch(/import\("\.\/bitz-entrada"\)/);
    expect(widget).toMatch(/\.catch\(abrirDeFato\)/);
    expect(widget).not.toMatch(/dynamic\(\s*\(\) => import\("\.\/bitz-entrada"\)/);
  });

  it("o timer é cancelado se o componente sair", () => {
    // Cobertura que existia antes da entrada e não pode se perder: timer
    // pendente com o componente desmontado vira setState em árvore morta.
    expect(widget).toContain("clearTimeout");
  });

  it("⭐ o launcher só some quando o overlay já tem o que pintar", () => {
    // Sair no clique deixava a tela sem launcher, sem véu e sem painel durante
    // todo o round-trip do chunk.
    expect(widget).toMatch(/\{!open && !\(entrando && Entrada\) && \(/);
    expect(widget).toContain("disabled={entrando}");
  });

  it("⭐ há sempre uma saída: fim, clique, Esc e teto de carregamento", () => {
    const entrada = lerCodigo("components/bitz/bitz-entrada.tsx");
    expect(entrada).toContain("TETO_DE_CARREGAMENTO_MS");
    expect(entrada).toContain('e.key === "Escape"');
    expect(entrada).toContain("onClick={encerrar}");
    // Arquivo que não chega não pode segurar a abertura do chat.
    expect(entrada).toContain("onError={encerrar}");
    // E o encerramento é idempotente: quatro caminhos, uma abertura só.
    expect(entrada).toMatch(/if \(encerrado\.current\) return;/);
  });

  it("⭐ clicar no PRÓPRIO ROBÔ pula — ele não pode comer o clique", () => {
    // O robô é pintado depois do botão de pular e fica por cima dele. Sem
    // `pointer-events-none`, o alvo mais óbvio da tela seria o único ponto que
    // não faz nada.
    const entrada = lerCodigo("components/bitz/bitz-entrada.tsx");
    expect(entrada).toContain("pointer-events-none absolute right-0 bottom-0");
  });

  it("⭐ o <button> de pular só contém conteúdo de frase", () => {
    // `<button>` não aceita conteúdo de fluxo: um `<div>` lá dentro deixa o HTML
    // inválido e o navegador fica livre para reorganizar a árvore — layout que
    // funciona no Chrome e escorrega no Firefox. Por isso o robô é IRMÃO do
    // botão, não filho dele.
    const entrada = lerCodigo("components/bitz/bitz-entrada.tsx");
    const abre = entrada.indexOf("<button");
    const fecha = entrada.indexOf("</button>");
    expect(abre).toBeGreaterThan(-1);
    expect(fecha).toBeGreaterThan(abre);
    const dentro = entrada.slice(abre, fecha);
    expect(dentro).not.toMatch(/<(div|p|h[1-6]|section|ul|ol|li)\b/);
    expect(dentro).not.toContain("<img");
  });

  it("⭐ o foco vai para o overlay — teclado não fica preso atrás dele", () => {
    // O launcher, que estava focado quando o usuário apertou Enter, é desmontado
    // no mesmo instante. Sem trazer o foco, ele cai no `document.body` e por
    // 10 s quem navega por teclado tabula a página ATRÁS do overlay, sem nenhum
    // controle alcançável. E o anel de foco tem que aparecer em algum lugar
    // visível: `focus-visible:outline-none` no botão de tela inteira só é
    // aceitável porque a pílula desenha o anel via `group-focus-visible`.
    const entrada = lerCodigo("components/bitz/bitz-entrada.tsx");
    expect(entrada).toContain("botao.current?.focus()");
    expect(entrada).toContain("ref={botao}");
    expect(entrada).toContain("group-focus-visible:ring-2");
  });

  it("⭐ o relógio da animação só começa quando ela começa", () => {
    // Disparar o timer na montagem cortaria a animação pelo tempo de download.
    const entrada = lerCodigo("components/bitz/bitz-entrada.tsx");
    expect(entrada).toContain("setCarregou(true)");
    expect(entrada).toMatch(/onLoad=\{/);
    expect(entrada).toMatch(
      /if \(!carregou\) return;\s*\n\s*const t = window\.setTimeout\(encerrar, DURACAO_MS\)/,
    );
  });

  it("⭐ os BYTES vêm por fetch; o <img> nasce apontando para um blob local", () => {
    // O navegador decodifica imagem animada de forma INCREMENTAL: o quadro 0
    // deste arquivo termina em 0,32% dos bytes e reproduzir os 10 s exige só
    // 0,87 Mbps. Um <img> apontado direto para a URL COMEÇA a animar quase
    // imediatamente, mas `onLoad` só dispara no último byte — medido: 3,4 s de
    // robô CONGELADO a 2,5 Mbps, 1,7 s a 5 Mbps, 0,9 s a 10 Mbps.
    //
    // Ancorar o relógio em `naturalWidth > 0` não resolve: as dimensões ficam
    // conhecidas na leitura do cabeçalho em QUALQUER navegador, inclusive nos
    // que não animam progressivamente — e nesses o relógio começaria antes da
    // animação e a CORTARIA, que é pior. Não há como perguntar ao DOM quando a
    // animação de fato começou.
    //
    // Com blob local, decodificação e exibição são imediatas e `onLoad`
    // coincide com o primeiro quadro em todo navegador.
    const entrada = lerCodigo("components/bitz/bitz-entrada.tsx");
    expect(entrada).toContain("fetch(MASCOT.entrada");
    expect(entrada).toContain("URL.createObjectURL(blob)");
    // O <img> NUNCA aponta para a URL pública — se apontasse, a linha do tempo
    // voltaria a começar antes do relógio.
    expect(entrada).toContain("src={fonte}");
    expect(entrada).not.toContain("src={MASCOT.entrada}");
    // `fetch` não inicia linha do tempo de animação; `new Image()` inicia.
    expect(entrada).not.toMatch(/new Image\(\)/);
  });

  it("⭐ o megabyte é liberado — nada de blob preso até a aba fechar", () => {
    const entrada = lerCodigo("components/bitz/bitz-entrada.tsx");
    expect(entrada).toContain("URL.revokeObjectURL(url)");
    // E o fetch é abortado na desmontagem, sem chamar `encerrar` por isso.
    expect(entrada).toContain("controle.abort()");
    expect(entrada).toMatch(/if \(vivo\) encerrar\(\);/);
  });

  it("o canto não fica vazio enquanto os bytes não chegam", () => {
    const entrada = lerCodigo("components/bitz/bitz-entrada.tsx");
    expect(entrada).toMatch(/fonte === null \? \(/);
    expect(entrada).toContain("<BitzMascot size={56}");
  });
});

describe("⭐ marco 2: a apresentação vai até a primeira mensagem, e nunca volta", () => {
  const panel = lerCodigo("components/bitz/bitz-panel.tsx");

  it("a primeira conversa de todas mostra a apresentação, não as sugestões", () => {
    expect(panel).toMatch(/!jaPassou\(usuarioId, "apresentacao"\)/);
    expect(panel).toMatch(/apresentar \? \(\s*<BitzApresentacao/);
  });

  it("⭐ a primeira mensagem encerra o marco — inclusive vinda do composer", () => {
    // O botão da tela não é o único caminho: o usuário pode simplesmente
    // digitar. Se só o botão gravasse, quem digitasse veria a apresentação de
    // novo na próxima "nova conversa".
    const perguntar = panel.slice(
      panel.indexOf("const perguntar"),
      panel.indexOf("return ("),
    );
    expect(perguntar).toContain("if (apresentar) encerrarApresentacao();");
  });

  it('⭐ "nova conversa" cai na tela de boas-vindas de sempre', () => {
    // `reset()` esvazia as mensagens e `vazio` volta a ser true — mas
    // `apresentar` já é false, então o que aparece são as sugestões. Apresentar
    // duas vezes seria apresentar a quem já conhece.
    //
    // ⚠️ A versão anterior deste teste só conferia que as strings existiam no
    // arquivo, e teria passado com o comportamento quebrado. O que prova a
    // regra é o handler do botão NÃO tocar em `apresentar`.
    expect(panel).toContain("<BitzEmptyState");
    const novaConversa = panel.slice(
      panel.indexOf('label="Nova conversa"'),
      panel.indexOf("</IconBtn>", panel.indexOf('label="Nova conversa"')),
    );
    expect(novaConversa).toContain("reset();");
    expect(novaConversa).not.toContain("presentar");
    // E o marco é gravado, não só o estado local: sobrevive ao F5.
    expect(panel).toMatch(/marcarPassou\(usuarioId, "apresentacao"\)/);
  });

  it("⭐ a ÚNICA saída da apresentação é a primeira mensagem", () => {
    // O pedido foi literal: a tela vale "até a pessoa enviar sua primeira
    // mensagem". Um botão de ação seria um segundo caminho para o mesmo lugar,
    // ao lado do campo de texto que já está logo abaixo.
    // O único <button> permitido aqui é o × de fechar (ver abaixo) — nada de
    // "Get started" ao lado de um campo de texto que faz a mesma coisa.
    const apres = lerCodigo("components/bitz/bitz-apresentacao.tsx");
    expect(apres.match(/<button/g)?.length ?? 0).toBe(1);
    expect(apres).toContain("onFechar");
    // E quem grava o marco é o caminho da mensagem, dentro de `perguntar`.
    const encerrar = panel.slice(panel.indexOf("const encerrarApresentacao"));
    expect(encerrar).toContain('marcarPassou(usuarioId, "apresentacao")');
  });

  it("⭐ o desenho segue a referência: título, balão, robô, e o composer logo abaixo", () => {
    const apres = lerCodigo("components/bitz/bitz-apresentacao.tsx");
    // A ORDEM é o pedido, e é o que uma reordenação acidental quebraria.
    const iTitulo = apres.indexOf("conheça o ");
    const iBalao = apres.indexOf("Precisa de ajuda");
    const iRobo = apres.indexOf("<BitzMascotAnimado");
    expect(iTitulo).toBeGreaterThan(-1);
    expect(iBalao).toBeGreaterThan(iTitulo);
    expect(iRobo).toBeGreaterThan(iBalao);

    // E o bloco ocupa a altura toda, senão sobra um vão entre o robô e o
    // composer — exatamente o oposto do desenho pedido.
    //
    // ⚠️ AS DUAS PARTES SÃO NECESSÁRIAS. O `min-h-full` do painel resolve
    // porque aquele div é filho DIRETO do container de rolagem, que tem altura
    // definida. Mas a altura dele fica `auto`, então um `min-h-full` sozinho na
    // tela filha resolveria contra um pai indefinido e viraria ZERO — tudo
    // colado no topo. É o `flex flex-col` do pai + `flex-1` na filha que
    // entregam a altura.
    expect(panel).toMatch(/apresentando && "flex min-h-full flex-col"/);
    expect(apres).toContain("flex-1");
  });

  it("⭐ o wordmark da casa, com 'bitz' em amarelo", () => {
    // Mesma tipografia do herói das páginas (components/page-header.tsx):
    // Outfit, font-black, minúsculas, tracking fechado. `style` porque a regra
    // base de `h2` já aponta para --font-display e precisa ser vencida.
    const apres = lerCodigo("components/bitz/bitz-apresentacao.tsx");
    expect(apres).toContain('fontFamily: "var(--font-outfit)"');
    expect(apres).toContain("font-black");
    expect(apres).toContain("tracking-[-0.04em]");
    expect(apres).toMatch(/<span className="text-primary">bitz<\/span>/);
  });

  it("⭐ a apresentação não tem cabeçalho — mas o <Title> do Radix sobrevive", () => {
    // Sem o Title o diálogo perde o nome acessível e o Radix reclama em dev.
    // Ele continua montado, só que fora da tela.
    expect(panel).toMatch(/apresentando \? \(/);
    expect(panel).toMatch(
      /<DialogPrimitive\.Title className="sr-only">/,
    );
    // E a barra volta assim que a conversa começa.
    expect(panel).toContain("<header");
    expect(panel).toContain("Expandir para tela cheia");
  });

  it("⭐ sem cabeçalho, ainda existe UMA saída da primeira tela", () => {
    // No modo docado o painel não fecha por clique fora nem por Esc. Sem o ×
    // flutuante, a primeira tela do produto seria uma armadilha.
    const apres = lerCodigo("components/bitz/bitz-apresentacao.tsx");
    expect(apres).toContain('aria-label="Fechar o Bitz"');
    expect(panel).toContain("onFechar={() => onOpenChange(false)}");
  });

  it("⭐ o BitzPanel nunca é desmontado — o marco sobrevive a fechar e reabrir", () => {
    // `apresentar` é estado LOCAL do painel. Se o widget desmontasse o painel ao
    // fechar, o estado morreria junto e a apresentação voltaria para quem já a
    // dispensou. Quem o Radix desmonta ao fechar é só o `Content` lá dentro.
    const widget = lerCodigo("components/bitz/bitz-widget.tsx");
    expect(widget).toMatch(/setMounted\(true\)/);
    expect(widget).not.toMatch(/setMounted\(false\)/);
    expect(widget).toMatch(/\{mounted && \(\s*<BitzPanel/);
  });

  it("⭐ é lido no inicializador, sem piscar a tela errada por um quadro", () => {
    // O painel é carregado com `ssr: false`, então não há render de servidor com
    // que divergir — e um `useEffect` faria a tela de boas-vindas aparecer por
    // um quadro antes de ser substituída pela apresentação.
    expect(panel).toMatch(/React\.useState\(\s*\(\) =>\s*typeof window/);
  });

  it("a apresentação usa o LOOP, e o loop não precisa de key", () => {
    // O painel monta uma vez e nunca desmonta. O que garante movimento eterno
    // aqui é o `loop_count 0` do arquivo, provado acima — não uma chave.
    const apres = lerCodigo("components/bitz/bitz-apresentacao.tsx");
    expect(apres).toContain("<BitzMascotAnimado");
    expect(apres).not.toContain("key={");
  });
});
