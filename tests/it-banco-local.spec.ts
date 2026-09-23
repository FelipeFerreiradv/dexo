import { describe, it, expect } from "vitest";
import { ehBancoDeTesteLocal } from "./it/banco-local";

/**
 * A guarda dos testes de integração (tests/it/), que apagam tabelas inteiras:
 * só banco local cujo NOME contém "dexo_it". Roda na suíte normal.
 */
describe("ehBancoDeTesteLocal", () => {
  it("aceita o container local", () => {
    expect(ehBancoDeTesteLocal("postgresql://dexo:x@127.0.0.1:55432/dexo_it")).toBe(true);
    expect(ehBancoDeTesteLocal("postgres://dexo:x@localhost:5432/dexo_it_2")).toBe(true);
    expect(ehBancoDeTesteLocal("postgresql://dexo:x@localhost/meu_dexo_it?sslmode=disable")).toBe(true);
  });

  it("recusa vazio, lixo e outro protocolo", () => {
    expect(ehBancoDeTesteLocal("")).toBe(false);
    expect(ehBancoDeTesteLocal(undefined)).toBe(false);
    expect(ehBancoDeTesteLocal("não é url")).toBe(false);
    expect(ehBancoDeTesteLocal("mysql://u:p@127.0.0.1/dexo_it")).toBe(false);
  });

  it("recusa host remoto, mesmo com o nome dexo_it", () => {
    expect(ehBancoDeTesteLocal("postgresql://u:p@staging.remoto:5432/dexo_it")).toBe(false);
    expect(
      ehBancoDeTesteLocal("postgresql://u:p@aws-0-sa-east-1.pooler.supabase.com:6543/dexo_it"),
    ).toBe(false);
  });

  it("recusa banco local com outro nome", () => {
    expect(ehBancoDeTesteLocal("postgresql://u:p@127.0.0.1:5432/postgres")).toBe(false);
    expect(ehBancoDeTesteLocal("postgresql://u:p@127.0.0.1:5432/dexo")).toBe(false);
  });

  it("a query string NÃO engana (achado da revisão de 23/09)", () => {
    expect(
      ehBancoDeTesteLocal(
        "postgresql://postgres.ref:PW@aws-0-sa-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true&application_name=@localhost/dexo_it",
      ),
    ).toBe(false);
    expect(
      ehBancoDeTesteLocal("postgresql://u:p@staging.remoto:5432/dexo_it?application_name=@localhost/"),
    ).toBe(false);
  });

  it("recusa parâmetro que redireciona a conexão (host=, hostaddr=)", () => {
    expect(ehBancoDeTesteLocal("postgresql://u:p@127.0.0.1:5432/dexo_it?host=remoto.exemplo")).toBe(false);
    expect(ehBancoDeTesteLocal("postgresql://u:p@127.0.0.1:5432/dexo_it?hostaddr=10.0.0.9")).toBe(false);
  });
});
