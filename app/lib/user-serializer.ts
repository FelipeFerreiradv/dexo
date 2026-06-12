/**
 * Serializa um usuário para resposta de API removendo campos sensíveis.
 *
 * REGRA DE SEGURANÇA: o campo `password` (hash ou texto) NUNCA pode sair em
 * uma resposta HTTP. Vários endpoints (`GET /users/:id`, `GET /users/me`,
 * `POST /users`, `PUT .../settings`) devolviam o objeto cru do usuário, que
 * inclui `password`. Este helper é o único ponto por onde um usuário deve ser
 * devolvido ao cliente.
 *
 * Mantém todos os demais campos (settings, padrões de anúncio, etc.) intactos,
 * então é zero-regressão para o frontend — só remove o segredo.
 */
export function toPublicUser<T extends { password?: unknown }>(
  user: T,
): Omit<T, "password"> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { password: _password, ...safe } = user;
  return safe;
}
