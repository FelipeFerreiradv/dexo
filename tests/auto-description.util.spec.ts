import { describe, it, expect } from "vitest";
import { shouldApplyAutoDescription } from "../app/produtos/components/auto-description.util";

describe("shouldApplyAutoDescription", () => {
  it("blocks auto-description when defaultDescription is applied and user didn't edit name/partNumber", () => {
    const res = shouldApplyAutoDescription({
      open: true,
      watchName: "Filtro ar",
      originalName: "Filtro ar",
      watchPartNumber: "",
      originalPartNumber: "",
      currentDescription: "Descrição padrão do usuário",
      defaultDescription: "Descrição padrão do usuário",
      dirtyName: false,
      dirtyPartNumber: false,
    });

    expect(res).toBe(false);
  });

  it("allows auto-description when user edits the name (dirtyName) even if defaultDescription is present", () => {
    const res = shouldApplyAutoDescription({
      open: true,
      watchName: "Filtro ar novo",
      originalName: "Filtro ar",
      watchPartNumber: "",
      originalPartNumber: "",
      currentDescription: "Descrição padrão do usuário",
      defaultDescription: "Descrição padrão do usuário",
      dirtyName: true,
      dirtyPartNumber: false,
    });

    expect(res).toBe(true);
  });

  it("allows auto-description when name changed and no defaultDescription", () => {
    const res = shouldApplyAutoDescription({
      open: true,
      watchName: "Cubo Roda",
      originalName: "Cubo Roda Antigo",
      currentDescription: "",
      defaultDescription: "",
    });

    expect(res).toBe(true);
  });

  it("returns false when dialog is closed", () => {
    const res = shouldApplyAutoDescription({
      open: false,
      watchName: "X",
      originalName: "Y",
      currentDescription: "",
      defaultDescription: "",
    });

    expect(res).toBe(false);
  });
});
