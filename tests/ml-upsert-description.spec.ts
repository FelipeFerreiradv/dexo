import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * MLApiService.upsertDescription — descrição com emoji ficava VAZIA no ML e a
 * Dexo registrava sucesso (23/09/2026, SKU 7167). Agora: tira o emoji que o
 * ML recusa, confere o que ficou gravado quando o texto tem símbolo e, se
 * ficou vazio, regrava sem os símbolos — ou FALHA (visível), nunca finge.
 */

const { mockPost, mockPut, mockGet } = vi.hoisted(() => ({
  mockPost: vi.fn(),
  mockPut: vi.fn(),
  mockGet: vi.fn(),
}));

vi.mock("axios", () => {
  const isAxiosError = (e: unknown) =>
    !!(e as { isAxiosError?: boolean } | null)?.isAxiosError;
  return {
    default: { post: mockPost, put: mockPut, get: mockGet, isAxiosError },
    isAxiosError,
  };
});

import { MLApiService } from "../app/marketplaces/services/ml-api.service";
import { MLDescriptionNotSavedError } from "../app/marketplaces/lib/ml-description-text";

const erroMl = (status: number, data: unknown) => ({
  isAxiosError: true,
  response: { status, data },
  message: `Request failed with status code ${status}`,
});
const JA_TEM = erroMl(400, { message: "bad request", error: "bad_request" });
const CARACTERE = erroMl(400, {
  message: "Validation error",
  error: "validation_error",
  status: 400,
  cause: [
    {
      cause_id: 398,
      code: "item.description.type.invalid",
      references: ["plain_text[0]"],
      message: "The description must be in plain text",
    },
  ],
});
const corpo = (fn: typeof mockPost, i = 0) => fn.mock.calls[i]?.[1]?.plain_text;
const url = (fn: typeof mockPost, i = 0) => String(fn.mock.calls[i]?.[0] ?? "");

beforeEach(() => {
  // reset (não clear): valores "Once" que sobram de um teste não vazam para o próximo
  vi.resetAllMocks();
  MLApiService.descriptionReadbackDelayMs = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mockPost.mockResolvedValue({ data: {} });
  mockPut.mockResolvedValue({ data: {} });
  mockGet.mockResolvedValue({ data: { plain_text: "gravada" } });
});

describe("upsertDescription", () => {
  it("descrição comum: UM POST com o texto idêntico e nenhuma leitura a mais", async () => {
    const t = "Peça original — usada.\n• 90 dias de garantia";
    await MLApiService.upsertDescription("tok", "MLB1", t);
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(corpo(mockPost)).toBe(t);
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("emoji fora do plano básico (🚗) sai antes de enviar", async () => {
    await MLApiService.upsertDescription("tok", "MLB1", "🚗 Loja ATUBA\nPeças usadas");
    expect(corpo(mockPost)).toBe("Loja ATUBA\nPeças usadas");
  });

  it("descrição já existente: o PUT vai para a MESMA URL de antes, com o texto idêntico", async () => {
    mockPost.mockRejectedValueOnce(JA_TEM);
    await MLApiService.upsertDescription("tok", "MLB1", "Texto comum");
    expect(url(mockPut)).toMatch(/\/items\/MLB1\/description$/);
    expect(corpo(mockPut)).toBe("Texto comum");
  });

  it("CASO SKU 7167: o ML aceita e grava VAZIO ⇒ confere, regrava sem os símbolos e confirma", async () => {
    mockGet
      .mockResolvedValueOnce({ data: { plain_text: "" } }) // gravou vazio
      .mockResolvedValueOnce({ data: { plain_text: "ATENÇÃO: só hidráulica" } });
    mockPost.mockResolvedValueOnce({ data: {} }).mockRejectedValueOnce(JA_TEM);
    await MLApiService.upsertDescription("tok", "MLB7690407976", "⚠️ ATENÇÃO: só hidráulica");
    expect(corpo(mockPost, 0)).toBe("⚠ ATENÇÃO: só hidráulica"); // 1ª: sem o seletor
    expect(corpo(mockPut, 0)).toBe("ATENÇÃO: só hidráulica"); // 2ª: sem símbolo
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it("continua VAZIO depois de regravar ⇒ FALHA tipada (o chamador registra), nunca finge sucesso", async () => {
    mockGet.mockResolvedValue({ data: { plain_text: "" } });
    const p = MLApiService.upsertDescription("tok", "MLB1", "⚠️ ATENÇÃO");
    await expect(p).rejects.toThrow(/VAZIA/);
    await expect(p).rejects.toBeInstanceOf(MLDescriptionNotSavedError);
  });

  it("descrição gravada só no campo HTML (`text`) conta como gravada: não regrava", async () => {
    mockGet.mockResolvedValueOnce({ data: { plain_text: "", text: "<p>ATENÇÃO</p>" } });
    await MLApiService.upsertDescription("tok", "MLB1", "⚠️ ATENÇÃO");
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("recusa 398 que o estrito não resolve ⇒ FALHA tipada 'rejected'", async () => {
    mockPost.mockRejectedValueOnce(CARACTERE);
    mockPut.mockRejectedValueOnce(CARACTERE);
    const p = MLApiService.upsertDescription("tok", "MLB1", "Texto comum");
    await expect(p).rejects.toBeInstanceOf(MLDescriptionNotSavedError);
    await expect(p).rejects.toMatchObject({ reason: "rejected" });
  });

  it("símbolo que não é emoji (●) também é conferido e sai na regravação", async () => {
    mockGet
      .mockResolvedValueOnce({ data: { plain_text: "" } })
      .mockResolvedValueOnce({ data: { plain_text: "Peça revisada" } });
    mockPost.mockResolvedValueOnce({ data: {} }).mockRejectedValueOnce(JA_TEM);
    await MLApiService.upsertDescription("tok", "MLB1", "● Peça revisada");
    expect(corpo(mockPost, 0)).toBe("● Peça revisada");
    expect(corpo(mockPut, 0)).toBe("Peça revisada");
  });

  it("letra de outro alfabeto (sem símbolo) não ganha leitura a mais", async () => {
    await MLApiService.upsertDescription("tok", "MLB1", "部品 original");
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("recusa explícita de caractere (cause 398) ⇒ regrava sem os símbolos", async () => {
    mockPost.mockRejectedValueOnce(CARACTERE).mockRejectedValueOnce(JA_TEM);
    mockPut.mockRejectedValueOnce(CARACTERE).mockResolvedValueOnce({ data: {} });
    await MLApiService.upsertDescription("tok", "MLB1", "✅ Testada");
    expect(corpo(mockPut, 1)).toBe("Testada");
  });

  it("outro erro (token) sobe como antes, sem regravar", async () => {
    const e401 = erroMl(401, { message: "invalid_token" });
    mockPost.mockRejectedValueOnce(e401);
    await expect(MLApiService.upsertDescription("tok", "MLB1", "✅ Testada")).rejects.toThrow();
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("leitura de conferência falhou ⇒ não insiste nem falha (não sabe)", async () => {
    mockGet.mockRejectedValueOnce(erroMl(503, {}));
    await expect(MLApiService.upsertDescription("tok", "MLB1", "✅ Testada")).resolves.toBeUndefined();
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("texto vazio: nada é enviado (como antes)", async () => {
    await MLApiService.upsertDescription("tok", "MLB1", "   ");
    expect(mockPost).not.toHaveBeenCalled();
  });
});
