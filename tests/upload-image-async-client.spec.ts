import { afterEach, describe, expect, it, vi } from "vitest";

import { getApiBaseUrl } from "../lib/api";
import { uploadProductImage } from "../lib/upload-image";
import {
  fetchImageBgJobs,
  isImageBgJobTerminal,
  retryImageBgJob,
} from "../lib/image-bg-jobs";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeFile(): File {
  return new File([new Uint8Array(8)], "foto.jpg", { type: "image/jpeg" });
}

function okJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

describe("uploadProductImage — opt-in asyncBg (PR 4)", () => {
  it("envia o campo asyncBg SÓ quando pedido junto com removeBackground", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okJson({ imageUrl: "http://x/uploads/a.webp" }));
    // Stub DEPOIS do import (guarda das invariantes do monkey-patch de auth).
    vi.stubGlobal("fetch", fetchMock);

    await uploadProductImage(makeFile(), {
      removeBackground: true,
      addShadow: false,
      asyncBg: true,
    });
    const body1 = fetchMock.mock.calls[0][1].body as FormData;
    expect(body1.get("asyncBg")).toBe("true");

    await uploadProductImage(makeFile(), {
      removeBackground: true,
      addShadow: false,
    });
    const body2 = fetchMock.mock.calls[1][1].body as FormData;
    expect(body2.get("asyncBg")).toBeNull(); // ausente = corpo retrocompatível

    await uploadProductImage(makeFile(), {
      removeBackground: false,
      addShadow: false,
      asyncBg: true, // sem remoção não há o que recortar
    });
    const body3 = fetchMock.mock.calls[2][1].body as FormData;
    expect(body3.get("asyncBg")).toBeNull();
  });

  it("propaga bgJob da resposta (e continua sem ele quando ausente)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      okJson({
        imageUrl: "http://x/uploads/a.webp",
        bgJob: { jobId: "j1", status: "PENDING" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await uploadProductImage(makeFile(), {
      removeBackground: true,
      addShadow: false,
      asyncBg: true,
    });
    expect(result.bgJob).toEqual({ jobId: "j1", status: "PENDING" });

    fetchMock.mockResolvedValueOnce(
      okJson({ imageUrl: "http://x/uploads/b.png" }),
    );
    const sync = await uploadProductImage(makeFile(), {
      removeBackground: true,
      addShadow: false,
    });
    expect(sync.bgJob).toBeUndefined();
  });
});

describe("cliente do polling (lib/image-bg-jobs)", () => {
  it("monta a URL por concatenação com getApiBaseUrl (invariante do auth-bridge)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okJson({ jobs: [{ id: "j1", status: "COMPLETED" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const jobs = await fetchImageBgJobs(["j1", "j2"]);
    expect(jobs).toHaveLength(1);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url.startsWith(`${getApiBaseUrl()}/upload/image/jobs?ids=`)).toBe(
      true,
    );
    expect(decodeURIComponent(url)).toContain("j1,j2");
    // Invariante 3: NUNCA setar authorization manualmente.
    expect(fetchMock.mock.calls[0][1]?.headers).toBeUndefined();
  });

  it("lista vazia nem toca a rede", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchImageBgJobs([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retry devolve true/false conforme o servidor", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true } as Response)
      .mockResolvedValueOnce({ ok: false, status: 404 } as Response);
    vi.stubGlobal("fetch", fetchMock);
    expect(await retryImageBgJob("j1")).toBe(true);
    expect(await retryImageBgJob("j2")).toBe(false);
  });

  it("terminalidade: COMPLETED/FAILED param o polling", () => {
    expect(isImageBgJobTerminal("COMPLETED")).toBe(true);
    expect(isImageBgJobTerminal("FAILED")).toBe(true);
    expect(isImageBgJobTerminal("PENDING")).toBe(false);
    expect(isImageBgJobTerminal("PROCESSING")).toBe(false);
  });
});
