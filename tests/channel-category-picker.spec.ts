import { describe, expect, it } from "vitest";
import {
  deveBuscar,
  formatarCaminho,
} from "../app/produtos/components/channel-category-picker";

/**
 * As duas regras puras do seletor de categoria de OLX/Facebook.
 *
 * `deveBuscar` é a que segura egress: 1 letra não vale uma ida ao servidor, e
 * termo VAZIO vale — é ele que carrega a lista inteira e resolve o rótulo
 * legível de um valor já salvo. Trocar esse `!==` por `>` (o engano natural)
 * faria o campo reabrir mostrando o id cru, que foi exatamente o defeito que
 * este componente veio corrigir.
 */

describe("formatarCaminho", () => {
  it("troca a barra da taxonomia pelo separador que a tela usa", () => {
    expect(formatarCaminho("Vehicles & Parts / Vehicle Parts / Wheels")).toBe(
      "Vehicles & Parts > Vehicle Parts > Wheels",
    );
  });

  it("apara espaços em volta de cada segmento", () => {
    expect(formatarCaminho("  Veículos /  Peças  / Rodas ")).toBe(
      "Veículos > Peças > Rodas",
    );
  });

  it("descarta segmentos vazios de barras duplicadas ou nas pontas", () => {
    expect(formatarCaminho("/Veículos//Rodas/")).toBe("Veículos > Rodas");
  });

  it("valor sem barra (o id numérico da OLX) passa intacto", () => {
    expect(formatarCaminho("2101")).toBe("2101");
  });

  it("string vazia continua vazia", () => {
    expect(formatarCaminho("")).toBe("");
  });
});

describe("deveBuscar", () => {
  it("termo vazio BUSCA — é ele que carrega a lista e resolve o rótulo salvo", () => {
    expect(deveBuscar("")).toBe(true);
    expect(deveBuscar("   ")).toBe(true);
  });

  it("1 letra não busca: é ruído", () => {
    expect(deveBuscar("r")).toBe(false);
    expect(deveBuscar(" r ")).toBe(false);
  });

  it("2 letras ou mais buscam", () => {
    expect(deveBuscar("ro")).toBe(true);
    expect(deveBuscar("roda")).toBe(true);
  });
});
