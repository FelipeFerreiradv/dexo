import prisma from "@/app/lib/prisma";
import { AccountStatus } from "@prisma/client";
import { SecretCipher } from "@/app/lib/secret-cipher";

/**
 * Camada de acesso a dados das CONTAS WhatsApp (números conectados).
 *
 * Segredos (accessToken/appSecret) são cifrados em repouso via SecretCipher
 * (AES-256-GCM, MARKETPLACE_TOKEN_ENC_KEY) — validateWhatsAppConfig exige a
 * chave quando o módulo está ligado, então aqui a cifra nunca é no-op em
 * produção. A decifra acontece SÓ nos getters de segredo; os métodos de
 * listagem devolvem shapes sem token (egress).
 */

export interface WhatsAppAccountSummary {
  id: string;
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
  verifiedName: string | null;
  status: AccountStatus;
  createdAt: Date;
}

const SUMMARY_SELECT = {
  id: true,
  wabaId: true,
  phoneNumberId: true,
  displayPhoneNumber: true,
  verifiedName: true,
  status: true,
  createdAt: true,
} as const;

export class WhatsAppRepository {
  /** Contas do tenant (sem segredos), mais novas primeiro. */
  static async findAllByUserId(
    userId: string,
  ): Promise<WhatsAppAccountSummary[]> {
    return prisma.whatsAppAccount.findMany({
      where: { userId },
      select: SUMMARY_SELECT,
      orderBy: { createdAt: "desc" },
    });
  }

  /** Contas ATIVAS do tenant (para o seletor da aba de Mensagens). */
  static async findActiveByUserId(
    userId: string,
  ): Promise<WhatsAppAccountSummary[]> {
    return prisma.whatsAppAccount.findMany({
      where: { userId, status: AccountStatus.ACTIVE },
      select: SUMMARY_SELECT,
      orderBy: { createdAt: "desc" },
    });
  }

  /** Conta por id COM posse do tenant (null se não for do usuário). */
  static async findByIdAndUser(
    accountId: string,
    userId: string,
  ): Promise<WhatsAppAccountSummary | null> {
    return prisma.whatsAppAccount.findFirst({
      where: { id: accountId, userId },
      select: SUMMARY_SELECT,
    });
  }

  /**
   * Conta + segredos DECIFRADOS, com posse do tenant. Uso interno (envio,
   * mídia, sync) — nunca serializar o retorno numa resposta HTTP.
   */
  static async findWithSecretsByIdAndUser(
    accountId: string,
    userId: string,
  ): Promise<
    | (WhatsAppAccountSummary & { accessToken: string; appSecret: string | null })
    | null
  > {
    const account = await prisma.whatsAppAccount.findFirst({
      where: { id: accountId, userId },
    });
    if (!account) return null;
    return {
      id: account.id,
      wabaId: account.wabaId,
      phoneNumberId: account.phoneNumberId,
      displayPhoneNumber: account.displayPhoneNumber,
      verifiedName: account.verifiedName,
      status: account.status,
      createdAt: account.createdAt,
      accessToken: SecretCipher.tryDecrypt(account.accessToken),
      appSecret: account.appSecret
        ? SecretCipher.tryDecrypt(account.appSecret)
        : null,
    };
  }

  /**
   * Conta por phone_number_id (rota do WEBHOOK — sem contexto de usuário).
   * Devolve também o dono (userId) para a checagem de entitlement e os
   * segredos decifrados para validar assinatura/baixar mídia.
   */
  static async findByPhoneNumberIdWithSecrets(phoneNumberId: string): Promise<
    | (WhatsAppAccountSummary & {
        userId: string;
        accessToken: string;
        appSecret: string | null;
      })
    | null
  > {
    const account = await prisma.whatsAppAccount.findUnique({
      where: { phoneNumberId },
    });
    if (!account) return null;
    return {
      id: account.id,
      userId: account.userId,
      wabaId: account.wabaId,
      phoneNumberId: account.phoneNumberId,
      displayPhoneNumber: account.displayPhoneNumber,
      verifiedName: account.verifiedName,
      status: account.status,
      createdAt: account.createdAt,
      accessToken: SecretCipher.tryDecrypt(account.accessToken),
      appSecret: account.appSecret
        ? SecretCipher.tryDecrypt(account.appSecret)
        : null,
    };
  }

  /** Cria a conta cifrando os segredos. P2002 = número já conectado. */
  static async createAccount(data: {
    userId: string;
    wabaId: string;
    phoneNumberId: string;
    displayPhoneNumber: string;
    verifiedName?: string | null;
    accessToken: string;
    appId?: string | null;
    appSecret?: string | null;
  }): Promise<WhatsAppAccountSummary> {
    try {
      return await prisma.whatsAppAccount.create({
        data: {
          userId: data.userId,
          wabaId: data.wabaId,
          phoneNumberId: data.phoneNumberId,
          displayPhoneNumber: data.displayPhoneNumber,
          verifiedName: data.verifiedName ?? null,
          accessToken: SecretCipher.encrypt(data.accessToken),
          appId: data.appId ?? null,
          appSecret: data.appSecret
            ? SecretCipher.encrypt(data.appSecret)
            : null,
          status: AccountStatus.ACTIVE,
        },
        select: SUMMARY_SELECT,
      });
    } catch (error) {
      if ((error as any)?.code === "P2002") {
        throw new Error(
          "Este número de WhatsApp já está conectado (phone_number_id em uso).",
        );
      }
      throw error;
    }
  }

  /** Atualiza status (ex.: token inválido → ERROR; reteste OK → ACTIVE). */
  static async updateStatus(
    accountId: string,
    status: AccountStatus,
  ): Promise<void> {
    await prisma.whatsAppAccount.update({
      where: { id: accountId },
      data: { status },
    });
  }

  /** Atualiza metadados exibidos (após validar na Graph). */
  static async updateDisplayInfo(
    accountId: string,
    data: { displayPhoneNumber?: string; verifiedName?: string | null },
  ): Promise<void> {
    await prisma.whatsAppAccount.update({
      where: { id: accountId },
      data,
    });
  }

  /**
   * Desconecta a conta. Apaga conversas/mensagens junto (dados do canal do
   * próprio tenant) — em transação, filhos primeiro (sem onDelete cascade).
   */
  static async deleteAccount(accountId: string): Promise<void> {
    await prisma.$transaction([
      prisma.whatsAppMessage.deleteMany({
        where: { conversation: { whatsAppAccountId: accountId } },
      }),
      prisma.whatsAppConversation.deleteMany({
        where: { whatsAppAccountId: accountId },
      }),
      prisma.whatsAppAccount.delete({ where: { id: accountId } }),
    ]);
  }
}
