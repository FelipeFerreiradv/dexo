import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/lib/auth";
import { SystemLogService } from "@/app/services/system-log.service";

export async function GET(request: NextRequest) {
  try {
    // SEGURANÇA: exige sessão e escopa estatísticas ao tenant do usuário.
    const session = await getServerSession(authOptions);
    const sessionUser = session?.user as
      | { id?: string; parentUserId?: string | null }
      | undefined;
    if (!sessionUser?.id) {
      return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
    }

    const userIds = await SystemLogService.getTenantUserIds({
      id: sessionUser.id,
      parentUserId: sessionUser.parentUserId ?? null,
    });

    const { searchParams } = new URL(request.url);

    const startDate = searchParams.get("startDate")
      ? new Date(searchParams.get("startDate")!)
      : undefined;
    const endDate = searchParams.get("endDate")
      ? new Date(searchParams.get("endDate")!)
      : undefined;

    const stats = await SystemLogService.getStats({
      userIds,
      startDate,
      endDate,
    });

    return NextResponse.json(stats);
  } catch (error) {
    console.error("Erro na API de estatísticas de logs:", error);
    return NextResponse.json(
      { error: "Erro interno do servidor" },
      { status: 500 },
    );
  }
}
