import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import path from "node:path";

// SEMPRE dinâmico e sem cache: o valor precisa refletir o build do servidor
// que está rodando AGORA (não pode ser cacheado em build nem em CDN).
export const dynamic = "force-dynamic";
export const revalidate = 0;

// Lê o build id gravado em .build-id no momento do build (o MESMO arquivo que o
// next.config usa para embutir NEXT_PUBLIC_BUILD_ID no cliente). Lê em runtime,
// por requisição, para refletir o build atualmente em execução e casar
// EXATAMENTE com o id embutido no bundle do cliente — sem depender de Date.now()
// (que mudaria a cada avaliação) nem de reexecutar git em runtime. Fallback: a
// env inlinada; por fim string vazia (cliente sem baseline simplesmente não
// compara).
function readBuildId(): string {
  try {
    const id = readFileSync(path.join(process.cwd(), ".build-id"), "utf8").trim();
    if (id) return id;
  } catch {
    /* arquivo ausente */
  }
  return process.env.NEXT_PUBLIC_BUILD_ID ?? "";
}

// Público, sem auth e sem PII — devolve apenas o build id. Um cliente que ainda
// roda um bundle antigo compara este valor com o id embutido no próprio bundle:
// se diferem, saiu build novo => o UpdateNotifier oferece o reload.
export async function GET() {
  return NextResponse.json(
    { version: readBuildId() },
    {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      },
    },
  );
}
