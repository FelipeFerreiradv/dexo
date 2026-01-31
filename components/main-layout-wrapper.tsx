import React from "react";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/lib/auth";
import { MainLayout } from "@/components/main-layout";
import { MainLayoutClient } from "./main-layout-client";

interface MainLayoutWrapperProps {
  children: React.ReactNode;
}

export async function MainLayoutWrapper({ children }: MainLayoutWrapperProps) {
  const session = await getServerSession(authOptions);

  return <MainLayoutClient session={session}>{children}</MainLayoutClient>;
}
