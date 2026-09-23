import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import axios from "axios";
import {
  MLApiService,
  ML_COMPAT_MAX_PRODUCTS_PER_CALL,
} from "../app/marketplaces/services/ml-api.service";

/**
 * Compatibilidade em lotes de no máximo 200 produtos por chamada (limite da
 * documentação de Compatibilidades Autopeças do ML, 14/07/2026).
 *
 * Antes da correção da paginação a resolução nunca passava de ~50 produtos
 * (relia a mesma página), então o limite nunca era atingido. Com a paginação
 * certa, um "Gol" sem ano resolve 757 produtos — dry-run da Xaxim, 22/09 — e
 * o lote único estouraria; pior, a queda para "um id por chamada" faria 757
 * PUTs. Aqui: lotes de 200, sem cair para o um-a-um.
 */

vi.mock("axios");
const mockedAxios = axios as unknown as {
  post: ReturnType<typeof vi.fn>;
  isAxiosError: (e: unknown) => boolean;
};

const ids = (n: number) => Array.from({ length: n }, (_, i) => `MLB${1000 + i}`);

describe("setItemCompatibilities em lotes", () => {
  beforeEach(() => {
    (mockedAxios as any).post = vi.fn();
    (mockedAxios as any).isAxiosError = () => false;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("limite é 200", () => {
    expect(ML_COMPAT_MAX_PRODUCTS_PER_CALL).toBe(200);
  });

  it("757 produtos ⇒ 4 chamadas (200+200+200+157), todos enviados", async () => {
    (mockedAxios as any).post.mockResolvedValue({ data: {} });
    const r = await MLApiService.setItemCompatibilities("tok", "MLB1", ids(757));
    const tamanhos = (mockedAxios as any).post.mock.calls.map(
      (c: any[]) => c[1].products.length,
    );
    expect(tamanhos).toEqual([200, 200, 200, 157]);
    expect(r.success).toBe(true);
    expect(r.createdCount).toBe(757);
    expect(r.errors).toEqual([]);
  });

  it("um lote falha ⇒ os outros seguem, SEM cair para um id por chamada", async () => {
    (mockedAxios as any).post
      .mockResolvedValueOnce({ data: {} })
      .mockRejectedValueOnce(new Error("400 lote ruim"))
      .mockResolvedValueOnce({ data: {} });
    const r = await MLApiService.setItemCompatibilities("tok", "MLB1", ids(450));
    expect((mockedAxios as any).post).toHaveBeenCalledTimes(3);
    expect(r.createdCount).toBe(250);
    expect(r.success).toBe(false);
    expect(r.errors.join(" ")).toMatch(/lote ruim/);
  });

  it("até 200 produtos: lote único como sempre (e o um-a-um continua de fallback)", async () => {
    (mockedAxios as any).post
      .mockRejectedValueOnce(new Error("batch 400"))
      .mockResolvedValue({ data: {} });
    const r = await MLApiService.setItemCompatibilities("tok", "MLB1", ids(3));
    // 1 lote + 3 individuais — comportamento de antes.
    expect((mockedAxios as any).post).toHaveBeenCalledTimes(4);
    expect(r.createdCount).toBe(3);
  });

  it("exatamente 200 ⇒ uma chamada só", async () => {
    (mockedAxios as any).post.mockResolvedValue({ data: {} });
    await MLApiService.setItemCompatibilities("tok", "MLB1", ids(200));
    expect((mockedAxios as any).post).toHaveBeenCalledTimes(1);
  });
});
