import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import axios from "axios";
import { MagaluChatApiService } from "../magalu-chat-api.service";

vi.mock("axios");
const mockedAxios = axios as unknown as {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  isAxiosError: (e: unknown) => boolean;
};

beforeEach(() => {
  (mockedAxios as any).get = vi.fn().mockResolvedValue({ data: {} });
  (mockedAxios as any).post = vi.fn().mockResolvedValue({ data: {} });
  (mockedAxios as any).patch = vi.fn().mockResolvedValue({ data: {} });
  (mockedAxios as any).isAxiosError = (e: any) => !!e && e.isAxiosError === true;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MagaluChatApiService (services.magalu.com/v0)", () => {
  it("listConversations → GET /v0/conversations com status/_limit e Bearer; normaliza results/total", async () => {
    (mockedAxios as any).get.mockResolvedValue({
      data: {
        results: [{ id: "c1" }, { id: "c2" }],
        meta: { page: { total: 5 } },
      },
    });
    const r = await MagaluChatApiService.listConversations("tok", {
      limit: 30,
    });
    expect(r.conversations.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(r.total).toBe(5);
    const [url, config] = (mockedAxios as any).get.mock.calls[0];
    expect(url).toContain("services.magalu.com/v0/conversations");
    expect(url).toContain("status=OPENED");
    expect(url).toContain("_limit=30");
    expect(config.headers.Authorization).toBe("Bearer tok");
  });

  it("listMessages → GET /v0/conversations/:id/messages", async () => {
    (mockedAxios as any).get.mockResolvedValue({
      data: { results: [{ id: "m1", content: "oi" }] },
    });
    const r = await MagaluChatApiService.listMessages("tok", "conv-1");
    expect(r.messages[0].content).toBe("oi");
    const [url] = (mockedAxios as any).get.mock.calls[0];
    expect(url).toContain("/v0/conversations/conv-1/messages");
  });

  it("replyMessage → POST com content + owner (destinatário) e Bearer", async () => {
    (mockedAxios as any).post.mockResolvedValue({ data: { id: "m9" } });
    const msg = await MagaluChatApiService.replyMessage("tok", "conv-1", {
      content: "Bom dia!",
      owner: { external_id: "cust-1", name: "Cliente X" },
    });
    expect(msg.id).toBe("m9");
    const [url, body, config] = (mockedAxios as any).post.mock.calls[0];
    expect(url).toContain("/v0/conversations/conv-1/messages");
    expect(body).toEqual({
      content: "Bom dia!",
      owner: { external_id: "cust-1", name: "Cliente X" },
    });
    expect(config.headers.Authorization).toBe("Bearer tok");
  });

  it("markRead → PATCH /v0/conversations/:id/read_by", async () => {
    await MagaluChatApiService.markRead("tok", "conv-1");
    const [url] = (mockedAxios as any).patch.mock.calls[0];
    expect(url).toContain("/v0/conversations/conv-1/read_by");
  });

  it("propaga erro de auth (401) com .status p/ o refresh detectar", async () => {
    (mockedAxios as any).get.mockRejectedValue({
      isAxiosError: true,
      response: { status: 401, data: { message: "unauthorized" } },
    });
    await expect(
      MagaluChatApiService.listConversations("tok"),
    ).rejects.toMatchObject({ status: 401 });
  });
});
