import { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { UserRepositoryPrisma } from "../repositories/user.repository";

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

        // TODO: Validar senha com bcrypt (agora está em texto plano)
        if (user.password !== credentials.password) {
          return null; // Senha incorreta
        }

        // Retornar dados do usuário autenticado
        return {
          id: user.id,
          email: user.email,
          name: user.name,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
      }
      return session;
    },
  },
  pages: {
    signIn: "/login", // Redireciona para página de login customizada
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
