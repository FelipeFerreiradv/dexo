import type { Metadata } from "next";
import Link from "next/link";

/**
 * Termos de Serviço — página PÚBLICA.
 *
 * Por que existe: o campo "URL dos Termos de Serviço" do app da Meta estava
 * apontando para `https://www.facebook.com/` — um placeholder. É o mesmo padrão
 * que gerou a violação do Termo 4.a (URL que não é do próprio serviço), e a
 * Meta exige Termos de Serviço para liberar o modo "Ao vivo", que é o passo
 * seguinte para qualquer lojista conseguir conectar.
 *
 * ⚠️ NÃO PODE EXIGIR SESSÃO, pelo mesmo motivo da política de privacidade: a
 * Meta valida por rastreador anônimo. Server Component sem getServerSession,
 * sem assertPageAccess, fora de PAGE_DEFS.
 */

export const metadata: Metadata = {
  title: "Termos de Serviço",
  description:
    "Condições de uso da plataforma Dexo: objeto, conta, integrações, disponibilidade, dados e rescisão.",
  robots: { index: true, follow: true },
  alternates: { canonical: "/termos" },
  openGraph: {
    type: "website",
    url: "/termos",
    title: "Termos de Serviço | Dexo",
    description:
      "Condições de uso da plataforma Dexo: objeto, conta, integrações, disponibilidade, dados e rescisão.",
  },
};

const EMPRESA = {
  razaoSocial: "DEXO SISTEMAS LTDA",
  cnpj: "68.704.837/0001-55",
  endereco:
    "Rua Leonilda Craveiro, 20 — Parque Cidade Jardim II, Jundiaí/SP, CEP 13.203-544",
  email: "suporte@usedexo.com.br",
  comarca: "Jundiaí, São Paulo",
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

export default function TermosDeServicoPage() {
  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-3xl px-6 py-14 sm:py-20">
        <header className="border-b border-border pb-8">
          <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
            Dexo · Documento público
          </p>
          <h1 className="mt-3 text-4xl leading-tight font-bold text-foreground">
            Termos de Serviço
          </h1>
          <p className="mt-4 text-[15px] leading-relaxed text-muted-foreground">
            Estas condições regem o uso da plataforma Dexo. Ao criar uma conta ou
            usar o sistema, você concorda com elas.
          </p>
          <p className="mt-4 font-mono text-xs text-muted-foreground">
            Última atualização: {ATUALIZADO_EM}
          </p>
        </header>

        <div className="mt-10 space-y-10">
          <Secao id="quem" titulo="1. Quem presta o serviço">
            <p>
              A plataforma Dexo é fornecida por {EMPRESA.razaoSocial}, inscrita
              no CNPJ {EMPRESA.cnpj}, com sede em {EMPRESA.endereco}.
            </p>
          </Secao>

          <Secao id="objeto" titulo="2. O que a Dexo faz">
            <p>
              A Dexo é um sistema de gestão para lojas de autopeças e desmanches.
              Permite cadastrar produtos e estoque, publicar e manter anúncios em
              marketplaces, acompanhar pedidos e vendas, emitir documentos
              fiscais e controlar a operação financeira.
            </p>
            <p>
              O acesso é concedido como licença de uso, não transferível e sem
              exclusividade, pelo período contratado. O software não é vendido.
            </p>
          </Secao>

          <Secao id="conta" titulo="3. Conta, acesso e colaboradores">
            <p>
              A conta é aberta em nome do contratante, que é responsável por
              tudo que for feito com as credenciais dele e dos colaboradores que
              cadastrar. Guarde as senhas em sigilo e avise imediatamente em caso
              de suspeita de uso indevido.
            </p>
            <p>
              O contratante define quais páginas cada colaborador acessa. Ações
              feitas por colaboradores são de responsabilidade do contratante.
            </p>
          </Secao>

          <Secao id="uso" titulo="4. Uso permitido">
            <p>Ao usar a Dexo, você concorda em não:</p>
            <ul className="ml-5 list-disc space-y-2">
              <li>
                Publicar produtos ilícitos, falsificados, de origem irregular ou
                cuja venda dependa de autorização que você não tenha.
              </li>
              <li>
                Usar o sistema para fraude, evasão fiscal ou qualquer finalidade
                ilegal.
              </li>
              <li>
                Tentar acessar dados de outros clientes, burlar limites técnicos
                ou automatizar o uso de forma a prejudicar o serviço.
              </li>
              <li>
                Compartilhar o acesso com terceiros fora da própria operação
                contratada.
              </li>
            </ul>
          </Secao>

          <Secao id="integracoes" titulo="5. Integrações com marketplaces">
            <p>
              A Dexo se conecta a marketplaces e redes de terceiros — entre eles
              Mercado Livre, Shopee, Magalu, OLX e Meta — apenas quando você
              autoriza expressamente cada conexão.
            </p>
            <p>
              Esses canais são independentes da Dexo. As regras, tarifas,
              exigências de plano, políticas de anúncio e decisões de aprovação
              ou recusa são deles. A Dexo não garante a aceitação de um anúncio,
              nem responde por suspensão, bloqueio, mudança de política ou
              indisponibilidade dos canais.
            </p>
            <p>
              Algumas integrações são de mão única: enviam informação da Dexo
              para o canal, mas não trazem pedidos, mensagens ou etiquetas de
              volta. As telas de Integrações indicam o alcance de cada uma.
            </p>
          </Secao>

          <Secao id="fiscal" titulo="6. Documentos fiscais">
            <p>
              A Dexo oferece ferramentas para emissão de documentos fiscais
              eletrônicos, mas a responsabilidade pelo conteúdo declarado — dados
              do produto, tributação, classificação fiscal e cumprimento das
              obrigações acessórias — é do contratante, na condição de emitente.
            </p>
          </Secao>

          <Secao id="dados" titulo="7. Dados">
            <p>
              Os dados que você insere ou importa continuam sendo seus. A Dexo os
              trata para prestar o serviço, conforme a{" "}
              <Link
                href="/privacidade"
                className="text-foreground underline underline-offset-4"
              >
                Política de Privacidade
              </Link>
              .
            </p>
            <p>
              Você é responsável pela veracidade dos dados cadastrados e por ter
              base legal para inserir dados de terceiros, como os de clientes
              finais.
            </p>
          </Secao>

          <Secao id="disponibilidade" titulo="8. Disponibilidade e suporte">
            <p>
              Trabalhamos para manter o serviço disponível, mas ele não é imune a
              interrupções. Podem ocorrer paradas para manutenção, falhas de
              provedores de infraestrutura ou indisponibilidade dos marketplaces
              integrados. Sempre que possível, manutenções programadas são
              comunicadas com antecedência.
            </p>
            <p>
              O suporte é prestado pelos canais indicados na plataforma, em dias
              úteis e horário comercial.
            </p>
          </Secao>

          <Secao id="preco" titulo="9. Preço e pagamento">
            <p>
              Os valores, a periodicidade e as condições de pagamento são os do
              plano contratado, definidos na proposta comercial aceita pelo
              contratante. O atraso no pagamento pode levar à suspensão do
              acesso, mediante comunicação prévia.
            </p>
          </Secao>

          <Secao id="propriedade" titulo="10. Propriedade intelectual">
            <p>
              O software, a marca, a identidade visual e a documentação da Dexo
              pertencem a {EMPRESA.razaoSocial}. O contrato não transfere
              propriedade, apenas concede o direito de uso durante a vigência.
            </p>
          </Secao>

          <Secao id="responsabilidade" titulo="11. Limitação de responsabilidade">
            <p>
              A Dexo responde por danos diretos comprovadamente causados por
              falha do serviço, nos limites da lei. Não responde por lucros
              cessantes, por decisões comerciais do contratante, nem por atos e
              omissões dos marketplaces e demais terceiros integrados.
            </p>
          </Secao>

          <Secao id="rescisao" titulo="12. Vigência e encerramento">
            <p>
              O contrato vigora enquanto durar o plano contratado. Qualquer das
              partes pode encerrá-lo mediante comunicação à outra.
            </p>
            <p>
              Encerrado o acesso, o contratante pode solicitar a exportação dos
              seus dados pelo e-mail{" "}
              <span className="font-mono text-foreground">{EMPRESA.email}</span>.
              A retenção e a eliminação seguem o descrito na Política de
              Privacidade e os prazos exigidos pela legislação fiscal.
            </p>
          </Secao>

          <Secao id="alteracoes" titulo="13. Mudanças nestes termos">
            <p>
              Estes termos podem ser atualizados. A data no topo indica a versão
              vigente, e mudanças relevantes são comunicadas pelos canais da
              plataforma. O uso continuado após a comunicação significa
              concordância.
            </p>
          </Secao>

          <Secao id="foro" titulo="14. Lei aplicável e foro">
            <p>
              Estes termos são regidos pela lei brasileira. Fica eleito o foro da
              comarca de {EMPRESA.comarca}, com renúncia a qualquer outro, por
              mais privilegiado que seja.
            </p>
          </Secao>

          <Secao id="contato" titulo="15. Contato">
            <p>
              Dúvidas sobre estes termos:{" "}
              <span className="font-mono text-foreground">{EMPRESA.email}</span>
            </p>
          </Secao>
        </div>

        <footer className="mt-14 flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-6">
          <Link
            href="/privacidade"
            className="font-mono text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            Política de Privacidade
          </Link>
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
