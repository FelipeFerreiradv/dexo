# Anúncios no Mercado Livre

O Dexo publica peças do catálogo como anúncios no Mercado Livre e mantém preço, estoque e ficha técnica em sincronia. A tela fica em **Marketplaces → Mercado Livre**, com três abas: **Conexão**, **Anúncios** e **Sincronização**.

Uma peça pode estar anunciada em **várias contas do Mercado Livre ao mesmo tempo**. Cada anúncio é um registro próprio, com status e erro próprios, mas todos apontam para o mesmo produto — e por isso compartilham o estoque.

## Conectar uma conta

Na aba **Conexão**, botão **Conectar ao Mercado Livre**. A autorização acontece no site do próprio Mercado Livre; ao voltar, a conta aparece na lista.

Para conectar uma segunda conta, use **Adicionar nova conta**. Antes disso, saia da conta atual no navegador (ou use uma janela anônima), senão o Mercado Livre reautoriza a mesma conta que já está logada.

**Só o administrador conecta e desconecta contas.** Colaboradores usam as contas já conectadas, mas não veem os botões de conexão — quem precisar de uma conta nova pede ao administrador.

## Publicar um anúncio

Há dois caminhos:

**Um a um** — no cadastro ou na edição do produto, o passo **Mercado Livre** pede a categoria, em quais contas publicar e a ficha técnica. O passo **Prévia** mostra como o anúncio vai ficar antes de sair.

**Em massa** — na lista de Produtos, selecione as peças e use o assistente de anúncio em massa, em 4 etapas:

1. **Marketplaces** — em quais contas publicar.
2. **Regras** — preço e estoque a aplicar no lote.
3. **Revisão** — conferir antes de disparar.
4. **Progresso** — acompanhar a criação em tempo real.

O assistente também tem o modo **Revisão individual**: a etapa 2 vira "Defaults globais" (pré-preenche todo mundo) e a etapa 3 permite ajustar produto a produto antes de publicar.

## Categoria do anúncio

O sistema sugere a categoria do Mercado Livre a partir do nome e dos dados da peça, e mostra o caminho completo da categoria para conferência. A sugestão é editável — há um campo de busca de categoria.

A categoria escolhida determina **quais campos da ficha técnica o Mercado Livre exige**. Trocar a categoria muda a lista de campos obrigatórios.

## Ficha técnica e conferência antes de publicar

Antes de enviar, o sistema confere o anúncio e aponta o que falta ou o que o Mercado Livre vai recusar, separando em **bloqueio** (não dá para publicar assim) e **aviso** (publica, mas é melhor arrumar).

Parte da ficha técnica é preenchida sozinha a partir dos campos do produto — marca, modelo, ano, part number, medidas.

## Compatibilidade veicular

A aba de **Compatibilidade** do produto lista em quais veículos a peça serve. Essas compatibilidades são enviadas ao Mercado Livre junto com o anúncio.

O Mercado Livre responde "sucesso" mesmo quando ignora parte dos veículos enviados. Por isso o Dexo relê o anúncio depois de publicar e mostra na aplicação **o que ficou gravado de fato** — em vez de o vendedor descobrir semanas depois no painel do Mercado Livre.

A **posição** da peça (Dianteira, Traseira, Esquerda, Direita) é uma configuração do produto, não de cada veículo: vale para todos os veículos compatíveis de uma vez.

## Preço diferente por conta

Anunciar a mesma peça, com o mesmo preço, em duas contas suas pode ser penalizado pelo Mercado Livre. Em **Configurações → Preços entre contas** há um **aumento percentual escalonado**: a primeira conta sai com o preço do produto, a segunda com o acréscimo, e assim por diante. `0` desativa.

Além disso, cada anúncio aceita um **preço próprio** que sobrescreve o do produto só naquele anúncio. Título, descrição, categoria, fotos e medidas também aceitam valor próprio por anúncio.

**Estoque não tem valor por anúncio, de propósito.** A peça física é uma só: se cada anúncio tivesse o seu, dois compradores comprariam a mesma peça.

## Status do anúncio

O que aparece na coluna de status:

| Status     | Significa                                                     |
| ---------- | ------------------------------------------------------------- |
| Ativo      | à venda                                                       |
| Pausado    | não aparece para compra                                       |
| Pendente   | o Mercado Livre ainda está processando                        |
| Em revisão | o Mercado Livre está analisando o anúncio                     |
| Fechado    | encerrado                                                     |
| Excluído   | removido                                                      |
| Inativo    | fora do ar                                                    |
| Banido     | derrubado pelo Mercado Livre                                  |
| Erro       | a última tentativa de envio falhou — o motivo fica no anúncio |

O status é espelhado do Mercado Livre, não decidido pelo Dexo.

**Por que um anúncio pausa sozinho:** quando o estoque da peça chega a zero por uma venda no balcão, o Dexo pausa os anúncios daquela peça. É proteção contra vender no marketplace o que já saiu pela porta.

## Anúncios que já existiam antes do Dexo

O sistema detecta os anúncios que a conta já tinha e cria o produto correspondente no catálogo automaticamente. Peças criadas assim mantêm o SKU que o vendedor usava no Mercado Livre e não interferem na numeração sequencial do Dexo.

## Erros comuns

- **Anúncio com status "Erro"** — o motivo devolvido pelo Mercado Livre fica registrado no próprio anúncio. Os mais frequentes são campo obrigatório da ficha técnica em branco e categoria incompatível com o produto.
- **Falta uma foto** — o Mercado Livre exige imagem; produto sem foto não publica.
- **Compatibilidade enviada mas não gravada** — o Mercado Livre aceitou o anúncio e descartou os veículos, normalmente porque a categoria não aceita compatibilidade veicular. O diagnóstico do anúncio mostra isso.
- **Segunda conta não conecta** — o navegador ainda está logado na primeira. Sair da conta ou usar janela anônima.
- **"Solicite ao administrador da conta para conectar"** — o usuário é colaborador; conectar conta é exclusivo do administrador.

## Limitações conhecidas

- Não existe rascunho de anúncio: ou publica, ou não existe.
- O estoque é sempre o do produto, compartilhado entre todos os anúncios da peça.
- Métricas do anúncio (visitas, avaliações) são atualizadas por sincronização periódica, não em tempo real.

## Visitas e avaliações: de quanto em quanto tempo

**Antes do intervalo, o que mais importa: esses números não aparecem em tela nenhuma do Dexo.** O sistema busca as visitas e as avaliações no Mercado Livre e guarda no banco, mas não existe lugar no sistema que mostre "este anúncio teve X visitas" ou "tem nota Y". A única pista é o aviso **"Métricas atualizadas"** no sininho — sem número junto.

Quem perguntar "por que minhas visitas não atualizam?" está procurando uma tela que não existe. Diga isso.

O ritmo é de **6 em 6 horas** (padrão de fábrica), e na prática costuma ser mais:

- A mesma rodada faz a varredura de catálogo da Shopee e do Magalu de **todas as contas da plataforma**, em série — as métricas são a **última** coisa da fila.
- Há uma pausa proposital de ~0,34 s por anúncio para não tomar bloqueio do ML. Numa loja com 10 mil anúncios, só de pausa é quase 1 hora.
- Se a rodada inteira passar de 6 horas, a próxima começa 5 segundos depois — o sistema fica rodando direto.
- **As visitas são o total do anúncio desde que ele nasceu**, não as do mês ou da semana.

**Nunca recebem visita nem avaliação:** anúncio que falhou na publicação (os pendentes) e anúncio de catálogo migrado (`LEGACY-`). Loja que veio de migração nunca teve esses números buscados.

**Se o token do Mercado Livre estiver vencido**, a busca falha calada: nada é gravado, nada aparece em log do cliente, e o número congela no último valor.

> ⚠️ Três números parecem ser a resposta e não são: o loop de 30 minutos existe no código mas **não roda em produção**; a varredura de 1 em 1 hora só espelha ativo/pausado/encerrado e **não toca em métrica**; e o ciclo antigo de "15 minutos" já registrou uma volta de **71,9 horas** em produção.

## Publicação em massa: não existe controle de ritmo

**Não há trava anti-spam por tempo.** Nem espera entre anúncios, nem pausa a cada 100, nem a cada 1.000. Não há variável de ambiente, campo no banco ou botão de tela para ligar isso.

O que existe:

- **Teto de 2.000 anúncios por trabalho** (produtos × contas). Passando disso: _"Limite excedido — Operação muito grande"_. É teto por trabalho, não por hora: nada impede disparar outro em seguida.
- **Fila de 4 em paralelo.** Quando um termina, o próximo entra na hora. O Dexo dispara na velocidade que o Mercado Livre aguentar.

> ⚠️ **Nada no servidor impede DOIS trabalhos em massa ao mesmo tempo.** A única trava é no navegador, contra duplo-clique na mesma janela. Duas abas, dois colaboradores, ou clicar "reprocessar falhas" com um lote ainda rodando dobra os disparos simultâneos na mesma conta — e o reprocessar falhas nem passa pelo teto de 2.000.

Duas coisas parecem ser controle de ritmo e não são:

- O **semáforo por conta** existe e cita o limite de ~10 req/s do ML — mas só é usado na **exclusão** em massa. O motor de publicação não o usa.
- A **repescagem** de anúncios que falharam tem espera (30 s, 60, 120, 300, 900, no máximo 5 tentativas). Vale só para quem já deu erro; não segura a primeira publicação.

Se alguém perguntar quantos anúncios por minuto: **não há número confiável.** Cada anúncio custa de 13 a 23 chamadas ao Mercado Livre, e o pior caso de um anúncio sozinho é 1 a 2 minutos.
