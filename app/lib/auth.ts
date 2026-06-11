import { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { UserRepositoryPrisma } from "../repositories/user.repository";
import { verifyPassword } from "./password";

const userRepository = new UserRepositoryPrisma();

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          return null;
        }

        // Buscar usuário no banco
        const user = await userRepository.findByEmail(credentials.email);

        if (!user) {
          return null; // Usuário não existe
        }

        // Validação com bcrypt + rehash transparente do legado em texto plano.
        const { valid, needsRehash } = await verifyPassword(
          credentials.password,
          user.password,
        );
        if (!valid) {
          return null; // Senha incorreta
        }
        if (needsRehash) {
          // Migra a senha legada para hash neste login (o repositório faz o hash).
          // Falha aqui não pode bloquear o login válido.
          try {
            await userRepository.update(user.id, {
              password: credentials.password,
            });
          } catch {
            // best-effort: tenta de novo no próximo login.
          }
        }

        // Retornar dados do usuário autenticado
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.avatarUrl ?? undefined,
          // Campos custom propagados pra JWT/session — usados pelo front
          // pra esconder UI (ex.: botões de conectar marketplace) e lookup da equipe.
          parentUserId: user.parentUserId ?? null,
          role: user.role,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        // @ts-expect-error - carry custom avatar url
        token.image = (user as any).image;
        token.parentUserId = (user as any).parentUserId ?? null;
        token.role = (user as any).role ?? null;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        // @ts-expect-error - expose avatar url on session
        session.user.image = (token as any).image as string | undefined;
        session.user.parentUserId =
          (token.parentUserId as string | null) ?? null;
        session.user.role = (token.role as string | null) ?? null;
      }
      return session;
    },
  },
  pages: {
    signIn: "/login",
    error: "/login",
  },
  secret: process.env.NEXTAUTH_SECRET,
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60, // 30 dias
  },
  jwt: {
    maxAge: 30 * 24 * 60 * 60, // 30 dias
  },
};
