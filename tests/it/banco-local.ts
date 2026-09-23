/**
 * O banco dos testes de integração (tests/it/) é LOCAL e descartável?
 *
 * Esses testes apagam tabelas inteiras. A URL é conferida PARSEADA — host e
 * nome do banco de verdade: uma regex solta sobre a string casava dentro da
 * query string (`?application_name=@localhost/dexo_it`) com qualquer host — e
 * parâmetro que redireciona a conexão (`host=`, `hostaddr=`) é recusado.
 * Sem dependência da aplicação: é importado antes de qualquer import dela.
 */
export function ehBancoDeTesteLocal(url: string | undefined | null): boolean {
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) return false;
  if (!["127.0.0.1", "localhost"].includes(u.hostname)) return false;
  if (!/^\/[^/]*dexo_it[^/]*$/.test(decodeURIComponent(u.pathname))) return false;
  for (const chave of u.searchParams.keys()) {
    if (/host/i.test(chave)) return false;
  }
  return true;
}
