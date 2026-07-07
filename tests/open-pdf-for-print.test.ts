import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openPdfForPrint } from "@/app/lib/open-pdf-for-print";

// vitest roda em environment "node" (sem jsdom), entao stubamos window/document/
// URL/timers manualmente via vi.stubGlobal — sem adicionar jsdom como dependencia.

const fakeBlob = {} as Blob;

describe("openPdfForPrint", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:mock-url"),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("abre o PDF em nova aba e dispara o dialogo de impressao", () => {
    const print = vi.fn();
    const focus = vi.fn();
    const addEventListener = vi.fn();
    const open = vi.fn(() => ({ print, focus, addEventListener }));
    vi.stubGlobal("window", { open });

    const result = openPdfForPrint(fakeBlob, "etiquetas-3.pdf");

    expect(result).toBe("opened");
    expect(URL.createObjectURL).toHaveBeenCalledWith(fakeBlob);
    // Sem "noopener" para manter a referencia da janela.
    expect(open).toHaveBeenCalledWith("blob:mock-url", "_blank");
    expect(addEventListener).toHaveBeenCalledWith("load", expect.any(Function));

    // Ainda nao imprimiu (aguardando load/fallback).
    expect(print).not.toHaveBeenCalled();

    // Fallback de impressao dispara apos ~1.5s.
    vi.advanceTimersByTime(1500);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(print).toHaveBeenCalledTimes(1);

    // A object URL so e revogada bem depois (nao invalida a aba recem-aberta).
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
  });

  it("dispara o print apenas uma vez quando load e fallback concorrem", () => {
    const print = vi.fn();
    let loadHandler: (() => void) | undefined;
    const win = {
      print,
      focus: vi.fn(),
      addEventListener: vi.fn((event: string, cb: () => void) => {
        if (event === "load") loadHandler = cb;
      }),
    };
    vi.stubGlobal("window", { open: vi.fn(() => win) });

    openPdfForPrint(fakeBlob, "x.pdf");

    // O evento "load" dispara primeiro...
    loadHandler?.();
    expect(print).toHaveBeenCalledTimes(1);

    // ...e o fallback por timeout nao deve disparar um segundo dialogo.
    vi.advanceTimersByTime(1500);
    expect(print).toHaveBeenCalledTimes(1);
  });

  it("cai no download quando o pop-up e bloqueado (window.open retorna null)", () => {
    const click = vi.fn();
    const remove = vi.fn();
    const anchor = {
      href: "",
      download: "",
      click,
      remove,
    } as unknown as HTMLAnchorElement;
    const createElement = vi.fn(() => anchor);
    const appendChild = vi.fn();
    vi.stubGlobal("window", { open: vi.fn(() => null) });
    vi.stubGlobal("document", { createElement, body: { appendChild } });

    const result = openPdfForPrint(fakeBlob, "etiquetas-localizacoes-2.pdf");

    expect(result).toBe("downloaded");
    expect(createElement).toHaveBeenCalledWith("a");
    expect(anchor.href).toBe("blob:mock-url");
    expect(anchor.download).toBe("etiquetas-localizacoes-2.pdf");
    expect(appendChild).toHaveBeenCalledWith(anchor);
    expect(click).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
  });

  it("nao propaga erro quando print() lanca (visualizador bloqueia)", () => {
    const win = {
      print: vi.fn(() => {
        throw new Error("blocked by pdf viewer");
      }),
      focus: vi.fn(),
      addEventListener: vi.fn(),
    };
    vi.stubGlobal("window", { open: vi.fn(() => win) });

    const result = openPdfForPrint(fakeBlob, "x.pdf");

    expect(result).toBe("opened");
    expect(() => vi.advanceTimersByTime(1500)).not.toThrow();
    expect(win.print).toHaveBeenCalledTimes(1);
  });
});
