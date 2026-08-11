import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import axios from "axios";
import { OlxApiService } from "../olx-api.service";
import type { OlxAd } from "../../types/olx-api.types";

vi.mock("axios");
const mockedAxios = axios as unknown as {
  put: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  isAxiosError: (e: unknown) => boolean;
};

beforeEach(() => {
  (mockedAxios as any).put = vi
    .fn()
    .mockResolvedValue({ data: { token: "tok-1", statusCode: 0 } });
  (mockedAxios as any).post = vi
    .fn()
    .mockResolvedValue({ data: { autoupload_status: "done", ads: {} } });
  (mockedAxios as any).isAxiosError = (e: any) =>
    !!e && e.isAxiosError === true;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const sampleAd: Omit<OlxAd, "operation"> = {
  id: "SKU1",
  category: 123,
  Subject: "Peça",
  Body: "descrição",
  Phone: "21999998888",
  type: "u",
  price: 100,
  zipcode: "20000000",
};

describe("OlxApiService", () => {
  it("submitImport → PUT /autoupload/import com access_token no CORPO (não Bearer)", async () => {
    await OlxApiService.submitImport("access-tok", [
      { ...sampleAd, operation: "insert" },
    ]);
    const [url, body, cfg] = (mockedAxios as any).put.mock.calls[0];
    expect(url).toContain("/autoupload/import");
    expect(body.access_token).toBe("access-tok");
    expect(body.ad_list).toHaveLength(1);
    // OLX NÃO usa Authorization Bearer
    expect(cfg.headers.Authorization).toBeUndefined();
  });

  it("upsertAd envia operation insert", async () => {
    await OlxApiService.upsertAd("tok", sampleAd);
    const body = (mockedAxios as any).put.mock.calls[0][1];
    expect(body.ad_list[0].operation).toBe("insert");
    expect(body.ad_list[0].id).toBe("SKU1");
  });

  it("deleteAd envia operation delete com o mesmo id", async () => {
    await OlxApiService.deleteAd("tok", "SKU1");
    const body = (mockedAxios as any).put.mock.calls[0][1];
    expect(body.ad_list[0].operation).toBe("delete");
    expect(body.ad_list[0].id).toBe("SKU1");
  });

  it("getImportStatus → POST /autoupload/import/{token} com access_token", async () => {
    await OlxApiService.getImportStatus("tok", "import-token-9");
    const [url, body] = (mockedAxios as any).post.mock.calls[0];
    expect(url).toContain("/autoupload/import/import-token-9");
    expect(body.access_token).toBe("tok");
  });
});
