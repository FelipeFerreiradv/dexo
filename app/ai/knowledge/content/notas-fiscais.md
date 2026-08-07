# Notas fiscais (NF-e e NFC-e)

O módulo fiscal fica no menu **Notas fiscais** e reúne cinco telas: **Emitir NF-e**, **Notas Emitidas**, **Enviar XML**, **Inutilizar Número** e **Configuração Fiscal**.

O módulo depende de estar habilitado para a loja; sem isso, o menu não aparece.

**A responsabilidade fiscal é do contador da loja.** O sistema emite o documento com os dados informados — CFOP, NCM, CST e regime tributário são decisão do contador, não do Dexo e não do Bitz.

## NF-e (55) e NFC-e (65)

- **NF-e, modelo 55** — a nota completa. Serve para venda a outra empresa, venda interestadual, e é obrigatória acima do limite da NFC-e.
- **NFC-e, modelo 65** — o cupom fiscal do consumidor final, emitido no balcão.

**Venda acima de R$ 10.000 não emite NFC-e**: a legislação exige NF-e. O PDV avisa isso na própria ação.

A numeração dos dois modelos é **independente**: série 1 número 100 da NF-e e série 1 número 100 da NFC-e podem coexistir.

## Antes de emitir: Configuração Fiscal

Em **Notas fiscais → Configuração Fiscal** ficam o **ambiente**, o **provedor** e o **certificado digital**, além dos dados do emitente.

O **ambiente** tem dois valores:

- **Homologação** — para teste. As notas emitidas aqui **não têm valor fiscal**.
- **Produção** — valem de verdade.

Cada CNPJ tem a **sua** numeração. Uma loja com mais de um CNPJ emitente configura cada um separadamente, e a numeração de um não interfere na do outro.

## Emitir uma NF-e

Em **Notas fiscais → Emitir NF-e**, o assistente tem 9 etapas:

1. **Informações** — dados gerais da nota.
2. **Destinatário** — dados do cliente.
3. **Produtos** — os itens.
4. **Frete** — modalidade e transportadora.
5. **Volumes** — volumes da nota.
6. **Duplicatas** — cobrança.
7. **Pagamentos** — formas de pagamento.
8. **Impostos** — cálculos fiscais.
9. **Finalizar** — revisão e emissão.

Também dá para partir de uma venda pronta:

- Na tela de **Pedidos**, abrindo o pedido → **Emitir NF-e**, já com os dados preenchidos.
- No **PDV Balcão**, nas ações da venda → **Gerar NF-e (modelo 55)** ou **Emitir NFC-e**.

Nem tudo vem preenchido do pedido: **NCM, CFOP e endereço costumam vir vazios** e precisam ser conferidos.

## Situação da nota

| Situação                         | O que é                                |
| -------------------------------- | -------------------------------------- |
| Rascunho                         | ainda não enviada                      |
| Validando / Assinando / Enviando | em processamento                       |
| Autorizada                       | aceita pela SEFAZ                      |
| Rejeitada                        | a SEFAZ recusou; o motivo fica na nota |
| Cancelada                        | cancelada após autorização             |
| Inutilizada                      | o número foi queimado sem virar nota   |

Só a nota **autorizada** gera DANFE.

## Nota rejeitada

Rejeição vem com o motivo da SEFAZ. Na maioria dos casos o número **não foi consumido** e a nota pode ser corrigida e reenviada com o mesmo número — o sistema oferece a reemissão.

Há exceções: nota **denegada** e rejeição por **duplicidade** consomem o número, e aí o caminho é outro.

## Inutilizar numeração

Quando um número da sequência é queimado (uma tentativa que não pode ser reaproveitada), ele precisa ser **inutilizado** junto à SEFAZ para a numeração não ficar com buraco. É o que a tela **Inutilizar Número** faz.

## Enviar XML

A tela **Enviar XML** manda o XML da nota autorizada para o destinatário.

Alguns marketplaces exigem que a nota seja enviada a eles antes de liberar a etiqueta de envio — esse fluxo acontece dentro da tela de Pedidos, não aqui.

## Notas emitidas

**Notas fiscais → Notas Emitidas** lista tudo o que já foi emitido, com filtro por situação e período, o DANFE em PDF, o XML, o cancelamento e a carta de correção.

## Observações na nota

O campo de informações complementares vai para o XML e aparece no DANFE. É onde entram observações de nível nota.

## Erros comuns

- **Nota rejeitada por dados do destinatário** — cadastro de cliente incompleto, quase sempre criado automaticamente por um pedido de marketplace. Completar documento, endereço e indicador de IE.
- **Rejeição por NCM ou CFOP** — vieram vazios do pedido, ou o código não corresponde à operação. É pergunta para o contador.
- **"Venda acima de R$ 10.000 — use NF-e (modelo 55)"** — limite legal da NFC-e.
- **"Receba a venda antes de emitir a NFC-e"** — a venda de balcão ainda está pendente.
- **Nota emitida não vale** — o ambiente estava em Homologação. Nota de homologação é teste.
- **A numeração pulou** — houve rejeição que consumiu o número, ou número inutilizado.

## Limitações conhecidas

- O Dexo não decide tributação: CFOP, NCM, CST e regime são informados pela loja.
- Não há apuração de impostos nem geração de SPED.
- Nota fiscal de entrada (compra da sucata) é registrada nos dados fiscais da sucata, mas não é emitida pelo sistema.

> ⚠️ PENDENTE DE CONFIRMAÇÃO: quais provedores de emissão estão de fato em uso pelos clientes hoje, e se algum cliente emite direto na SEFAZ. Isso muda o vocabulário certo de erro quando alguém me trouxer uma rejeição.
