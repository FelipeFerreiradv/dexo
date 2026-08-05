# Relatório de auditoria — Performance, egress e segurança (05/08/2026)

Auditoria das funcionalidades entregues nos PRs **#235, #236, #237 e #238**, já em
produção. Documento destinado à equipe de **Suporte**.

---

## 1. Resumo executivo

Revisamos os 18 arquivos de aplicação alterados por essas entregas procurando
desperdício de processamento, consultas desnecessárias ao banco e aumento de
tráfego externo (egress).

**O resultado é bom: as entregas já estavam dentro das regras de economia que o
sistema adota.** Encontramos **11 pontos de atenção**; apenas **1** justificava
mexer no código. Os outros 10 estão descritos aqui com o motivo de terem sido
deixados como estão — em quase todos, mexer traria mais risco do que benefício.

| Item                                       | Resultado                             |
| ------------------------------------------ | ------------------------------------- |
| Alterações de código feitas                | **1** (mais 1 correção de comentário) |
| Pontos documentados sem alterar            | **10**                                |
| Aumento de tráfego externo                 | **Nenhum**                            |
| Requisições a mais por cadastro            | **Nenhuma**                           |
| Funcionalidades com comportamento alterado | **Nenhuma**                           |
| Testes automatizados                       | **4.167 passando, 0 falhando**        |

**Para o cliente, nada muda.** Nenhuma tela, nenhum botão, nenhum resultado é
diferente depois desta entrega.

---

## 2. Objetivo das otimizações

O sistema tem um conjunto de regras internas, criadas em entregas anteriores de
segurança e otimização, para manter baixo o consumo de banda e de banco de dados.
O objetivo desta auditoria foi confirmar que as funcionalidades novas continuam
respeitando essas regras, e corrigir apenas o que representasse ganho real.

O critério usado foi rigoroso: **só alteramos código quando o ganho é mensurável
e quando é possível demonstrar que o resultado continua exatamente o mesmo.**
Diante de qualquer dúvida, a escolha foi não mexer.

---

## 3. Funcionalidades analisadas

- Sugestão automática de categoria (Mercado Livre e Shopee)
- Modal de cadastro de novo produto
- Rascunho automático do cadastro
- Histórico de cadastros recentes ("Usar último")
- Lista de produtos e o seletor de ordenação
- Geração de etiquetas em lote
- Rotas de produto e de marketplace

Também confirmamos que **nada** foi tocado em: pedidos, sincronização,
baixa de estoque, anúncios, webhooks, rotinas agendadas, autenticação,
permissões e estrutura do banco. Zero arquivos dessas áreas aparecem nas
alterações.

---

## 4. Alterações realizadas

### 4.1 Chave do cache da sugestão de categoria (única alteração funcional)

A sugestão de categoria guarda os resultados em memória por 1 hora para não
refazer o mesmo cálculo. Cada resultado guardado tem uma "etiqueta" que o
identifica.

Essa etiqueta estava sendo montada com **9 informações do produto**, mas o
cálculo da sugestão usa apenas **4**: marca, modelo, ano e part number. As
outras 5 (descrição, versão, categoria interna, veículo de origem e qualidade)
entravam na etiqueta sem influenciar o resultado.

Passamos a montar a etiqueta apenas com as 4 que importam.

### 4.2 Correção de comentário (sem efeito prático)

Um limite de tamanho no histórico de cadastros era descrito como sendo em bytes,
quando na verdade conta caracteres. O comportamento continua idêntico; apenas o
comentário no código foi corrigido para não induzir a erro no futuro.

---

## 5. Justificativa técnica

**Por que a etiqueta do cache importava.** Quando duas situações que produzem a
mesma resposta recebem etiquetas diferentes, o sistema não reconhece que já
calculou aquilo e **refaz o trabalho inteiro**. Cada recálculo custa, medido em
produção durante a entrega original, **168 ms (mediana) a 263 ms (pico)** de
processamento do servidor, e o modal dispara dois — Mercado Livre e Shopee.

Duas das 5 informações removidas mudam com muita frequência:

- **veículo de origem** muda a cada sucata;
- **qualidade** muda a cada peça.

Ou seja: cadastrar a mesma peça vinda de sucatas diferentes forçava o sistema a
refazer todo o cálculo para chegar exatamente no mesmo resultado.

Havia ainda um efeito colateral: a memória de resultados guarda no máximo 2.000
itens. Ao encher com variações desnecessárias, ela descartava resultados úteis de
outros produtos, prejudicando também quem não tinha relação com aquele cadastro.

### Limite honesto do ganho

Este ponto foi contestado durante a própria auditoria, e a contestação procede:
**marca, modelo e ano continuam na etiqueta** (eles realmente influenciam o
resultado). Como o sistema preenche esses três a partir do próprio nome do
produto, o cadastro pelo modal continua tendo etiqueta própria e **não** passa a
reaproveitar o cálculo de outras telas.

O ganho real, portanto, é mais estreito do que "menos recálculos em geral": é a
eliminação das variações causadas pelos 5 campos inertes — o que na prática
concentra o benefício no fluxo de sucata (mesma peça, sucatas diferentes) e nas
variações de qualidade e descrição.

**Não temos medição de taxa de acerto em produção.** O custo por recálculo é
medido; a frequência com que ele era evitável não é. O ganho é real e a direção
é certa, mas não seria correto anunciar um percentual.

**Por que é seguro.** Verificamos, lendo o arquivo inteiro do serviço, que
aquelas 5 informações não são consultadas em nenhum ponto do cálculo. Além
disso, criamos testes que provam isso nos dois sentidos, incluindo uma
comparação direta de duas chamadas que diferem apenas nesses campos: o resultado
é idêntico.

**O risco assumido, e como foi eliminado.** A etiqueta antiga era segura por
construção: qualquer informação nova entrava nela automaticamente. Com a lista
reduzida, se alguém no futuro passar a usar uma das 5 informações no cálculo sem
acrescentá-la à etiqueta, o sistema passaria a devolver resposta errada em
silêncio, por até 1 hora. Para fechar essa porta, criamos um teste que varre o
serviço e falha se surgir qualquer leitura de informação que não esteja na
etiqueta — com mensagem dizendo exatamente o que corrigir. Validado por
simulação: introduzimos a falha de propósito e o teste acusou.

---

## 6. Ganhos esperados

- **Menos processamento no servidor.** Cada recálculo evitado economiza de 168 ms
  a 263 ms de CPU, e o modal dispara dois por vez.
- **Melhor aproveitamento da memória de resultados**, que deixa de ser poluída
  por variações que não mudam nada — beneficiando todos os clientes atendidos
  pelo mesmo servidor.
- **Etiquetas menores**: a descrição do produto chegava a ocupar 120 caracteres
  na etiqueta e saiu por completo.

O ganho aparece em **uso de CPU do servidor**, não em tempo de tela para o
cliente. A sugestão de categoria já era rápida; ela apenas passa a custar menos
para o sistema. Ver o limite honesto do ganho na seção 5.

---

## 7. Impacto sobre recursos e egress

**Não há aumento de tráfego externo — nem antes, nem depois.**

Confirmamos que as entregas anteriores **não aumentaram** o número de requisições:
a busca de sugestão continua sendo disparada apenas quando o **nome do produto**
muda, exatamente como antes. As informações extras enviadas hoje (marca, modelo,
ano) pegam carona numa requisição que já aconteceria.

A alteração desta auditoria **não cria nenhuma requisição nova**, e não reduz
consultas ao banco — a lista de categorias já era mantida em memória. O ganho é
exclusivamente de processamento.

---

## 8. Confirmação de ausência de regressões

| Verificação              | Antes          | Depois                         |
| ------------------------ | -------------- | ------------------------------ |
| Erros de tipagem         | 100            | **100** (idêntico)             |
| Análise de código (lint) | 0 erros        | **0 erros**                    |
| Formatação               | limpa          | **limpa**                      |
| Compilação               | verde          | **verde**                      |
| Testes automatizados     | 4.162 passando | **4.167 passando, 0 falhando** |

Os 5 testes a mais são os criados nesta auditoria. Nenhum teste existente
mudou de resultado.

A proteção nova foi validada por **teste de mutação**: reintroduzimos
propositalmente o problema e confirmamos que o teste falha; ao desfazer, volta a
passar. Sem isso, um teste pode dar falsa sensação de segurança.

---

## 9. Funcionalidades críticas validadas

Nenhum arquivo das áreas críticas foi tocado por estas entregas nem por esta
auditoria — verificado arquivo por arquivo:

| Área                                 | Arquivos alterados |
| ------------------------------------ | ------------------ |
| Pedidos e importação automática      | 0                  |
| Baixa e atualização de estoque       | 0                  |
| Sincronização de produtos e anúncios | 0                  |
| Webhooks                             | 0                  |
| Rotinas agendadas e filas            | 0                  |
| Autenticação e permissões            | 0                  |
| Estrutura do banco de dados          | 0                  |

Cadastro, edição e exclusão de produtos continuam cobertos pelos testes
automatizados, todos passando.

---

## 10. O que muda para o cliente

**Nada.** Nenhuma tela, nenhum campo, nenhuma mensagem e nenhum resultado muda.

A sugestão de categoria continua sugerindo exatamente o mesmo. O rascunho, o
histórico, a ordenação e as etiquetas seguem idênticos.

---

## 11. O que o Suporte precisa saber

1. **Não há comunicado a fazer.** Esta entrega é interna e invisível para o
   cliente.
2. **Se um cliente relatar que a sugestão de categoria mudou** depois desta
   atualização, isso **não é esperado** — registre o caso com o nome exato do
   produto e escale para a engenharia.
3. **Não é necessário limpar cache, atualizar navegador ou refazer login.**
4. A memória de resultados se renova sozinha a cada 1 hora. Logo após uma
   atualização do sistema, as primeiras sugestões podem levar um instante a mais
   — comportamento normal e já existente.

---

## 12. Como orientar os clientes

Não há orientação nova. Se surgir pergunta sobre desempenho:

> "Fizemos um ajuste interno que reduz o processamento do servidor na sugestão
> de categorias. Nada muda na sua tela nem no resultado das sugestões."

---

## 13. Perguntas frequentes

**O sistema vai ficar mais rápido para o cliente?**
Não perceptivelmente. O ganho é de consumo do servidor, não de tempo de tela.

**Isso muda as categorias que o sistema sugere?**
Não. Provamos por teste que o resultado é idêntico.

**Meu cliente vai perder rascunhos ou histórico?**
Não. Nada relacionado a rascunho ou histórico foi alterado nesta entrega.

**Aumentou o consumo de internet ou de dados?**
Não. Nenhuma requisição foi criada; o número de chamadas continua o mesmo.

---

## 14. Observações importantes

Encontramos **10 pontos que decidimos não alterar**. Registramos aqui os que
podem gerar dúvida no atendimento:

1. **Ordenação por SKU e busca por código.** Quando o cliente escolhe "SKU
   crescente" e digita um código que casa exatamente com um produto, o resultado
   sai na ordem padrão, não na ordem escolhida. **É o comportamento atual**, não
   uma falha nova. Mexer nisso mudaria resultados de busca, então ficou
   registrado para decisão do produto.

2. **Restaurar rascunho dispara uma nova busca de sugestão.** Ao clicar em
   "Continuar" ou "Usar último", o sistema refaz a sugestão de categoria. Não é
   erro; evitar essa chamada afetaria uma informação de controle interno usada
   para medir a qualidade das sugestões.

3. **Limite de tamanho do rascunho.** O histórico tem limite por item; o
   rascunho não. Um cadastro muito grande pode, em teoria, não ser salvo — sem
   mensagem de erro e sem quebrar nada. Nunca foi observado na prática.

4. **Duas contagens na busca por código.** Existe uma contagem repetida em um
   tipo específico de busca. É anterior a estas entregas e foi registrada para
   uma futura revisão do módulo de busca.

Nenhum desses pontos causa erro, perda de dado ou indisponibilidade.

---

## 15. Checklist final de validação

- [x] Nenhuma regra de negócio alterada
- [x] Nenhum contrato de API alterado (nada foi removido nem tornado obrigatório)
- [x] Nenhuma alteração em pedidos, estoque, sincronização, webhooks ou filas
- [x] Nenhuma alteração no banco de dados
- [x] Nenhuma requisição externa nova
- [x] Regras de economia de tráfego das entregas anteriores respeitadas
- [x] Mecanismos de cache preservados e melhor aproveitados
- [x] Erros de tipagem inalterados (100 = 100)
- [x] Testes automatizados: 4.167 passando, 0 falhando
- [x] Compilação verde
- [x] Proteção nova validada por teste de mutação
- [x] Experiência do cliente inalterada

---

**Elaborado em:** 05/08/2026
**Escopo auditado:** commits `9ce7a93..e396be5` (PRs #235, #236, #237, #238)
**Alterações desta auditoria:** `e8f060c`, `5748194`
