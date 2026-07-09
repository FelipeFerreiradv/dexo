import { describe, it, expect, vi } from "vitest";

import { requireSuperadmin } from "@/app/middlewares/require-superadmin.middleware";

function fakeReply() {
  const reply: any = {};
  reply.status = vi.fn().mockReturnValue(reply);
  reply.send = vi.fn().mockReturnValue(reply);
  return reply;
}

describe("requireSuperadmin middleware", () => {
  it("403 quando role não é SUPERADMIN (USER)", async () => {
    const reply = fakeReply();
    await requireSuperadmin({ user: { role: "USER" } } as any, reply);
    expect(reply.status).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SUPERADMIN_ONLY" }),
    );
  });

  it("403 quando role é ADMIN (admin comum não é superadmin)", async () => {
    const reply = fakeReply();
    await requireSuperadmin({ user: { role: "ADMIN" } } as any, reply);
    expect(reply.status).toHaveBeenCalledWith(403);
  });

  it("403 quando não há user", async () => {
    const reply = fakeReply();
    await requireSuperadmin({} as any, reply);
    expect(reply.status).toHaveBeenCalledWith(403);
  });

  it("passa (não responde) quando role é SUPERADMIN", async () => {
    const reply = fakeReply();
    await requireSuperadmin({ user: { role: "SUPERADMIN" } } as any, reply);
    expect(reply.status).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });
});
