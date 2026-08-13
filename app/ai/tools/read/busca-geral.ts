// Tool de LEITURA: "e esse código aqui, o que é?".
//
// ⭐ O BURACO QUE ELA TAPA, E POR QUE ELE NÃO É "MAIS UMA BUSCA". O Dexo já tem
// cinco buscas — peça, pedido, cliente, sucata, localização —, cada uma atrás da
// permissão da sua área. Todas respondem MUITO bem à pergunta "acha o pedido do
// Fulano". Nenhuma responde à pergunta que o lojista realmente faz na bancada:
//
//     "4520-A"
//
// Ele leu isso num papel, numa etiqueta ou numa mensagem, e NÃO SABE o que é.
// Hoje o modelo tem de adivinhar a área; se erra, recebe "não achei" e para —
// e a resposta "não achei" está errada, porque ele procurou no lugar errado.
//
// Esta tool não substitui nenhuma das cinco: ela CHAMA as mesmas consultas que
// elas chamam (`ProductUseCase.listProducts`, `OrderUseCase.getOrders`,
// `CustomerUseCase.search`, `ScrapUseCase.listScraps`) e devolve em qual área o
// termo apareceu. Depois disso o modelo vai à tool específica buscar o detalhe.
// É desambiguação, não duplicação — nenhuma linha de consulta nova foi escrita.
//
// ⭐⭐ A GARANTIA CENTRAL DESTE ARQUIVO: A TOOL NUNCA DEIXA O MODELO DIZER
// "NÃO EXISTE" SOBRE UMA ÁREA QUE ELA NÃO OLHOU.
//
// Três coisas diferentes fazem uma área ficar de fora — falta de permissão,
// exclusão por custo e consulta que estourou — e todas as três desembocam na
// MESMA lista `naoProcurei`, com o motivo escrito. Sem isso, um colaborador sem
// acesso a Clientes ouviria "esse código não existe no sistema" quando o que
// houve foi que ninguém procurou. Silêncio virando afirmação é o defeito mais
// caro que uma busca pode ter.
//
// ⚠️ POR QUE `page: "produtos"`, e não uma página "mais neutra": `page` é UM
// PageId só e é ele que o tool-runner usa como porta. Medido em 12/08/2026 nos
// 81 colaboradores em produção: `produtos` é a ÚNICA página que NINGUÉM tem
// desligada (financeiro está desligada para 15, dashboard para 11, sucatas para
// 9). Ou seja, hoje esta porta não fecha para ninguém — e, se um dia alguém
// desligar Produtos, ela fecha inteira em vez de vazar meia busca.
//
// ⚠️ LOCALIZAÇÕES FICOU DE FORA, e o motivo é custo medido:
// `LocationUseCase.listForSelect` traz a lista INTEIRA e filtra em memória —
// 3.284 linhas na maior loja. `buscar_localizacao` paga isso porque quem
// pergunta por prateleira quer prateleira; pagar em TODA busca ambígua seria o
// item mais caro para a resposta menos provável. Ela entra em `naoProcurei` com
// o motivo, e o modelo é instruído a mandar perguntar diretamente.

import { z } from "zod";

import { CustomerUseCase } from "../../../usecases/customer.usecase";
import { OrderUseCase } from "../../../marketplaces/usecases/order.usercase";
import { ProductUseCase } from "../../../usecases/product.usercase";
import { ScrapUseCase } from "../../../usecases/scrap.usercase";
import type { AiScope } from "../../core/scope";
import type { AiTool } from "../registry";
import { money, num, texto } from "../serialize";

/** Amostra por área. O que se quer aqui é O ONDE, não a lista. */
const MAX_POR_AREA = 3;

interface Achado {
  area: string;
  total: number;
  itens: unknown[];
}

interface Ausencia {
  area: string;
  motivo: string;
}

export const buscaGeral: AiTool = {
  name: "busca_geral",
  description:
    "Procura um código, número ou nome AO MESMO TEMPO em peças, pedidos, clientes e sucatas, e diz em qual área ele aparece. " +
    "Use quando o usuário der um identificador solto e NÃO disser o que ele é — um código lido numa etiqueta, um número copiado de uma mensagem, um nome que tanto pode ser peça quanto cliente. " +
    "Quando ele JÁ disser a área ('acha o pedido 123', 'busca o cliente João'), use a busca específica daquela área, que devolve muito mais detalhe. " +
    "Depois de descobrir a área aqui, chame a busca específica dela para o detalhe.",
  args: z
    .object({
      termo: z
        .string()
        .min(2)
        .max(60)
        .describe("O código, número ou nome que o usuário deu, como ele deu."),
    })
    .strict(),
  kind: "read",
  page: "produtos",
  keywords: ["onde", "procur", "encontr", "aparece", "vasculh"],
  sourceLabel: "Busca em todas as áreas",
  handler: async (args, scope: AiScope) => {
    // `String(... ?? "")` e não `args.termo.trim()`: o zod já garante 2–60
    // caracteres no caminho real, mas o handler também é chamado direto pelas
    // varreduras de segurança da suíte, e um `.trim()` de `undefined` derrubaria
    // o turno em vez de responder. Mesmo desfecho do `precisoDeUmFiltro` que
    // `buscar_cliente` já usa.
    const termo = String(args.termo ?? "").trim();
    if (termo.length < 2) {
      return {
        precisoDeUmTermo: true,
        instrucao:
          "Pergunte ao usuário QUAL código ou nome ele quer procurar. Não invente uma busca.",
      };
    }

    const achados: Achado[] = [];
    const ausentes: Ausencia[] = [];

    /**
     * Roda uma área e classifica o desfecho. As três saídas ruins — sem
     * permissão, consulta que estourou, nada encontrado — são DIFERENTES, e
     * misturá-las é exatamente o defeito que este arquivo existe para evitar.
     */
    async function area(
      nome: string,
      pagina: Parameters<AiScope["can"]>[0],
      consultar: () => Promise<{ total: number; itens: unknown[] }>,
    ) {
      if (!scope.can(pagina)) {
        ausentes.push({
          area: nome,
          motivo: "o usuário não tem acesso a esta área",
        });
        return;
      }
      try {
        const r = await consultar();
        if (r.total > 0) achados.push({ area: nome, ...r });
      } catch {
        // Uma área que cai NÃO pode virar "não existe" — vira "não olhei".
        ausentes.push({
          area: nome,
          motivo: "a consulta desta área falhou agora",
        });
      }
    }

    await Promise.all([
      area("peças", "produtos", async () => {
        const { products, total } = await new ProductUseCase().listProducts({
          userId: scope.dataOwnerId,
          search: termo,
          limit: MAX_POR_AREA,
          page: 1,
        });
        return {
          total: num(total) ?? products.length,
          itens: products.map((p: any) => ({
            id: p.id,
            sku: p.sku,
            nome: texto(p.name, 70),
            estoque: num(p.stock),
            preco: money(p.price),
          })),
        };
      }),

      area("pedidos", "pedidos", async () => {
        const r: any = await OrderUseCase.getOrders(scope.dataOwnerId, {
          search: termo,
          page: 1,
          limit: MAX_POR_AREA,
        });
        const pedidos = r?.orders ?? [];
        return {
          total: num(r?.total) ?? pedidos.length,
          itens: pedidos.map((o: any) => ({
            id: o.id,
            numero: o.externalOrderId,
            canal: o.marketplaceAccount?.platform ?? null,
            cliente: o.customerName ?? null,
            valor: money(o.totalAmount),
          })),
        };
      }),

      area("clientes", "clientes", async () => {
        // ⭐ `searchLean` e não `search`: mesmo critério de busca, cinco
        // colunas em vez das quarenta e duas do `Customer` inteiro. A versão
        // completa trazia CPF, RG, data de nascimento e o endereço para uma
        // lista que mostra nome e cidade — achado da auditoria de egress de
        // 13/08/2026. O método é novo e aditivo; o combobox de cliente e a tool
        // `buscar_cliente` continuam usando `search` sem uma linha de mudança.
        const clientes = await new CustomerUseCase().searchLean(
          termo,
          scope.dataOwnerId,
          MAX_POR_AREA,
        );
        const lista = Array.isArray(clientes) ? clientes : [];
        return {
          total: lista.length,
          // ⚠️ SEM DOCUMENTO, NEM MASCARADO. `buscar_cliente` mascara porque a
          // pergunta ali é sobre o cliente; aqui a pergunta é "que área é
          // essa?", e documento não ajuda a responder isso.
          itens: lista.slice(0, MAX_POR_AREA).map((c: any) => ({
            id: c.id,
            nome:
              c.personType === "PJ" ? (c.razaoSocial ?? c.name) : c.name,
            cidade: c.city ?? null,
          })),
        };
      }),

      area("sucatas", "sucatas", async () => {
        const { scraps, total } = await new ScrapUseCase().listScraps({
          userId: scope.dataOwnerId,
          search: termo,
          limit: MAX_POR_AREA,
          page: 1,
        });
        return {
          total: num(total) ?? scraps.length,
          itens: scraps.map((s: any) => ({
            id: s.id,
            veiculo: [s.brand, s.model, s.year].filter(Boolean).join(" "),
            placa: s.plate ?? null,
            apelido: s.nickname ?? null,
          })),
        };
      }),
    ]);

    // A exclusão por custo, dita sempre — inclusive quando algo foi encontrado.
    // "Achei em peças" não autoriza ninguém a concluir que não é uma prateleira.
    ausentes.push({
      area: "localizações",
      motivo:
        "não é consultada nesta busca (é cara demais para rodar em toda pergunta). Se o termo parecer código de prateleira, use `buscar_localizacao`",
    });

    return {
      termo,
      encontradoEm: achados.map((a) => a.area),
      resultados: achados,
      naoProcuradoEm: ausentes,
      instrucao:
        achados.length === 0
          ? "Não apareceu em nenhuma das áreas consultadas. ⚠️ NÃO diga que o código NÃO EXISTE: diga em quais áreas você procurou e liste as de `naoProcuradoEm` como não verificadas. Pergunte ao usuário onde ele viu esse código."
          : "Diga em qual área o termo apareceu e ofereça o detalhe. ⚠️ NÃO afirme nada sobre as áreas de `naoProcuradoEm` — elas não foram consultadas. Para o detalhe, chame a busca específica da área.",
    };
  },
};
