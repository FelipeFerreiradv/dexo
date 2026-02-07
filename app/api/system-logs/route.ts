import { NextRequest, NextResponse } from "next/server";
import { SystemLogService } from "@/app/services/system-log.service";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    // Parâmetros de paginação
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "20");

    // Parâmetros de filtro
    const filters = {
      userId: searchParams.get("userId") || undefined,
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
