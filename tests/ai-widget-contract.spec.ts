import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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
