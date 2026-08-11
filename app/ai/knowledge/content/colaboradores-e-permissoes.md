# Colaboradores e permissões

A loja tem um **administrador** (a conta principal) e pode ter vários **colaboradores** — funcionários com login próprio.

Colaboradores trabalham **dentro dos dados do administrador**: o catálogo, os pedidos, o financeiro e as sucatas são os mesmos. O que muda é o que cada um enxerga e o que cada um pode fazer.

## Cadastrar um colaborador

Na tela de Colaboradores, o formulário pede **Nome**, **E-mail** e **senha** (com confirmação). O e-mail é o login.

O e-mail é gravado como foi digitado, preservando maiúsculas e minúsculas — vale conferir na hora de cadastrar.

## Permissão por página

Cada colaborador tem um interruptor por página do sistema:

Dashboard · Produtos · Sucatas · Localizações · Receber por scan · Pedidos · Clientes · Financeiro · PDV Balcão · Mensagens · Mercado Livre · Shopee · Magalu · Logs · Notas fiscais

A regra é simples: **tudo liberado por padrão**, e o administrador desliga o que não deve. Colaborador novo enxerga tudo até alguém restringir.

Desligar uma página some com ela do menu **e** bloqueia o acesso direto pelo endereço — não é só esconder. Quem tenta entrar é levado para a primeira página liberada; quem não tem nenhuma vai para uma tela de sem acesso.

O administrador e a equipe Dexo têm acesso total sempre — não há como se trancar fora do sistema.

## Permissão por ação

Além da página, há permissão por **ação** específica. Hoje existe uma:

- **Cancelar / estornar venda** — "Devolve o estoque, reabre os anúncios e cancela a venda no balcão."

Serve para o caso comum de deixar o balconista **vender** mas não **estornar**. Como nas páginas, o padrão é permitir; o administrador desliga para quem não deve ter.

## O que é exclusivo do administrador

- **Conectar e desconectar contas de marketplace.** Colaboradores usam as contas já conectadas, mas não veem os botões de conexão. Quem precisa de conta nova pede ao administrador.
- **Cadastrar e editar colaboradores** e as permissões deles.

## Bloquear um colaborador

Um usuário pode ser **desativado** — por falta de pagamento, desligamento, o que for. Desativar **não apaga nada**: é reversível, e todo o histórico (quem cadastrou o quê, quem vendeu o quê) continua íntegro.

## Quem fez o quê

O sistema registra o **autor real** de cada cadastro de produto e de cada anúncio criado — o colaborador que agiu, não a loja. Registros antigos ou criados por importação e detecção automática aparecem como "—".

Há também um relatório de **produtividade da equipe** e, nos orçamentos, um campo de **vendedor**, que é a base para comissão.

## A tela de Logs

**Logs** registra as ações do sistema. É a página para investigar "quem mudou isso" e "por que essa venda não entrou".

Como qualquer outra página, ela pode ser desligada por colaborador — e normalmente é.

## Erros comuns

- **Colaborador não vê uma página** — a permissão daquela página está desligada, **ou** o módulo inteiro está desabilitado para a loja (PDV, Magalu e Notas fiscais dependem de habilitação).
- **"Solicite ao administrador da conta para conectar"** — conectar marketplace é exclusivo do administrador.
- **Colaborador não consegue estornar** — a permissão de ação "Cancelar / estornar venda" está desligada para ele.
- **Colaborador não consegue entrar** — a conta pode estar desativada.
- **Colaborador vê os dados de outro colaborador** — é o esperado: eles compartilham os dados da loja. O que é individual é o histórico de conversa com o Bitz.

## Limitações conhecidas

- Não há perfis prontos de permissão ("vendedor", "estoquista"): a configuração é interruptor por interruptor, por pessoa.
- Só existe uma permissão por ação hoje (estorno de venda).
- Não há hierarquia de colaboradores: todos são filhos diretos do administrador.

## Troca de senha

São **dois caminhos diferentes**, e confundi-los é a causa mais comum de "não acho onde troca a senha":

- **Você trocando a SUA própria senha** (dono ou colaborador): avatar no topo → **Configurações** → aba **Conta** → seção Segurança. Não pede a senha atual.
- **O dono trocando a senha de UM COLABORADOR**: página **Colaboradores**, editando a pessoa, campo _"Nova senha (opcional)"_ — em branco mantém a atual.

**Colaborador não entra na página Colaboradores** — é redirecionado. Se tentar uma ação de equipe pela API, recebe: _"Colaboradores não podem realizar esta ação. Solicite ao administrador da conta."_

**O dono também não se edita por Colaboradores.** Se tentar, o sistema responde _"Use as configurações da sua conta para editar você mesmo."_ A senha do dono só muda pelo avatar → Configurações.

Detalhe de tela: tanto o _"As senhas não coincidem."_ quanto o _"Conta atualizada com sucesso!"_ são **janelinhas do navegador**, não avisos na página. E o botão "Salvar alterações" da aba Conta grava nome, foto e senha juntos.

> ⚠️ **O mínimo de 8 caracteres só vale quando o DONO define a senha em Colaboradores.** Pela tela de Configurações não há regra nenhuma: o texto "Use pelo menos 8 caracteres" é só recado, e o sistema aceita senha de **1 caractere**. Ou seja, o colaborador pode enfraquecer sozinho a senha que o dono definiu — e o histórico registra só "Configurações atualizadas", sem dizer que foi a senha.

**Esqueceu a senha? Não existe recuperação.** Não há "esqueci minha senha", não há e-mail de redefinição, e **nem a equipe Dexo tem tela para redefinir senha de terceiro** — a edição de usuário do Superadmin não tem campo de senha.

- **Colaborador esqueceu:** o dono redefine em Colaboradores. Resolve na hora.
- **Dono esqueceu:** não há caminho no sistema. Só suporte com acesso ao banco.
