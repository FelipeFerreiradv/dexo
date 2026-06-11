import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/lib/auth";
import { SystemLogService } from "@/app/services/system-log.service";

export async function GET(request: NextRequest) {
  try {
    // SEGURANÇA: exige sessão válida e escopa os logs ao tenant do usuário.
    // Antes esta rota era pública e sem escopo — vazava logs (com PII no
    // `details`) de todos os tenants para qualquer um.
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

    // Parâmetros de paginação
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "20");

    // Parâmetros de filtro (o escopo de tenant `userIds` é imposto pelo servidor
    // e NÃO pode ser sobrescrito pelo cliente).
    const filters = {
      userIds,
      action: (searchParams.get("action") as any) || undefined, // Cast necessário pois vem como string da URL
      resource: searchParams.get("resource") || undefined,
      level: searchParams.get("level") as
        | "INFO"
        | "WARNING"
        | "ERROR"
        | undefined,
      startDate: searchParams.get("startDate")
        ? new Date(searchParams.get("startDate")!)
        : undefined,
      endDate: searchParams.get("endDate")
        ? new Date(searchParams.get("endDate")!)
        : undefined,
      search: searchParams.get("search") || undefined,
    };

    const result = await SystemLogService.getLogs({
      page,
      limit,
      filters,
    });

    return NextResponse.json({
      logs: result.logs,
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages: result.totalPages,
      },
    });
  } catch (error) {
    console.error("Erro na API de logs:", error);
    return NextResponse.json(
      { error: "Erro interno do servidor" },
      { status: 500 },
    );
  }
}
