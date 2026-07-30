/**
 * Documento tecnico-funcional da entrega de Ingestao de Pedidos, para as equipes
 * de Suporte, Implantacao e Customer Success.
 *
 * Usa o template institucional de relatorios da Dexo (app/reports): mesma capa,
 * mesmo cabecalho corrente, mesmo rodape com paginacao, mesma paleta de 14 cores
 * do Manual de Marca e as mesmas familias de fonte.
 *
 * Gerar:  npx tsx scripts/docs/gerar-doc-ingestao-pedidos.ts
 */
import React from "react";
import { Document, Page, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { DEXO, FONT } from "../../app/reports/theme";
import { registerReportFonts } from "../../app/reports/fonts";
import {
  Cover,
  Footer,
  RunningHeader,
  SectionHeader,
  s,
} from "../../app/reports/primitives";

// ─── blocos de texto reaproveitaveis, no estilo do template ──────────────────

const P: React.FC<{ children: React.ReactNode; mb?: number }> = ({
  children,
  mb = 7,
}) => (
  <Text style={{ fontSize: 9, lineHeight: 1.55, marginBottom: mb }}>
    {children}
  </Text>
);

const Forte: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Text style={{ fontFamily: FONT.display, fontSize: 9 }}>{children}</Text>
);

const Cod: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Text style={{ fontFamily: FONT.mono, fontSize: 8, color: DEXO.petroleoMedio }}>
    {children}
  </Text>
);

const Item: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <View style={{ flexDirection: "row", marginBottom: 4, paddingLeft: 2 }}>
    <Text style={{ color: DEXO.amarelo, fontSize: 9, marginRight: 6 }}>—</Text>
    <Text style={{ fontSize: 9, lineHeight: 1.5, flex: 1 }}>{children}</Text>
  </View>
);

const SubTitulo: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Text
    style={{
      fontFamily: FONT.display,
      fontSize: 10.5,
      color: DEXO.petroleoMedio,
      marginTop: 10,
      marginBottom: 5,
    }}
  >
    {children}
  </Text>
);

/** Caixa de destaque com a barra amarela da marca. */
const Destaque: React.FC<{ titulo: string; children: React.ReactNode }> = ({
  titulo,
  children,
}) => (
  <View
    style={{
      backgroundColor: DEXO.pergaminho,
      borderLeftWidth: 3,
      borderLeftColor: DEXO.amarelo,
      padding: 9,
      marginBottom: 9,
    }}
  >
    <Text
      style={{
        fontFamily: FONT.display,
        fontSize: 9,
        marginBottom: 4,
        color: DEXO.petroleoProfundo,
      }}
    >
      {titulo}
    </Text>
    <Text style={{ fontSize: 8.5, lineHeight: 1.5 }}>{children}</Text>
  </View>
);

/** Tabela simples com cabecalho em Petroleo e zebra em Pergaminho. */
const Tabela: React.FC<{
  colunas: string[];
  larguras: number[];
  linhas: string[][];
}> = ({ colunas, larguras, linhas }) => (
  <View style={{ marginBottom: 10 }}>
    <View
      style={{
        flexDirection: "row",
        backgroundColor: DEXO.petroleoProfundo,
        paddingVertical: 5,
        paddingHorizontal: 6,
      }}
    >
      {colunas.map((c, i) => (
        <Text
          key={c}
          style={{
            width: `${larguras[i]}%`,
            fontFamily: FONT.mono,
            fontSize: 6.8,
            color: DEXO.creme,
            letterSpacing: 0.6,
          }}
        >
          {c.toUpperCase()}
        </Text>
      ))}
    </View>
    {linhas.map((linha, idx) => (
      <View
        key={idx}
        style={{
          flexDirection: "row",
          paddingVertical: 4.5,
          paddingHorizontal: 6,
          backgroundColor: idx % 2 ? DEXO.pergaminho : DEXO.branco,
          borderBottomWidth: 0.5,
          borderBottomColor: DEXO.bege,
        }}
        wrap={false}
      >
        {linha.map((celula, i) => (
          <Text
            key={i}
            style={{ width: `${larguras[i]}%`, fontSize: 8, lineHeight: 1.4 }}
          >
            {celula}
          </Text>
        ))}
      </View>
    ))}
  </View>
);

const META = {
  company: "Dexo · Engenharia",
  periodLabel: "Entrega de 30/07/2026",
  generatedAtLabel: "Gerado em 30/07/2026",
};

function Pagina({ children }: { children: React.ReactNode }) {
  return (
    <Page size="A4" style={s.page}>
      <RunningHeader company={META.company} periodLabel={META.periodLabel} />
      {children}
      <Footer periodLabel={META.periodLabel} />
    </Page>
  );
}

export function DocIngestaoPedidos() {
  return (
    <Document
      title="Ingestão de Pedidos — Guia para Suporte, Implantação e CS"
      author="Dexo · Engenharia"
      subject="Entrega de ingestão de pedidos de marketplace"
    >
      {/* ─── CAPA ─────────────────────────────────────────────────────────── */}
      <Page size="A4" style={{ ...s.page, padding: 0 }}>
        <Cover
          kicker="ENGENHARIA · ENTREGA TÉCNICA"
          title="Ingestão de Pedidos"
          subtitle="Toda venda de marketplace vira pedido no Dexo, com data correta e estoque baixado. Guia para Suporte, Implantação e Customer Success."
          periodLabel={META.periodLabel}
          company={META.company}
          generatedAtLabel={META.generatedAtLabel}
        />
      </Page>

      {/* ─── SUMÁRIO + RESUMO EXECUTIVO ───────────────────────────────────── */}
      <Pagina>
        <SectionHeader>Sumário</SectionHeader>
        <Tabela
          colunas={["Seção", "Conteúdo", "Público"]}
          larguras={[8, 62, 30]}
          linhas={[
            ["1", "Resumo executivo", "Todos"],
            ["2", "Alterações realizadas", "Suporte · CS"],
            ["3", "Melhorias de performance", "Engenharia · CS"],
            ["4", "Revisão de segurança e egress", "Engenharia"],
            ["5", "Impacto para os clientes", "Suporte · CS · Cliente"],
            ["6", "Como utilizar", "Suporte · Cliente"],
            ["7", "Perguntas frequentes", "Suporte"],
            ["8", "Checklist de validação", "Suporte · Implantação"],
            ["9", "Resumo técnico", "Engenharia"],
          ]}
        />

        <SectionHeader>1. Resumo executivo</SectionHeader>

        <SubTitulo>O que motivou</SubTitulo>
        <P>
          Um cliente relatou uma venda da Shopee que não aparecia no Dexo. A
          investigação mostrou que o problema era maior do que um pedido: o ciclo
          que busca vendas nos marketplaces estava levando{" "}
          <Forte>até 71,9 horas</Forte> para completar uma volta, e a Shopee não
          enviava nenhum aviso automático de venda — zero em 30 dias, contra
          593.352 do Mercado Livre. O único caminho de entrada era esse ciclo
          lento.
        </P>
        <P>
          Ao olhar 60 dias para trás, apareceram vendas que nunca entraram. Não
          por falha pontual: porque nenhum código registrava quando um pedido era
          descartado.
        </P>

        <SubTitulo>O que foi entregue</SubTitulo>
        <Item>
          A busca de pedidos passou a rodar a cada <Forte>15 minutos</Forte>,
          separada da varredura de catálogo que a atrasava.
        </Item>
        <Item>
          A Shopee agora envia aviso automático de venda, validado por assinatura
          criptográfica.
        </Item>
        <Item>
          Todo pedido que não pode ser importado por completo entra em uma lista
          de <Forte>pendências visível ao cliente</Forte>, com o motivo em
          português. Nada mais é descartado em silêncio.
        </Item>
        <Item>
          O pedido passou a guardar a <Forte>data real da venda</Forte>, e não a
          hora em que o Dexo importou.
        </Item>
        <Item>
          Vendas que estavam invisíveis apareceram:{" "}
          <Forte>173 pedidos, R$ 40.303,99</Forte>, em 8 clientes.
        </Item>

        <SubTitulo>Resultado</SubTitulo>
        <Destaque titulo="O compromisso que passa a ser cumprido">
          Toda venda concretizada num marketplace conectado vira pedido no Dexo e
          baixa estoque. Quando algo impede — normalmente o produto não estar
          cadastrado —, o pedido aparece na lista de pendências dizendo
          exatamente o que falta, em vez de desaparecer.
        </Destaque>
      </Pagina>

      {/* ─── 2. ALTERAÇÕES ────────────────────────────────────────────────── */}
      <Pagina>
        <SectionHeader>2. Alterações realizadas</SectionHeader>

        <SubTitulo>2.1 Velocidade da busca de pedidos</SubTitulo>
        <Tabela
          colunas={["Item", "Descrição"]}
          larguras={[26, 74]}
          linhas={[
            ["Componente", "Processo de sincronização de pedidos"],
            [
              "Problema anterior",
              "Uma volta única e sequencial fazia, por conta conectada, importar pedidos e também varrer o catálogo inteiro, comentários e mensagens. Com cerca de 79 contas, uma volta chegou a 71,9 horas.",
            ],
            [
              "Solução",
              "Duas rotinas independentes: pedidos a cada 15 minutos, catálogo a cada 6 horas. Contas processadas em paralelo, com limite conservador.",
            ],
            [
              "Benefício",
              "Uma venda passa a entrar em minutos em vez de horas ou dias.",
            ],
            [
              "Impacto",
              "Menor risco de vender a mesma peça em dois canais (oversell), porque o estoque baixa mais rápido.",
            ],
          ]}
        />

        <SubTitulo>2.2 Aviso automático de venda da Shopee</SubTitulo>
        <Tabela
          colunas={["Item", "Descrição"]}
          larguras={[26, 74]}
          linhas={[
            ["Componente", "Recebimento de avisos (webhook) da Shopee"],
            [
              "Problema anterior",
              "A Shopee não enviava aviso nenhum, e o endereço que recebe esses avisos não conferia a autenticidade de quem chamava.",
            ],
            [
              "Solução",
              "Endereço cadastrado no portal da Shopee e verificação por assinatura criptográfica em cada aviso recebido.",
            ],
            [
              "Benefício",
              "A venda chega em segundos, e nenhum aviso falso consegue movimentar estoque.",
            ],
            [
              "Impacto",
              "A busca de 15 minutos continua ativa como rede de segurança.",
            ],
          ]}
        />

        <SubTitulo>2.3 Lista de pendências de importação</SubTitulo>
        <Tabela
          colunas={["Item", "Descrição"]}
          larguras={[26, 74]}
          linhas={[
            ["Componente", "Tela de Pedidos · aviso de pendências"],
            [
              "Problema anterior",
              "Se o anúncio vendido não estivesse ligado a um produto do estoque, o pedido era descartado sem deixar rastro — sem registro, sem aviso, e o ciclo era gravado como concluído sem erro.",
            ],
            [
              "Solução",
              "Cada pedido nessa situação entra numa lista visível, com o motivo em português e o SKU envolvido. Vale para Mercado Livre, Shopee e Magalu.",
            ],
            [
              "Benefício",
              "O cliente passa a saber que a venda existe e o que precisa fazer.",
            ],
            [
              "Impacto",
              "Quando o produto é cadastrado, o pedido entra sozinho e o estoque baixa, sem intervenção.",
            ],
          ]}
        />

        <SubTitulo>2.4 Data real da venda</SubTitulo>
        <Tabela
          colunas={["Item", "Descrição"]}
          larguras={[26, 74]}
          linhas={[
            ["Componente", "Pedidos · Dashboard · Financeiro"],
            [
              "Problema anterior",
              "O pedido só guardava a hora em que o Dexo o importou, e era por ela que os relatórios filtravam. O faturamento aparecia na data da importação, não na data da compra. Na época dos ciclos de 71,9 horas isso deslocava vendas em até 3 dias, às vezes atravessando a virada do mês.",
            ],
            [
              "Solução",
              "O pedido passou a guardar a data informada pelo próprio marketplace. Relatórios usam essa data quando ela existe e a data de importação quando não existe.",
            ],
            [
              "Benefício",
              "Faturamento no mês correto. Pedidos antigos continuam se comportando exatamente como antes.",
            ],
            [
              "Impacto",
              "Nenhuma ação necessária. Nenhum número histórico foi reescrito.",
            ],
          ]}
        />
      </Pagina>

      <Pagina>
        <SubTitulo>2.5 Venda de produto não cadastrado (Shopee)</SubTitulo>
        <Tabela
          colunas={["Item", "Descrição"]}
          larguras={[26, 74]}
          linhas={[
            ["Componente", "Importação de pedidos da Shopee"],
            [
              "Problema anterior",
              "Venda de anúncio criado direto na Shopee, cujo produto nunca foi cadastrado no Dexo, não virava pedido nenhum. A venda existia lá e não existia aqui: fora de Pedidos, fora do Financeiro, fora do Dashboard.",
            ],
            [
              "Solução",
              "O pedido é criado com o valor da venda e sem itens, e a pendência continua aberta para a parte do estoque.",
            ],
            [
              "Benefício",
              "A venda entra no faturamento. Quando o produto é cadastrado, o item é acrescentado e o estoque baixa automaticamente.",
            ],
            [
              "Impacto",
              "173 vendas (R$ 40.303,99) passaram a aparecer em 8 clientes. Detalhes na seção 5.",
            ],
          ]}
        />
        <Destaque titulo="Por que só na Shopee, por enquanto">
          Criar o pedido sem itens só é seguro onde existe o caminho que
          acrescenta os itens depois. Hoje esse caminho existe apenas na Shopee.
          No Mercado Livre e na Magalu a venda fica registrada na lista de
          pendências — visível e rastreável —, mas o pedido não é criado ainda,
          para não gerar um pedido que ficaria permanentemente incompleto.
        </Destaque>

        <SubTitulo>2.6 Pendência que depende do cliente</SubTitulo>
        <Tabela
          colunas={["Item", "Descrição"]}
          larguras={[26, 74]}
          linhas={[
            ["Componente", "Reprocessamento automático de pendências"],
            [
              "Problema anterior",
              "O sistema tentava reimportar indefinidamente pendências que só o cliente pode resolver. Em produção havia 89 nessa situação, sendo consultadas na Shopee de hora em hora, para sempre — e o aviso na tela nunca zerava.",
            ],
            [
              "Solução",
              'A pendência que esgota as tentativas passa ao estado "precisa da sua ação": sai do reprocessamento automático e permanece na tela, com o texto explicando o que fazer.',
            ],
            [
              "Benefício",
              "O aviso volta a significar algo, e o consumo de chamadas ao marketplace para de crescer.",
            ],
            [
              "Impacto",
              'O botão "Tentar novamente" continua funcionando. Se o cliente cadastra o produto, a pendência fecha sozinha.',
            ],
          ]}
        />

        <SubTitulo>2.7 Correções de robustez</SubTitulo>
        <Item>
          Falha na baixa de estoque passou a ser registrada e reprocessada, em vez
          de ficar só no log do servidor.
        </Item>
        <Item>
          A janela de busca da Shopee passou a ser varrida em blocos, cobrindo
          períodos que antes eram descartados em silêncio.
        </Item>
        <Item>
          Falha de importação por conta virou registro visível ao dono dos dados —
          foi o que permitiu identificar 9 contas com problema (seção 5.4).
        </Item>
        <Item>
          Duas correções contra baixa dupla de estoque, detalhadas na seção 9.
        </Item>
      </Pagina>

      {/* ─── 3. PERFORMANCE ───────────────────────────────────────────────── */}
      <Pagina>
        <SectionHeader>3. Melhorias de performance</SectionHeader>
        <P>
          Todas as medições abaixo vêm de produção. Nenhuma dessas mudanças altera
          o que o sistema faz — apenas o custo de fazer.
        </P>

        <Tabela
          colunas={["Onde", "Antes", "Depois"]}
          larguras={[30, 35, 35]}
          linhas={[
            [
              "Volta da busca de pedidos",
              "até 71,9 horas",
              "cerca de 15 minutos",
            ],
            [
              "Reprocessamento de uma pendência",
              "varredura completa da janela + leitura de todos os anúncios da conta",
              "consulta apenas do pedido em questão",
            ],
            [
              "Leitura de catálogo numa busca dirigida",
              "cerca de 1,6 MB por chamada (conta com 11.670 anúncios)",
              "1 a 2 consultas por identificador",
            ],
            [
              "Registro de pendência já conhecida",
              "2.376 registros em 2 horas (~28 mil/dia)",
              "um registro por pendência",
            ],
            [
              "Consulta de produto para checar existência",
              "linha inteira do produto, com 3 campos grandes",
              "somente o identificador",
            ],
            [
              "Filtro de período nos relatórios",
              "varredura da tabela",
              "índice dedicado",
            ],
            [
              "Memória por aviso recebido",
              "teto de 1 MB em rota pública",
              "teto de 64 KB",
            ],
          ]}
        />

        <SubTitulo>Redução de chamadas a marketplaces</SubTitulo>
        <Item>
          O reprocessamento de pendências deixou de varrer a janela inteira: no
          pico, isso representava cerca de 22 vezes o tráfego necessário de
          importação.
        </Item>
        <Item>
          Pendências que só o cliente resolve saíram do reprocessamento
          automático — eram 89 consultas por hora, indefinidamente.
        </Item>

        <SubTitulo>Redução de leituras no banco</SubTitulo>
        <Item>
          Busca dirigida não lê mais o catálogo completo da conta.
        </Item>
        <Item>
          Consultas de existência de produto passaram a trazer apenas o
          identificador, seguindo a convenção já estabelecida no projeto.
        </Item>
        <Item>
          O aviso de pendência deixou de ser reescrito a cada volta da
          sincronização.
        </Item>
      </Pagina>

      {/* ─── 4. SEGURANÇA E EGRESS ────────────────────────────────────────── */}
      <Pagina>
        <SectionHeader>4. Revisão de segurança e egress</SectionHeader>

        <SubTitulo>Como a revisão foi feita</SubTitulo>
        <P>
          As diretrizes de redução de consumo estabelecidas no trabalho anterior
          de Segurança e Otimização foram extraídas do próprio código — dos
          comentários marcados como <Cod>EGRESS</Cod> e do histórico das entregas
          de performance — e transformadas em uma lista de regras verificáveis.
          Cada arquivo desta entrega foi então auditado contra essa lista.
        </P>
        <P>
          A auditoria foi conduzida por múltiplos revisores independentes, e cada
          achado passou por três avaliações distintas: se o custo alegado se
          confirma nos números de produção, se a correção proposta preserva o
          comportamento, e uma tentativa deliberada de refutar o achado.
        </P>

        <SubTitulo>Regras verificadas</SubTitulo>
        <Item>
          Nenhuma leitura sem seleção explícita de campos em caminho recorrente.
        </Item>
        <Item>
          Proibido carregar a linha inteira de um produto numa consulta de
          anúncios.
        </Item>
        <Item>
          Listagens trazem apenas o que desenham; o detalhe recarrega.
        </Item>
        <Item>Agregações acontecem no banco, não em memória.</Item>
        <Item>
          Pré-carga em lote no lugar de consultas repetidas dentro de laços.
        </Item>
        <Item>
          Guarda de novidade antes de carregar coleções grandes.
        </Item>
        <Item>
          Paginação de API externa com teto e sinalização de truncamento.
        </Item>

        <SubTitulo>Resultado</SubTitulo>
        <Destaque titulo="Nenhum aumento de consumo">
          Nenhuma alteração desta entrega aumenta o volume de dados lidos do banco
          ou o número de chamadas a marketplaces. Foram identificadas cinco
          oportunidades de redução, todas corrigidas. Três regressões introduzidas
          por esta própria entrega foram encontradas e corrigidas antes da
          publicação.
        </Destaque>

        <SubTitulo>Segurança</SubTitulo>
        <Item>
          O endereço que recebe avisos da Shopee é público por natureza. Passou a
          exigir assinatura criptográfica válida; sem ela, a requisição é recusada
          e não movimenta nada.
        </Item>
        <Item>
          O teto de memória desse endereço foi reduzido de 1 MB para 64 KB — 300
          vezes o tamanho real de um aviso.
        </Item>
        <Item>
          O registro de recusas passou a ser amortecido, para que ninguém consiga
          inflar a base de dados enviando requisições inválidas.
        </Item>
        <Item>
          Nenhum dado de comprador e nenhuma credencial são gravados nos registros
          de pendência.
        </Item>
        <Item>
          Todas as consultas continuam limitadas ao dono dos dados; não há
          cruzamento entre clientes.
        </Item>
      </Pagina>

      {/* ─── 5. IMPACTO PARA OS CLIENTES ──────────────────────────────────── */}
      <Pagina>
        <SectionHeader>5. Impacto para os clientes</SectionHeader>

        <SubTitulo>5.1 O que mudou</SubTitulo>
        <Item>Vendas entram em minutos, não em horas.</Item>
        <Item>
          Existe um aviso na tela de Pedidos listando vendas que não puderam ser
          importadas por completo, com o motivo.
        </Item>
        <Item>
          O faturamento passa a ser contado na data da compra.
        </Item>
        <Item>
          Vendas da Shopee de produtos não cadastrados passaram a aparecer.
        </Item>

        <SubTitulo>5.2 O que NÃO mudou</SubTitulo>
        <Item>Nenhuma tela foi redesenhada.</Item>
        <Item>Nenhum relatório histórico foi reescrito.</Item>
        <Item>Nenhuma configuração precisa ser alterada pelo cliente.</Item>
        <Item>
          A forma de cadastrar produto, publicar anúncio e emitir nota continua a
          mesma.
        </Item>

        <SubTitulo>5.3 Atenção: o faturamento de 8 clientes aumenta</SubTitulo>
        <P>
          Vendas que existiam no marketplace e não existiam no Dexo passaram a
          aparecer. É receita real que estava faltando, e está datada no mês
          correto. Ainda assim, <Forte>o número muda</Forte>, e o cliente pode
          estranhar.
        </P>
        <Tabela
          colunas={["Cliente", "Pedidos", "Valor"]}
          larguras={[52, 18, 30]}
          linhas={[
            ["expedmpv@gmail.com", "82", "R$ 11.713,03"],
            ["leonardo.lima.borges@outlook.com.br", "34", "R$ 5.508,18"],
            ["mk2autopecas@gmail.com", "17", "R$ 7.056,49"],
            ["leoneloautoparts@gmail.com", "14", "R$ 2.089,91"],
            ["atendimento@motorsmania.com.br", "9", "R$ 8.484,78"],
            ["alfaautopecas2024@gmail.com", "8", "R$ 3.833,76"],
            ["rebootecparts@gmail.com", "6", "R$ 1.033,24"],
            ["bcvautopecasltda@gmail.com", "3", "R$ 584,60"],
          ]}
        />
        <P>
          Cada um desses pedidos aparece sem itens e com uma pendência indicando o
          SKU a cadastrar. Ao cadastrar, o item entra e o estoque baixa.
        </P>

        <SubTitulo>5.4 Nove contas precisam de ação</SubTitulo>
        <P>
          A nova visibilidade de falhas revelou contas que não estavam importando
          venda alguma. As seis primeiras exigem contato com o cliente.
        </P>
        <Tabela
          colunas={["Cliente", "Conta", "Ação"]}
          larguras={[36, 34, 30]}
          linhas={[
            ["reviveautocar@yahoo.com", "Shopee 1796989274", "Reconectar"],
            ["reviveautocar@yahoo.com", "Shopee 1493518131", "Reconectar"],
            ["Jrmimports9@gmail.com", "Shopee 1131967803", "Reconectar"],
            ["Jrmimports9@gmail.com", "Shopee 1796396261", "Reconectar"],
            ["vipautopartslondrina@gmail.com", "Shopee 1386089464", "Reconectar"],
            [
              "srlautopecas@gmail.com",
              "Shopee 1869753763",
              "Vendedor: completar autorização",
            ],
            [
              "mauriciomoraes81@hotmail.com.br",
              "Magalu GENPUB.3233ed84",
              "Investigar (engenharia)",
            ],
            ["reviveautocar@yahoo.com", "ML JOSILEI", "Nenhuma (transitório)"],
            [
              "erikaarantesm@yahoo.com.br",
              "ML MESQUITA-AUTOPECAS",
              "Nenhuma (transitório)",
            ],
          ]}
        />
      </Pagina>

      {/* ─── 6. COMO UTILIZAR ─────────────────────────────────────────────── */}
      <Pagina>
        <SectionHeader>6. Como utilizar</SectionHeader>

        <SubTitulo>6.1 Resolver uma pendência de importação</SubTitulo>
        <P>Passo a passo para orientar o cliente:</P>
        <Tabela
          colunas={["Passo", "Ação"]}
          larguras={[12, 88]}
          linhas={[
            ["1", "Abrir a tela Pedidos."],
            [
              "2",
              "Localizar o aviso de pendências de importação, acima da lista.",
            ],
            [
              "3",
              "Ler o motivo. Na maioria dos casos será: o anúncio vendido não está vinculado a nenhum produto do estoque.",
            ],
            [
              "4",
              "Anotar o SKU indicado e cadastrar o produto correspondente em Produtos.",
            ],
            [
              "5",
              'Voltar à tela de Pedidos e clicar em "Tentar novamente" na pendência.',
            ],
            [
              "6",
              "A pendência sai da lista, o pedido passa a ter o item e o estoque é baixado.",
            ],
          ]}
        />
        <Destaque titulo="Não é obrigatório clicar no botão">
          Se o cliente apenas cadastrar o produto, a próxima sincronização
          resolve sozinha em até 15 minutos. O botão serve para não esperar.
        </Destaque>

        <SubTitulo>6.2 Entender uma pendência que precisa de ação</SubTitulo>
        <P>
          Quando a pendência exibe{" "}
          <Forte>“Precisa da sua ação — não estamos mais tentando sozinhos”</Forte>
          , significa que o sistema tentou cinco vezes e concluiu que só o cadastro
          do produto resolve. A pendência continua na tela e o botão continua
          funcionando; apenas o reprocessamento automático parou.
        </P>

        <SubTitulo>6.3 Reconectar uma conta de marketplace</SubTitulo>
        <Tabela
          colunas={["Passo", "Ação"]}
          larguras={[12, 88]}
          linhas={[
            ["1", "Abrir Integrações e escolher o marketplace."],
            ["2", "Localizar a conta indicada pelo suporte."],
            ["3", "Refazer a conexão e autorizar o acesso."],
            [
              "4",
              "Aguardar até 15 minutos e conferir se os pedidos voltaram a entrar.",
            ],
          ]}
        />
        <P>
          Recomendação: usar navegador em janela limpa, sem sessão de outra conta
          do marketplace aberta.
        </P>
      </Pagina>

      {/* ─── 7. FAQ ───────────────────────────────────────────────────────── */}
      <Pagina>
        <SectionHeader>7. Perguntas frequentes</SectionHeader>

        <SubTitulo>“Apareceram pedidos antigos que eu nunca vi. É erro?”</SubTitulo>
        <P>
          Não. São vendas que existiam no marketplace e não estavam no Dexo,
          porque o produto vendido não estava cadastrado. Agora aparecem, com a
          data correta da venda.
        </P>

        <SubTitulo>“Meu faturamento do mês mudou. Por quê?”</SubTitulo>
        <P>
          Por dois motivos possíveis. Primeiro: vendas que faltavam passaram a ser
          contadas. Segundo: o faturamento passou a ser contado na data da compra,
          e não na data em que o Dexo importou — o que corrige vendas que estavam
          no mês errado. Nenhum valor foi inventado ou duplicado.
        </P>

        <SubTitulo>“Tem pedido sem nenhum item. Está quebrado?”</SubTitulo>
        <P>
          Não. É uma venda cujo produto não está cadastrado no Dexo. O pedido
          existe para a venda não ficar invisível e para o faturamento fechar. Ao
          cadastrar o produto, o item entra automaticamente.
        </P>

        <SubTitulo>“Consigo emitir nota desse pedido sem itens?”</SubTitulo>
        <P>
          Não, e a tentativa exibe uma mensagem clara. É preciso cadastrar o
          produto e vinculá-lo ao pedido antes de emitir.
        </P>

        <SubTitulo>“O estoque foi baixado duas vezes?”</SubTitulo>
        <P>
          Não. A verificação foi feita em produção sobre todos os pedidos das
          últimas 24 horas: nenhum apresentou baixa maior que a quantidade
          vendida. Duas proteções distintas foram adicionadas nesta entrega.
        </P>

        <SubTitulo>“A pendência não sai da tela. E agora?”</SubTitulo>
        <P>
          Confirmar se o produto foi realmente cadastrado com o SKU indicado na
          pendência. Se sim, clicar em “Tentar novamente”. Se continuar, acionar a
          engenharia informando o número do pedido.
        </P>

        <SubTitulo>“Preciso mudar alguma configuração?”</SubTitulo>
        <P>Não. Nenhuma ação é necessária por parte do cliente.</P>

        <SubTitulo>“Por que a Magalu e o ML não criam o pedido vazio?”</SubTitulo>
        <P>
          Porque nesses dois marketplaces ainda não existe o caminho que
          acrescenta os itens depois. Criar o pedido agora produziria um pedido
          permanentemente incompleto. A venda fica registrada na lista de
          pendências até que esse caminho exista.
        </P>
      </Pagina>

      {/* ─── 8. CHECKLIST ─────────────────────────────────────────────────── */}
      <Pagina>
        <SectionHeader>8. Checklist para o suporte</SectionHeader>
        <P>
          Validação rápida após a atualização. Todos os itens devem ser
          verdadeiros.
        </P>
        <Tabela
          colunas={["#", "Verificação", "Resultado esperado"]}
          larguras={[7, 55, 38]}
          linhas={[
            [
              "1",
              "Abrir a tela Pedidos de um cliente com Shopee conectada",
              "A tela carrega normalmente",
            ],
            [
              "2",
              "Conferir se há pedidos com data das últimas horas",
              "Pedidos recentes presentes",
            ],
            [
              "3",
              "Verificar o aviso de pendências",
              "Ausente se não houver pendência; presente com motivo em português se houver",
            ],
            [
              "4",
              "Abrir um pedido e conferir os itens",
              "Itens e valores corretos",
            ],
            [
              "5",
              "Conferir o estoque de um produto vendido hoje",
              "Estoque reduzido pela quantidade vendida",
            ],
            [
              "6",
              "Abrir o Dashboard",
              "Gráficos carregam, sem erro",
            ],
            [
              "7",
              "Conferir o faturamento do mês",
              "Valor coerente; aumento possível nos 8 clientes da seção 5.3",
            ],
            [
              "8",
              "Cadastrar um produto de uma pendência e clicar em Tentar novamente",
              "A pendência sai da lista",
            ],
            [
              "9",
              "Emitir NF-e de um pedido normal",
              "Emissão funciona como antes",
            ],
            [
              "10",
              "Tentar emitir NF-e de pedido sem itens",
              "Mensagem clara pedindo para cadastrar o produto",
            ],
            [
              "11",
              "Conferir a tela de Logs do cliente",
              "Sem enxurrada de mensagens repetidas",
            ],
          ]}
        />
        <Destaque titulo="Quando escalar para a engenharia">
          Pendência que não sai depois de o produto ser cadastrado e o botão ser
          usado; estoque com valor divergente do esperado; qualquer pedido
          duplicado. Informar sempre o e-mail do cliente e o número do pedido.
        </Destaque>
      </Pagina>

      {/* ─── 9. RESUMO TÉCNICO ────────────────────────────────────────────── */}
      <Pagina>
        <SectionHeader>9. Resumo técnico</SectionHeader>

        <SubTitulo>Módulos impactados</SubTitulo>
        <Item>
          Ingestão de pedidos dos três marketplaces (importação, vínculo
          item↔produto, baixa de estoque).
        </Item>
        <Item>
          Quarentena de ingestão e reconciliador de pendências.
        </Item>
        <Item>
          Recebimento e verificação de avisos da Shopee.
        </Item>
        <Item>
          Repositório de pedidos, Dashboard e Financeiro (filtro de período).
        </Item>
        <Item>Rascunho de NF-e (guarda de pedido sem itens).</Item>

        <SubTitulo>Correções de maior severidade</SubTitulo>
        <Tabela
          colunas={["Severidade", "Defeito", "Correção"]}
          larguras={[16, 46, 38]}
          linhas={[
            [
              "Crítica",
              "Reprocessamento montava a identificação da baixa com o valor interno da plataforma e nunca encontrava a baixa original: descontava o pedido inteiro de novo no ML e na Magalu",
              "Normalização canônica do rótulo, estritamente aditiva",
            ],
            [
              "Crítica",
              "Reprocessamento lia a referência de idempotência fora da transação: duas execuções simultâneas descontavam duas vezes",
              "Leitura movida para dentro da transação, após os bloqueios",
            ],
            [
              "Alta",
              "Pedido sem itens era reportado como baixado, e a pendência era encerrada sem resolução",
              "Retorno corrigido e guarda própria no reconciliador",
            ],
            [
              "Alta",
              "Pedido vazio no ML e na Magalu bloqueava a reimportação para sempre",
              "Criação restrita à Shopee, onde existe o caminho de completar",
            ],
            [
              "Alta",
              "Busca dirigida relia o catálogo completo da conta",
              "Pré-carga apenas no caminho em lote",
            ],
            [
              "Alta",
              "Marca de progresso avançava sobre período que a API nunca leu",
              "Varredura em blocos e sinalização de truncamento",
            ],
          ]}
        />

        <SubTitulo>Riscos avaliados</SubTitulo>
        <Item>
          Toda funcionalidade nova está atrás de chave de desligamento cujo padrão
          restaura o comportamento anterior. Cinco delas ficam desligadas na
          suíte de testes para que os testes pré-existentes permaneçam idênticos.
        </Item>
        <Item>
          A ordem de bloqueio de registros foi mantida idêntica à do motor de
          estoque e à do cancelamento, para não criar impasse entre transações.
        </Item>
        <Item>
          Duas alterações de banco são puramente aditivas e idempotentes. Os
          índices de expressão não têm dependência de ordem com a publicação.
        </Item>
        <Item>
          Quatro achados de menor severidade foram deliberadamente não corrigidos
          por não atenderem ao critério de segurança comprovada; estão registrados
          no pedido de integração.
        </Item>

        <SubTitulo>Validações executadas</SubTitulo>
        <Tabela
          colunas={["Verificação", "Resultado"]}
          larguras={[46, 54]}
          linhas={[
            ["Verificação de tipos", "100 erros — idêntico ao valor de referência"],
            ["Suíte de testes", "270 arquivos, cerca de 2.615 testes, zero falhas"],
            ["Análise estática", "Nenhum erro"],
            ["Compilação de produção", "Concluída com sucesso"],
            ["Testes pré-existentes alterados", "Nenhum"],
            ["Aumento de consumo de dados", "Nenhum; cinco reduções aplicadas"],
            ["Regra de negócio alterada", "Nenhuma"],
          ]}
        />

        <SubTitulo>Alteração de banco necessária</SubTitulo>
        <P>
          Duas criações de índice, idempotentes e sem dependência de ordem com a
          publicação, descritas no pedido de integração. A coluna de data da venda
          já foi aplicada em produção antes da publicação anterior.
        </P>
      </Pagina>
    </Document>
  );
}

export async function gerarPdf(): Promise<Buffer> {
  registerReportFonts();
  return renderToBuffer(<DocIngestaoPedidos />);
}
