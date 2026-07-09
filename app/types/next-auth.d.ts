// app/types/next-auth.d.ts

import { Session, User } from "next-auth";

declare module "next-auth" {
  interface User {
    id: string;
    image?: string | null;
    parentUserId?: string | null;
    role?: string | null;
    pagePermissions?: Record<string, boolean> | null;
  }

  interface Session {
    user: User & {
      id: string;
      image?: string | null;
      parentUserId?: string | null;
      role?: string | null;
      pagePermissions?: Record<string, boolean> | null;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    image?: string | null;
    parentUserId?: string | null;
    role?: string | null;
    pagePermissions?: Record<string, boolean> | null;
  }
}
