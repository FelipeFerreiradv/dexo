import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
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
 * Remove linhas cujo início já é comentário — cobre `//` de linha inteira e o
 * corpo `*` dos blocos JSDoc, sem destruir um `https://` dentro de string.
 */
const lerCodigo = (p: string) =>
  ler(p)
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

  it("painel docado em z-40; tela cheia em z-50 (ali ele É o modal da vez)", () => {
    expect(panel).toContain("inset-0 z-50 rounded-none");
    expect(panel).toContain("z-40 rounded-3xl border");
  });

  it("nunca usa z-[100]: toast tem que aparecer por cima do Bitz", () => {
    expect(lerCodigo("components/bitz/bitz-panel.tsx")).not.toContain(
      "z-[100]",
    );
    expect(lerCodigo("components/bitz/bitz-widget.tsx")).not.toContain(
      "z-[100]",
    );
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

describe("a animação da saudação", () => {
  const animado = lerCodigo("components/bitz/bitz-mascot-animado.tsx");

  it("⭐ é imagem, não vídeo — o material tem fundo branco e o Dexo tem tema escuro", () => {
    // MP4/H.264 não tem canal alpha: no tema escuro o fundo branco vira uma
    // placa luminosa atrás do robô. WebP animado tem alpha e é `<img>`.
    expect(animado).toContain("MASCOT.animacao");
    expect(animado).not.toMatch(/<video|playsInline|autoPlay/);
  });

  it("o arquivo servido é o WebP animado, e o MP4 de 4,9 MB não existe mais", () => {
    expect(
      existsSync(join(raiz, "public/bitz/bitz-mascote-animacao.webp")),
    ).toBe(true);
    // O original tinha 4,9 MB, 4K e 10 s — peso permanente no repositório e no
    // navegador de quem abrisse o chat.
    expect(
      existsSync(join(raiz, "public/bitz/bitz-mascote-animacao.mp4")),
    ).toBe(false);
  });

  it("pesa o que cabe numa saudação", () => {
    const kb =
      statSync(join(raiz, "public/bitz/bitz-mascote-animacao.webp")).size /
      1024;
    expect(kb, `${Math.round(kb)} KB`).toBeLessThan(400);
  });

  it("cai no mascote estático quando falha ou quando pedem menos movimento", () => {
    expect(animado).toContain("prefers-reduced-motion");
    expect(animado).toContain("onError");
    expect(animado).toContain("BitzMascot");
  });

  it("⭐ os 237 KB só saem do servidor depois que o usuário mexe", () => {
    // O peso aqui NÃO é JavaScript — é um arquivo em /public. O que o mantém
    // fora do caminho de quem só quer usar o ERP é o <img> não existir até o
    // clique: o animado é renderizado apenas quando `animando` é true, e o
    // único carregamento antecipado é o pré-aquecimento no hover.
    const widget = lerCodigo("components/bitz/bitz-widget.tsx");
    expect(widget).toMatch(/animando \? \(\s*<BitzMascotAnimado/);

    // E o ponto de entrada do shell não conhece nem o widget nem o animado —
    // é o `dynamic()` do bitz-root que mantém tudo isso fora de todas as
    // páginas quando o módulo está desligado.
    const root = lerCodigo("components/bitz/bitz-root.tsx");
    expect(root).not.toContain("bitz-mascot-animado");
  });
});

describe("⭐ a animação toca no ícone, e o painel espera por ela", () => {
  const widget = lerCodigo("components/bitz/bitz-widget.tsx");

  it("clicar troca o mascote estático pelo animado", () => {
    expect(widget).toContain("BitzMascotAnimado");
    expect(widget).toMatch(/animando \? \(/);
  });

  it("a espera é curta e tem número declarado, não mágico", () => {
    expect(widget).toContain("ESPERA_DA_ANIMACAO_MS");
    const n = Number(
      widget.match(/ESPERA_DA_ANIMACAO_MS = (\d+)/)?.[1] ?? "99999",
    );
    // A animação inteira tem 3 s. Segurar tudo isso em TODA abertura seria
    // cobrar 3 segundos de quem abre o chat dezenas de vezes por dia.
    expect(n).toBeGreaterThanOrEqual(600);
    expect(n).toBeLessThanOrEqual(1600);
  });

  it("⭐ o chunk do painel carrega DURANTE a espera, não depois", () => {
    // `setMounted(true)` antes do timer é o que transforma a espera da animação
    // em tempo útil: quando o painel aparece, ele já está pronto.
    const abrir = widget.slice(
      widget.indexOf("const abrir"),
      widget.indexOf("if (!enabled)"),
    );
    expect(abrir.indexOf("setMounted(true)")).toBeGreaterThan(-1);
    expect(abrir.indexOf("setMounted(true)")).toBeLessThan(
      abrir.indexOf("setTimeout"),
    );
  });

  it("⭐ quem pediu menos movimento não espera nada", () => {
    const abrir = widget.slice(
      widget.indexOf("const abrir"),
      widget.indexOf("if (!enabled)"),
    );
    expect(abrir).toContain("prefers-reduced-motion");
    // O caminho sem movimento sai ANTES de agendar o timer.
    expect(abrir.indexOf("menosMovimento")).toBeLessThan(
      abrir.indexOf("setTimeout"),
    );
  });

  it("clique repetido durante a animação não empilha timer", () => {
    expect(widget).toMatch(/if \(animando\) return/);
    expect(widget).toContain("disabled={animando}");
  });

  it("o timer é cancelado se o componente sair", () => {
    expect(widget).toContain("clearTimeout");
  });

  it("a animação é pré-buscada no hover, junto do chunk do painel", () => {
    // Sem isso o primeiro clique gasta o começo da animação baixando 237 KB.
    expect(widget).toContain("MASCOT.animacao");
    expect(widget).toMatch(/onPointerEnter/);
  });

  it("⭐ o launcher repete a animação sem precisar de chave — mas o painel vai precisar", () => {
    // O launcher desmonta quando o painel abre, então o <img> nasce novo a cada
    // abertura e o WebP recomeça sozinho. Dentro do painel isso NÃO vale: ele
    // fica montado para sempre, e um WebP com loop 1 congela no último quadro.
    // A animação do painel aberto (arquivo próprio, ainda por chegar) vai
    // precisar de uma `key`. Este teste existe para essa armadilha não ser
    // redescoberta na marra.
    expect(widget).toMatch(/\{!open && \(/);
    expect(widget).toMatch(/setMounted\(true\)/);
    expect(widget).not.toMatch(/setMounted\(false\)/);
    expect(widget).toContain("vai precisar de uma chave");
  });
});
