import { NextRequest, NextResponse } from "next/server";
import { SystemLogService } from "@/app/services/system-log.service";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    const startDate = searchParams.get("startDate")
      ? new Date(searchParams.get("startDate")!)
      : undefined;
    const endDate = searchParams.get("endDate")
      ? new Date(searchParams.get("endDate")!)
      : undefined;

    const stats = await SystemLogService.getStats({
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
