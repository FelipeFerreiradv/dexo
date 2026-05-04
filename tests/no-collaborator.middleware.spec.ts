import { describe, expect, it, vi } from "vitest";
import { blockCollaborator } from "../app/middlewares/no-collaborator.middleware";

function makeReply() {
  const reply: any = {};
  reply.status = vi.fn().mockReturnValue(reply);
  reply.send = vi.fn().mockReturnValue(reply);
  return reply;
}

describe("blockCollaborator middleware", () => {
  it("admin (sem parentUserId) passa direto", async () => {
    const reply = makeReply();
    await blockCollaborator(
      { user: { id: "admin-1", parentUserId: null } } as any,
      reply,
    );
    expect(reply.status).not.toHaveBeenCalled();
  });

  it("admin sem campo parentUserId passa direto", async () => {
    const reply = makeReply();
    await blockCollaborator({ user: { id: "admin-1" } } as any, reply);
    expect(reply.status).not.toHaveBeenCalled();
  });

  it("colaborador (com parentUserId) recebe 403 com código COLLABORATOR_FORBIDDEN", async () => {
    const reply = makeReply();
    await blockCollaborator(
      { user: { id: "collab-9", parentUserId: "admin-1" } } as any,
      reply,
    );
    expect(reply.status).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ code: "COLLABORATOR_FORBIDDEN" }),
    );
  });
});
