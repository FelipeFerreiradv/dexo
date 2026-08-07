import { Role } from "@prisma/client";

export interface User {
  id: string;
  email: string;
  password: string;
  role: Role;
  parentUserId?: string | null;
  name?: string | null;
  avatarUrl?: string | null;
  defaultProductDescription?: string | null;
  defaultCostPrice?: number | null;
  defaultStock?: number | null;

  // Padrões de anúncio ML
  defaultListingType?: string | null;
  defaultHasWarranty?: boolean | null;
  defaultWarrantyUnit?: string | null;
  defaultWarrantyDuration?: number | null;
  defaultItemCondition?: string | null;
  defaultShippingMode?: string | null;
  defaultFreeShipping?: boolean | null;
  defaultLocalPickup?: boolean | null;
  defaultManufacturingTime?: number | null;

  // Aumento percentual escalonado entre contas ML (default 0 = desativado)
  crossAccountPriceIncreasePercent?: number | null;

  // Acesso liberado (raw). false = bloqueado; default true. Ver isActive no schema.
  isActive: boolean;
  // Efetivo: considera o admin pai. false se o próprio OU o pai estiver bloqueado.
  // Calculado em mapUser; é o que as checagens de bloqueio devem usar.
  effectiveActive: boolean;

  // Permissões de acesso por página (colaboradores). null = acesso total.
  pagePermissions?: Record<string, boolean> | null;

  // Bitz (agente de IA): concessão individual e teto diário próprio.
  // null/null = sem concessão e sem teto próprio, que é o estado de todo
  // usuário existente. Quem decide o acesso efetivo é
  // `ai-entitlement.service.ts` — a prévia gratuita pode liberar mesmo sem
  // concessão.
  aiEnabledAt?: Date | null;
  aiDailyLimit?: number | null;

  createdAt: Date;
  updatedAt: Date;
}

export interface UserCreate {
  email: string;
  name?: string | null;
  password: string;
  avatarUrl?: string | null;
  defaultProductDescription?: string | null;
  defaultCostPrice?: number | null;
  defaultStock?: number | null;
  role?: Role;
  parentUserId?: string | null;
  pagePermissions?: Record<string, boolean> | null;
}

export interface UserUpdate {
  name?: string | null;
  password?: string;
  avatarUrl?: string | null;
  defaultProductDescription?: string | null;
  defaultCostPrice?: number | null;
  defaultStock?: number | null;

  // Padrões de anúncio ML
  defaultListingType?: string | null;
  defaultHasWarranty?: boolean | null;
  defaultWarrantyUnit?: string | null;
  defaultWarrantyDuration?: number | null;
  defaultItemCondition?: string | null;
  defaultShippingMode?: string | null;
  defaultFreeShipping?: boolean | null;
  defaultLocalPickup?: boolean | null;
  defaultManufacturingTime?: number | null;

  // Aumento percentual escalonado entre contas ML (default 0 = desativado)
  crossAccountPriceIncreasePercent?: number | null;

  // ⚠️ `role` continua aqui por compatibilidade de tipo, mas `update()` NÃO o
  // grava — nunca gravou. Não é caminho de escalada.
  role?: Role;

  // ⚠️ `isActive` e `pagePermissions` NÃO MORAM MAIS AQUI. Ver
  // `UserAccessControlUpdate`, logo abaixo.
}

/**
 * Campos de CONTROLE DE ACESSO — quem pode entrar e o que pode ver.
 *
 * ⭐ FORA DE `UserUpdate` POR SEGURANÇA, e a razão é um defeito real que existia
 * no sistema: `PUT /users/me/settings` e `PUT /users/:id/settings` tipam o corpo
 * como `UserUpdate` e o repassam INTEIRO para `updateSettings`. Enquanto estes
 * dois campos estavam lá, qualquer usuário autenticado — inclusive um
 * COLABORADOR com páginas bloqueadas — se auto-liberava com um único PUT:
 *
 *     PUT /users/me/settings  {"pagePermissions": {}}
 *
 * (mapa vazio = acesso a TUDO, por definição do schema), e também podia escrever
 * o próprio `isActive`.
 *
 * A trava é de TIPO, não de disciplina: as rotas de autoatendimento não
 * alcançam este objeto, e qualquer campo sensível acrescentado aqui no futuro
 * nasce protegido pelo mesmo motivo.
 *
 * Quem escreve: `team.routes` (admin sobre o próprio colaborador) e
 * `superadmin.routes` — ambas com checagem de posse/role ANTES de chamar.
 */
export interface UserAccessControlUpdate {
  /** Acesso liberado/bloqueado. undefined => não altera. */
  isActive?: boolean;
  /** Permissões por página. `null`/`{}` = acesso total. undefined => não altera. */
  pagePermissions?: Record<string, boolean> | null;
}

/**
 * Concessão e teto do Bitz. **DE PROPÓSITO FORA DE `UserUpdate`.**
 *
 * ⭐ ISTO É UMA TRAVA DE SEGURANÇA, NÃO ORGANIZAÇÃO. `PUT /users/me/settings`
 * tipa o corpo como `UserUpdate` e o repassa INTEIRO para `updateSettings`
 * (user.routes.ts). Se estes dois campos morassem lá, qualquer usuário
 * autenticado se auto-concederia o Bitz com cota ilimitada num único PUT:
 *
 *     PUT /users/me/settings  {"aiEnabledAt":"...","aiDailyLimit":999999}
 *
 * Mantendo-os num tipo separado, escrito por um método próprio do repositório,
 * a rota de settings NÃO CONSEGUE alcançá-los — a garantia é do compilador, não
 * da disciplina de quem revisa.
 */
export interface UserAiAccessUpdate {
  /** null = revoga; Date = concede. undefined => não altera. */
  aiEnabledAt?: Date | null;
  /** null = usa o padrão global; número = teto próprio. undefined => não altera. */
  aiDailyLimit?: number | null;
}

export interface UserRepository {
  create(data: UserCreate): Promise<User>;
  findByEmail(email: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
  findChildren(parentUserId: string): Promise<User[]>;
  update(id: string, data: UserUpdate): Promise<User>;
  /**
   * Escreve APENAS a concessão e o teto do Bitz. Método próprio de propósito —
   * ver o comentário de `UserAiAccessUpdate`. Chamado só pela rota de
   * Superadmin.
   */
  updateAiAccess(id: string, data: UserAiAccessUpdate): Promise<User>;
  /**
   * Escreve APENAS controle de acesso (`isActive`, `pagePermissions`). Método
   * próprio de propósito — ver o comentário de `UserAccessControlUpdate`.
   * Chamado só por rotas que já checaram posse ou role.
   */
  updateAccessControl(
    id: string,
    data: UserAccessControlUpdate,
  ): Promise<User>;
  getLastSkuSequential(id: string): Promise<number | null>;
  bumpLastSkuSequential(id: string, candidate: number): Promise<void>;
  reserveNextSkuSequential(id: string): Promise<number>;
}
