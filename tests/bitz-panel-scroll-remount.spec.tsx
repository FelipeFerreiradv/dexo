// @vitest-environment jsdom
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ===========================================================================
// REABRIR O CHAT TEM QUE MANTER O USUÁRIO NO FIM DA CONVERSA.
//
// O bug: `DialogPrimitive.Content` do Radix é envolvido em
// `Presence present={forceMount || open}`. Sem `forceMount`, FECHAR retira o
// container de rolagem do DOM. Ao reabrir, o nó é NOVO e nasce com
// `scrollTop = 0` — e o efeito de autoscroll do painel não roda, porque suas
// dependências (`messages`, `pending`, `streaming`) têm identidade estável
// entre fechar e abrir (vêm de `useState` em hooks/use-bitz-chat.ts).
//
// ⭐ O QUE ESTE ARQUIVO FAZ DE DIFERENTE do spec de contrato: aquele lê o
// TEXTO-FONTE e prova que o painel tem a forma certa. Este monta React de
// verdade e prova o COMPORTAMENTO — inclusive que o padrão ANTIGO falha. Sem o
// controle negativo, um teste de correção não distingue "corrigi" de "sempre
// funcionou".
//
// Escopo honesto: aqui se testa o MECANISMO (ref callback vs. useRef+efeito)
// sob remontagem real do React, não o `BitzPanel` inteiro — montá-lo exigiria
// next-auth, Radix e os hooks de chat. Quem amarra o painel a este mecanismo é
// o spec de contrato, que verifica `ref={fixarRolagem}` no arquivo.
//
// ⚠️ jsdom não faz layout: `scrollHeight` é sempre 0 e `scrollTop` fica preso
// em 0 por causa disso. Por isso `scrollHeight` é definido à mão abaixo — sem
// isso o teste passaria por não medir nada.
// ===========================================================================

// ⚠️ Sem isto o React avisa "not configured to support act(...)" e o flush dos
// efeitos passa a ser comportamento não garantido — o teste até passava, mas
// por sorte. Com a flag, `React.act` sincroniza montagem e efeitos de verdade,
// que é o que o controle negativo precisa para significar alguma coisa.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const ALTURA_DA_CONVERSA = 5000;

let container: HTMLDivElement;
let root: Root;
let descritorOriginal: PropertyDescriptor | undefined;

beforeEach(() => {
  descritorOriginal = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "scrollHeight",
  );
  Object.defineProperty(Element.prototype, "scrollHeight", {
    configurable: true,
    get() {
      return ALTURA_DA_CONVERSA;
    },
  });

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  React.act(() => root.unmount());
  container.remove();
  if (descritorOriginal) {
    Object.defineProperty(Element.prototype, "scrollHeight", descritorOriginal);
  } else {
    delete (Element.prototype as unknown as Record<string, unknown>)
      .scrollHeight;
  }
});

/** Mensagens com identidade ESTÁVEL — o ponto do bug. */
const MENSAGENS = [{ id: "m1" }, { id: "m2" }];

/** Como era antes: `useRef` + efeito com dependências estáveis. */
function PainelAntigo({ aberto }: { aberto: boolean }) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [MENSAGENS]);
  if (!aberto) return null;
  return <div ref={scrollRef} data-testid="rolagem" />;
}

/** Como ficou: ref callback com identidade estável. */
function PainelCorrigido({ aberto }: { aberto: boolean }) {
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const fixarRolagem = React.useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [MENSAGENS]);
  if (!aberto) return null;
  return <div ref={fixarRolagem} data-testid="rolagem" />;
}

const rolagem = () =>
  container.querySelector<HTMLDivElement>('[data-testid="rolagem"]');

function render(no: React.ReactElement) {
  React.act(() => root.render(no));
}

describe("controle negativo: o padrão ANTIGO reproduz o bug", () => {
  it("⚠️ ao reabrir, a conversa volta ao TOPO", () => {
    render(<PainelAntigo aberto />);
    expect(rolagem()!.scrollTop).toBe(ALTURA_DA_CONVERSA);

    // Fecha: o Radix retira o container do DOM.
    render(<PainelAntigo aberto={false} />);
    expect(rolagem()).toBeNull();

    // Reabre: nó NOVO, e o efeito não roda (dependências não mudaram).
    render(<PainelAntigo aberto />);
    expect(rolagem()!.scrollTop).toBe(0);
  });
});

describe("⭐ a correção: ref callback reposiciona na montagem", () => {
  it("ao reabrir, a conversa continua no FIM", () => {
    render(<PainelCorrigido aberto />);
    expect(rolagem()!.scrollTop).toBe(ALTURA_DA_CONVERSA);

    render(<PainelCorrigido aberto={false} />);
    expect(rolagem()).toBeNull();

    render(<PainelCorrigido aberto />);
    expect(rolagem()!.scrollTop).toBe(ALTURA_DA_CONVERSA);
  });

  it("sobrevive a fechar e abrir várias vezes", () => {
    render(<PainelCorrigido aberto />);
    for (let i = 0; i < 3; i++) {
      render(<PainelCorrigido aberto={false} />);
      render(<PainelCorrigido aberto />);
      expect(rolagem()!.scrollTop, `ciclo ${i + 1}`).toBe(ALTURA_DA_CONVERSA);
    }
  });

  it("⭐ NÃO rola sozinho a cada render — o usuário consegue ler o histórico", () => {
    // Se o ref fosse uma arrow inline (ou `useCallback` com dependências), o
    // React desanexaria/reanexaria a cada render e o container voltaria ao fim
    // enquanto o usuário rola para cima. Seria um bug pior que o original.
    render(<PainelCorrigido aberto />);
    const el = rolagem()!;

    // O usuário rola para cima para ler uma mensagem antiga.
    el.scrollTop = 120;

    // Um render qualquer acontece (troca de modo, digitar no composer…).
    render(<PainelCorrigido aberto />);

    expect(rolagem()).toBe(el); // mesmo nó: não houve remontagem
    expect(el.scrollTop).toBe(120); // e a posição do usuário foi respeitada
  });
});
