import prisma from "@/app/lib/prisma";
import { SyncUseCase } from "@/app/marketplaces/usecases/sync.usercase";

async function run() {
  try {
    const targetEmail = process.env.USER_EMAIL;
    const user = targetEmail
      ? await prisma.user.findFirst({ where: { email: targetEmail } })
      : await prisma.user.findFirst();

    if (!user) {
      console.error(
        "Nenhum usuário encontrado no banco para executar a sincronização.",
      );
      process.exit(1);
    }

    console.log(
      `Usando usuário ${user.id} (${user.email}) para sincronizar categorias ML...`,
    );
    const res = await SyncUseCase.syncMLCategories(user.id, "MLB");
    console.log("Resultado:", res);
    process.exit(0);
  } catch (err) {
    console.error("Erro na sincronização:", err);
    process.exit(1);
  }
}

run();
