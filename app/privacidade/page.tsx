import type { Metadata } from "next";
import Link from "next/link";

/**
 * Política de Privacidade — página PÚBLICA.
 *
 * Por que existe: em 02/09/2026 a Meta abriu uma violação do Termo da
 * Plataforma 4.a contra o app `Dexo System` (id 2287465945400727, o mesmo do
 * FACEBOOK_APP_ID de produção) por "app ou site sem política de privacidade
 * acessível ao público", e RESTRINGIU o acesso à API. Enquanto a violação
 * estiver aberta a integração do Facebook não volta.
 *
 * ⚠️ ESTA PÁGINA NÃO PODE EXIGIR SESSÃO. A Meta valida por rastreador anônimo:
 * "URL ativo, público, facilmente acessível (inclusive por nossos rastreadores)
 * e não bloqueado geograficamente". Por isso ela é um Server Component sem
 * `getServerSession`, sem `assertPageAccess` e fora de PAGE_DEFS — qualquer
 * gate de autenticação aqui reabre a violação.
 *
 * ⚠️ Também precisa continuar indexável: `app/robots.ts` libera `/` e só
 * bloqueia /api, /config e /logs. Não adicionar /privacidade ao disallow.
 */

export const metadata: Metadata = {
  title: "Política de Privacidade",
  description:
    "Como a Dexo coleta, usa, compartilha e protege os dados pessoais tratados na plataforma.",
  robots: { index: true, follow: true },
  // Sem isto o Open Graph é herdado do layout raiz e o Depurador da Meta mostra
  // "Dexo | Gestão de Estoque Centralizada" como prévia desta página — quem
  // analisa a violação vê o título da home no lugar do da política. O `url`
  // também elimina o aviso "og:url ausente".
  alternates: { canonical: "/privacidade" },
  openGraph: {
    type: "website",
    url: "/privacidade",
    title: "Política de Privacidade | Dexo",
    description:
      "Como a Dexo coleta, usa, compartilha e protege os dados pessoais tratados na plataforma.",
  },
};

/**
 * Dados cadastrais do controlador (Cartão CNPJ, situação ATIVA em 20/08/2026).
 * A Meta recusa política genérica, sem identificação do responsável e sem canal
 * de contato real — por isso estes campos são parte do cumprimento, não enfeite.
 */
const EMPRESA = {
  razaoSocial: "DEXO SISTEMAS LTDA",
  cnpj: "68.704.837/0001-55",
  endereco:
    "Rua Leonilda Craveiro, 20 — Parque Cidade Jardim II, Jundiaí/SP, CEP 13.203-544",
  email: "suporte@usedexo.com.br",
} as const;

const ATUALIZADO_EM = "10 de setembro de 2026";

function Secao({
  id,
  titulo,
  children,
}: {
  id: string;
  titulo: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className="mb-3 text-xl font-semibold text-foreground">{titulo}</h2>
      <div className="space-y-3 text-[15px] leading-relaxed text-muted-foreground">
        {children}
      </div>
    </section>
  );
}

export default function PoliticaDePrivacidadePage() {
  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-3xl px-6 py-14 sm:py-20">
        <header className="border-b border-border pb-8">
          <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
            Dexo · Documento público
          </p>
          <h1 className="mt-3 text-4xl leading-tight font-bold text-foreground">
            Política de Privacidade
          </h1>
          <p className="mt-4 text-[15px] leading-relaxed text-muted-foreground">
            Esta política explica quais dados pessoais a Dexo trata, para quê,
            com quem compartilha e como você exerce seus direitos. Ela vale para
            a plataforma web da Dexo e para as integrações com marketplaces.
          </p>
          <p className="mt-4 font-mono text-xs text-muted-foreground">
            Última atualização: {ATUALIZADO_EM}
          </p>
        </header>

        <div className="mt-10 space-y-10">
          <Secao id="controlador" titulo="1. Quem trata os seus dados">
            <p>
              A plataforma Dexo é operada por {EMPRESA.razaoSocial}, inscrita no
              CNPJ {EMPRESA.cnpj}, com sede em {EMPRESA.endereco}.
            </p>
            <p>
              A Dexo atua de duas formas distintas, e a diferença importa para
              os seus direitos:
            </p>
            <ul className="ml-5 list-disc space-y-2">
              <li>
                <strong className="text-foreground">
                  Como controladora
                </strong>{" "}
                dos dados de cadastro e uso da própria plataforma — os dados de
                quem contrata e opera o sistema.
              </li>
              <li>
                <strong className="text-foreground">Como operadora</strong> dos
                dados que o lojista insere ou importa para gerir o negócio dele,
                como os dados dos clientes finais dele. Nesses casos o lojista é
                o controlador, e a Dexo trata os dados apenas para prestar o
                serviço contratado.
              </li>
            </ul>
          </Secao>

          <Secao id="dados" titulo="2. Quais dados tratamos">
            <p>
              <strong className="text-foreground">Cadastro e acesso.</strong>{" "}
              Nome, e-mail, senha (armazenada com hash, nunca em texto puro),
              telefone e o perfil de permissões de cada usuário e colaborador.
            </p>
            <p>
              <strong className="text-foreground">
                Registros de uso e segurança.
              </strong>{" "}
              Endereço IP, identificação do navegador, data, hora e a ação
              realizada. Esses registros existem para auditoria e segurança —
              permitem reconstruir o que foi feito na conta e por quem.
            </p>
            <p>
              <strong className="text-foreground">Dados do negócio.</strong>{" "}
              Produtos, fotos, preços, estoque, localizações, sucatas, pedidos,
              vendas e informações financeiras lançadas na plataforma.
            </p>
            <p>
              <strong className="text-foreground">Dados fiscais.</strong> CNPJ,
              inscrição estadual, certificado digital e demais informações
              necessárias para emitir documentos fiscais eletrônicos.
            </p>
            <p>
              <strong className="text-foreground">
                Dados de clientes finais do lojista.
              </strong>{" "}
              Nome, CPF ou CNPJ, endereço, telefone e e-mail — recebidos dos
              marketplaces junto com o pedido, ou cadastrados pelo próprio
              lojista, e usados para processar a venda, emitir a nota fiscal e
              gerar a etiqueta de envio.
            </p>
            <p>
              <strong className="text-foreground">
                Credenciais de integração.
              </strong>{" "}
              Chaves de acesso fornecidas pelos marketplaces quando o lojista
              autoriza a conexão. Elas ficam associadas à conta do lojista e são
              usadas exclusivamente para as operações descritas abaixo.
            </p>
            <p>
              <strong className="text-foreground">
                Mensagens de marketplaces.
              </strong>{" "}
              Perguntas e conversas de compradores, quando o canal oferece esse
              recurso, para que o lojista responda pela própria plataforma.
            </p>
          </Secao>

          <Secao id="finalidades" titulo="3. Para que usamos">
            <ul className="ml-5 list-disc space-y-2">
              <li>Prestar o serviço contratado e manter a conta funcionando.</li>
              <li>
                Sincronizar catálogo, preço e estoque com os marketplaces
                autorizados pelo lojista.
              </li>
              <li>Importar e processar pedidos e vendas.</li>
              <li>Emitir documentos fiscais e etiquetas de envio.</li>
              <li>
                Garantir segurança, prevenir fraude e permitir auditoria das
                ações feitas na conta.
              </li>
              <li>Prestar suporte técnico quando solicitado.</li>
              <li>Cumprir obrigações legais, fiscais e regulatórias.</li>
            </ul>
            <p>
              <strong className="text-foreground">
                Não vendemos dados pessoais
              </strong>{" "}
              e não os usamos para publicidade de terceiros.
            </p>
          </Secao>

          <Secao id="integracoes" titulo="4. Integrações com marketplaces">
            <p>
              A conexão com cada canal só acontece quando o lojista autoriza
              expressamente, e pode ser revogada a qualquer momento na tela de
              Integrações da plataforma ou no painel do próprio canal.
            </p>
            <p>
              <strong className="text-foreground">
                Meta (Facebook e Instagram).
              </strong>{" "}
              Quando o lojista conecta a conta, solicitamos a permissão{" "}
              <code className="rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[13px] text-foreground">
                catalog_management
              </code>
              . Usamos essa permissão apenas para criar, atualizar e remover
              itens no catálogo de comércio indicado pelo próprio lojista,
              refletindo o cadastro de produtos e o estoque mantidos na Dexo.
              Não acessamos mensagens privadas, lista de amigos, publicações ou
              dados do perfil pessoal além do identificador e do nome da conta
              necessários para vincular a integração. Não usamos dados da Meta
              para publicidade, não os transferimos a terceiros e não os
              cruzamos com dados de outras fontes.
            </p>
            <p>
              <strong className="text-foreground">
                Mercado Livre, Shopee, Magalu e OLX.
              </strong>{" "}
              Usamos as credenciais autorizadas para publicar e atualizar
              anúncios, sincronizar estoque e preço, importar pedidos e, quando
              o canal permite, ler e responder mensagens de compradores.
            </p>
          </Secao>

          <Secao id="compartilhamento" titulo="5. Com quem compartilhamos">
            <ul className="ml-5 list-disc space-y-2">
              <li>
                <strong className="text-foreground">Marketplaces</strong>{" "}
                autorizados pelo lojista, no limite necessário para publicar
                anúncios e processar pedidos.
              </li>
              <li>
                <strong className="text-foreground">
                  Órgãos públicos
                </strong>{" "}
                — em especial a Secretaria da Fazenda, para emissão de
                documentos fiscais eletrônicos.
              </li>
              <li>
                <strong className="text-foreground">
                  Prestadores de infraestrutura
                </strong>{" "}
                de hospedagem e banco de dados, que tratam os dados apenas sob
                nossas instruções.
              </li>
              <li>
                <strong className="text-foreground">
                  Autoridades competentes
                </strong>
                , quando houver obrigação legal ou ordem judicial.
              </li>
            </ul>
          </Secao>

          <Secao id="armazenamento" titulo="6. Onde ficam e por quanto tempo">
            <p>
              Os dados são armazenados em servidores localizados no Brasil.
              Mantemos as informações enquanto a conta estiver ativa e pelos
              prazos exigidos pela legislação fiscal e civil depois do
              encerramento. Registros de acesso são mantidos pelo prazo legal
              aplicável.
            </p>
          </Secao>

          <Secao id="seguranca" titulo="7. Segurança">
            <p>
              Adotamos medidas técnicas e administrativas para proteger os
              dados, entre elas tráfego criptografado, senhas armazenadas com
              hash, controle de acesso por perfil de permissão e registro
              auditável das ações realizadas na conta. Nenhum sistema é
              totalmente imune a incidentes; em caso de incidente relevante,
              comunicaremos os titulares e a autoridade nacional conforme a lei.
            </p>
          </Secao>

          <Secao id="direitos" titulo="8. Seus direitos">
            <p>
              Conforme a Lei Geral de Proteção de Dados (Lei 13.709/2018), você
              pode solicitar a confirmação da existência de tratamento, o acesso
              aos seus dados, a correção de dados incompletos ou desatualizados,
              a anonimização ou eliminação de dados desnecessários, a
              portabilidade, a informação sobre compartilhamentos e a revogação
              do consentimento.
            </p>
            <p>
              Para exercer qualquer desses direitos, escreva para{" "}
              <span className="font-mono text-foreground">{EMPRESA.email}</span>
              . Respondemos em até 15 dias.
            </p>
            <p>
              Se os dados foram inseridos por um lojista que usa a plataforma, a
              solicitação pode precisar ser encaminhada a ele, que é o
              controlador nesse caso. Nesse cenário faremos o encaminhamento e
              avisaremos você.
            </p>
          </Secao>

          <Secao id="exclusao" titulo="9. Exclusão de dados e desconexão">
            <p>
              Para desconectar uma integração, acesse Integrações na plataforma
              e use a opção de desconectar a conta do canal desejado. A
              desconexão interrompe imediatamente o acesso da Dexo àquele canal.
            </p>
            <p>
              Para solicitar a exclusão dos seus dados, escreva para{" "}
              <span className="font-mono text-foreground">{EMPRESA.email}</span>{" "}
              com o assunto <em>Exclusão de dados</em>, informando o e-mail
              cadastrado. Concluímos a exclusão em até 30 dias, ressalvados os
              dados que a legislação fiscal obriga a manter.
            </p>
          </Secao>

          <Secao id="cookies" titulo="10. Cookies">
            <p>
              Usamos cookies estritamente necessários para manter a sessão do
              usuário autenticado e preferências de exibição. Não utilizamos
              cookies de publicidade nem de rastreamento de terceiros.
            </p>
          </Secao>

          <Secao id="alteracoes" titulo="11. Mudanças nesta política">
            <p>
              Podemos atualizar esta política. A data de última atualização no
              topo sempre indica a versão vigente; mudanças relevantes serão
              comunicadas pelos canais de contato da plataforma.
            </p>
          </Secao>

          <Secao id="contato" titulo="12. Contato">
            <p>
              Dúvidas sobre esta política ou sobre o tratamento dos seus dados:{" "}
              <span className="font-mono text-foreground">{EMPRESA.email}</span>
            </p>
          </Secao>
        </div>

        <footer className="mt-14 border-t border-border pt-6">
          <Link
            href="/"
            className="font-mono text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            Voltar para a Dexo
          </Link>
        </footer>
      </div>
    </main>
  );
}
