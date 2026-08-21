// @vitest-environment jsdom
//
// A restauração da sucata com o Radix DE VERDADE, dentro de um <form>.
//
// POR QUE ESTE ARQUIVO EXISTE. O outro spec prova os módulos puros — a decisão e
// a derivação das opções. Nenhum deles toca o Radix, e o Radix é justamente o
// motivo de todo o desenho existir. Testar só o helper seria repetir o furo que
// custou um deploy nesta mesma semana: provar que a função devolve o valor
// certo, nunca que a biblioteca o aceita.
//
// `CreateProductDialog` tem mais de 5.000 linhas, dezenas de requisições e
// contexto de sessão — montá-lo num teste não é viável. Então este harness
// replica a FIAÇÃO exata do seletor de sucata daquele modal:
//
//   <form>                                    o corpo do modal é um <form>
//     <Select value={selectedScrap?.id ?? "NONE"}>
//       <SelectItem value="NONE">            "Nenhuma sucata" é a PRIMEIRA
//       {opcoes.map(...)}                     derivadas, nunca do estado cru
//
// e o mesmo efeito de dois commits. O que se mede é o `<select>` NATIVO que o
// Radix mantém espelhando o seletor quando está dentro de um formulário: é ele
// que recusa valor sem `<option>` e devolve a primeira opção pelo eco.

import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import {
  decidirRestauracaoDaSucata,
  opcoesComSucataRestaurada,
  type SucataDoRascunho,
  type SucataDoSeletor,
} from "../app/produtos/lib/scrap-draft-restore";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Polyfills que o Radix exige e o jsdom não traz.
(globalThis as any).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
(globalThis as any).DOMRect = class {
  constructor(
    public x = 0,
    public y = 0,
    public width = 0,
    public height = 0,
  ) {}
  top = 0;
  left = 0;
  right = 0;
  bottom = 0;
  static fromRect() {
    return new (globalThis as any).DOMRect();
  }
  toJSON() {
    return {};
  }
};
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};
if (!(globalThis as any).PointerEvent) {
  (globalThis as any).PointerEvent = class extends Event {};
}

const FUSION: SucataDoSeletor = {
  id: "cmrpmx6f0039y18i6s5c9f6gy",
  brand: "FORD",
  model: "FUSION",
  year: "2009",
  version: "TITANIUM",
  plate: "HHW1478",
};
const OUTRO: SucataDoSeletor = { id: "outro", brand: "GM", model: "ONIX" };

/** Registra que o ramo destrutivo do "Nenhuma sucata" foi executado. */
let apagou: number;

interface Props {
  /** O que a restauração enfileirou. */
  pendente: SucataDoRascunho | null;
  /** O que o servidor devolveu (pode chegar depois e SUBSTITUIR a lista). */
  doServidor: SucataDoSeletor[];
  /**
   * A lista que já estava em memória quando o modal abriu.
   *
   * `availableScraps` nunca é zerado e o componente fica montado entre
   * aberturas — o import de NF-e reaproveita a mesma instância de propósito.
   */
  inicial?: SucataDoSeletor[];
  /**
   * `false` reproduz a PRIMEIRA versão desta correção, que empurrava a opção
   * para dentro da lista do servidor em vez de derivá-la. Serve de controle
   * negativo executável.
   */
  derivar?: boolean;
}

function SeletorDeSucata({
  pendente,
  doServidor,
  inicial = [],
  derivar = true,
}: Props) {
  const [availableScraps, setAvailableScraps] =
    React.useState<SucataDoSeletor[]>(inicial);
  const [sucataRestaurada, setSucataRestaurada] =
    React.useState<SucataDoSeletor | null>(null);
  const [selectedScrap, setSelectedScrap] =
    React.useState<SucataDoSeletor | null>(null);
  const [sucataPendente, setSucataPendente] =
    React.useState<SucataDoRascunho | null>(pendente);

  const opcoes = derivar
    ? opcoesComSucataRestaurada(availableScraps, sucataRestaurada)
    : availableScraps;

  React.useEffect(() => {
    const acao = decidirRestauracaoDaSucata(sucataPendente, opcoes);
    if (acao.tipo === "esperar") return;
    if (acao.tipo === "aplicar") {
      setSelectedScrap(acao.sucata);
      // Fixa a opção mesmo vindo da lista — ver o teste da lista velha.
      if (derivar) setSucataRestaurada(acao.sucata);
      setSucataPendente(null);
      return;
    }
    if (derivar) {
      setSucataRestaurada(acao.opcao);
    } else {
      // O jeito antigo: a opção vira estado da lista — e some quando a
      // resposta do servidor substituir a lista.
      setAvailableScraps((prev) =>
        prev.some((s) => s.id === acao.opcao.id) ? prev : [acao.opcao, ...prev],
      );
    }
    // `opcoes` é derivado a cada render; as deps reais são as fontes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sucataPendente, availableScraps, sucataRestaurada, derivar]);

  /** Simula o `fetch` de `/scraps` chegando e SUBSTITUINDO a lista. */
  const responderServidor = () => setAvailableScraps(doServidor);

  return (
    <form>
      <button type="button" id="servidor" onClick={responderServidor}>
        responder
      </button>
      <Select
        value={selectedScrap?.id ?? "NONE"}
        onValueChange={(v) => {
          if (v === "NONE") {
            // No modal real este ramo apaga marca, modelo, ano, versão e
            // veículo de origem. Aqui basta contar que ele rodou.
            apagou += 1;
            setSelectedScrap(null);
            return;
          }
          const s = opcoes.find((o) => o.id === v);
          if (s) setSelectedScrap(s);
        }}
      >
        <SelectTrigger id="seletor">
          <SelectValue placeholder="Nenhuma sucata selecionada" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="NONE">Nenhuma sucata</SelectItem>
          {opcoes.map((s) => (
            <SelectItem key={s.id} value={s.id}>
              {s.brand} {s.model}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </form>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  apagou = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

// O <select> nativo vive num portal, fora do container. Sem limpar o body, o
// caso seguinte mediria a árvore do anterior.
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

function nativo(): HTMLSelectElement | null {
  return document.querySelector("select");
}

function trigger(): string {
  return document.querySelector("#seletor")?.textContent ?? "";
}

async function montar(props: Props) {
  await act(async () => {
    root.render(<SeletorDeSucata {...props} />);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

async function servidorResponde() {
  await act(async () => {
    (document.querySelector("#servidor") as HTMLButtonElement).click();
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

describe("restaurar a sucata com o Radix real, dentro de <form>", () => {
  it("lote FORA da lista do servidor: o valor entra e o eco não dispara", async () => {
    await montar({ pendente: FUSION, doServidor: [OUTRO] });

    expect(nativo()).not.toBeNull();
    expect(nativo()!.value).toBe(FUSION.id);
    expect(nativo()!.value).not.toBe("NONE");
    expect(trigger()).toContain("FUSION");
    // Se o valor tivesse sido recusado, o Radix devolveria "NONE" e o ramo
    // destrutivo teria rodado.
    expect(apagou).toBe(0);
  });

  it("REGRESSÃO: a resposta do servidor NÃO pode varrer a opção restaurada", async () => {
    // A sequência real. A pergunta "restaurar?" nasce da leitura do
    // localStorage, imediata; o fetch é rede. Então o operador restaura ANTES
    // de a lista chegar — e a lista chega SUBSTITUINDO o estado inteiro.
    await montar({ pendente: FUSION, doServidor: [OUTRO] });
    expect(nativo()!.value).toBe(FUSION.id);

    await servidorResponde();

    expect(nativo()!.value).toBe(FUSION.id);
    expect(apagou).toBe(0);
  });

  it("CONTROLE NEGATIVO: com a opção guardada na lista, o servidor apaga tudo", async () => {
    // Mesmo cenário, com `derivar: false` — a primeira versão desta correção.
    // Isto não é hipótese: o eco roda de verdade e o ramo destrutivo executa.
    await montar({ pendente: FUSION, doServidor: [OUTRO], derivar: false });
    expect(nativo()!.value).toBe(FUSION.id);
    expect(apagou).toBe(0);

    await servidorResponde();

    // O jsdom não propaga o evento `change` do React de volta ao
    // `onValueChange`, então o ECO em si não é observável aqui — mas a
    // DESSINCRONIZAÇÃO, que é a pré-condição dele, é. E ela é o defeito: a
    // opção foi varrida e o browser caiu na primeira. Num navegador de verdade
    // é esse `change` que chega ao `onValueChange` e roda o ramo destrutivo.
    expect(Array.from(nativo()!.options).map((o) => o.value)).toEqual([
      "NONE",
      OUTRO.id,
    ]);
    expect(nativo()!.value).toBe("NONE");
    expect(nativo()!.value).not.toBe(FUSION.id);
  });

  it("lote presente na lista do servidor: caminho comum, sem eco", async () => {
    await montar({ pendente: FUSION, doServidor: [OUTRO, FUSION] });
    await servidorResponde();

    expect(nativo()!.value).toBe(FUSION.id);
    expect(apagou).toBe(0);
  });

  it("REGRESSÃO: lista VELHA escolhe o lote, e a resposta nova não o tem", async () => {
    // `availableScraps` não é zerado e o componente fica montado entre
    // aberturas. Então a lista da abertura anterior pode conter o lote, o ramo
    // `aplicar` ser escolhido por causa dela, e a resposta desta abertura
    // chegar SEM o lote — porque ele foi esgotado nesse meio-tempo.
    //
    // Sem fixar a opção no `aplicar`, a `<option>` sumiria debaixo de um valor
    // já selecionado. Este caso é o que obriga a fixação.
    await montar({ pendente: FUSION, inicial: [FUSION], doServidor: [OUTRO] });
    expect(nativo()!.value).toBe(FUSION.id);

    await servidorResponde();

    expect(nativo()!.value).toBe(FUSION.id);
    expect(Array.from(nativo()!.options).map((o) => o.value)).toContain(
      FUSION.id,
    );
    expect(apagou).toBe(0);
  });

  it("sem rascunho: fica em 'Nenhuma sucata' e nada é aplicado", async () => {
    // O caminho de 99% dos usos tem de continuar inerte.
    await montar({ pendente: null, doServidor: [OUTRO] });
    await servidorResponde();

    expect(nativo()!.value).toBe("NONE");
    expect(apagou).toBe(0);
  });

  it("rascunho antigo (só id) e lote fora da lista: não afirma vínculo nenhum", async () => {
    await montar({ pendente: { id: "so-o-id" }, doServidor: [OUTRO] });
    await servidorResponde();

    expect(nativo()!.value).toBe("NONE");
    expect(apagou).toBe(0);
  });
});
