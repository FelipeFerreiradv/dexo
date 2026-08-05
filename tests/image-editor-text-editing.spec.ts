import { describe, expect, it } from "vitest";

import {
  TEXTAREA_HOST_STYLE,
  clampScroll,
  resolveTextareaHost,
} from "../components/image-editor/text-editing";

// Objetos estruturais: o módulo é puro de propósito (testável em node), então
// não há fabric nem DOM real aqui.
const wrapperEl = { id: "fabric-wrapper" };
const host = { id: "textarea-host" };
const memorizado = { id: "host-memorizado-no-canvas" };

describe("resolveTextareaHost", () => {
  it("usa o host dedicado quando ele existe", () => {
    expect(resolveTextareaHost(wrapperEl, host)).toBe(host);
  });

  it("FALLBACK: sem host, devolve o wrapperEl (comportamento anterior)", () => {
    expect(resolveTextareaHost(wrapperEl)).toBe(wrapperEl);
    expect(resolveTextareaHost(wrapperEl, undefined)).toBe(wrapperEl);
    expect(resolveTextareaHost(wrapperEl, null)).toBe(wrapperEl);
  });

  it("sem host e sem wrapperEl devolve null (nunca undefined)", () => {
    expect(resolveTextareaHost(null)).toBeNull();
    expect(resolveTextareaHost(undefined)).toBeNull();
    expect(resolveTextareaHost(undefined, null)).toBeNull();
  });

  it("host vence mesmo sem wrapperEl", () => {
    expect(resolveTextareaHost(null, host)).toBe(host);
  });

  // Precedência: explícito > memorizado no canvas > wrapperEl. O memorizado é o
  // que cobre `duplicateAnnotation`, que reentra em restoreAnnotations sem opts.
  it("explícito vence o memorizado", () => {
    expect(resolveTextareaHost(wrapperEl, host, memorizado)).toBe(host);
  });

  it("sem explícito, o memorizado vence o wrapperEl", () => {
    expect(resolveTextareaHost(wrapperEl, null, memorizado)).toBe(memorizado);
    expect(resolveTextareaHost(wrapperEl, undefined, memorizado)).toBe(
      memorizado,
    );
  });

  it("todos os candidatos vazios caem no wrapperEl", () => {
    expect(resolveTextareaHost(wrapperEl, null, undefined)).toBe(wrapperEl);
  });
});

describe("clampScroll", () => {
  it("devolve o wrapper ao enquadramento quando ele saiu do lugar", () => {
    const el = { scrollLeft: 487, scrollTop: 132 };
    expect(clampScroll(el)).toBe(true);
    expect(el).toEqual({ scrollLeft: 0, scrollTop: 0 });
  });

  it("basta um dos eixos ter saído", () => {
    const soX = { scrollLeft: 12, scrollTop: 0 };
    expect(clampScroll(soX)).toBe(true);
    expect(soX).toEqual({ scrollLeft: 0, scrollTop: 0 });

    const soY = { scrollLeft: 0, scrollTop: 9 };
    expect(clampScroll(soY)).toBe(true);
    expect(soY).toEqual({ scrollLeft: 0, scrollTop: 0 });
  });

  it("NO-OP no caminho feliz: já zerado não escreve nada", () => {
    const el = { scrollLeft: 0, scrollTop: 0 };
    expect(clampScroll(el)).toBe(false);
  });

  it("tolera elemento ausente", () => {
    expect(clampScroll(null)).toBe(false);
    expect(clampScroll(undefined)).toBe(false);
  });
});

describe("TEXTAREA_HOST_STYLE", () => {
  // As três propriedades são o que impede o salto: `fixed` põe o bloco de
  // contenção na origem do viewport (mesmo referencial de canvas._offset dentro
  // de um dialog fixed), o tamanho zero + overflow hidden fazem do host um
  // scroll box vazio — rolar ele não move o canvas.
  it("é fixed, de tamanho zero e clipado", () => {
    expect(TEXTAREA_HOST_STYLE.position).toBe("fixed");
    expect(TEXTAREA_HOST_STYLE.left).toBe(0);
    expect(TEXTAREA_HOST_STYLE.top).toBe(0);
    expect(TEXTAREA_HOST_STYLE.width).toBe(0);
    expect(TEXTAREA_HOST_STYLE.height).toBe(0);
    expect(TEXTAREA_HOST_STYLE.overflow).toBe("hidden");
  });

  it("não é `relative`/`absolute` — seriam o bug de novo", () => {
    expect(TEXTAREA_HOST_STYLE.position).not.toBe("relative");
    expect(TEXTAREA_HOST_STYLE.position).not.toBe("absolute");
  });
});
