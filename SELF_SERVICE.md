# Venda self-service e área do cliente

## Fluxo entregue

1. O administrador entra em **Vendas e produtos**, cadastra ou edita um produto e suas vantagens. Pode definir compra direta ou orçamento e desativar a oferta sem excluir o histórico.
2. A página inicial e o checkout leem o catálogo do servidor. O checkout sempre usa o preço salvo no servidor e exige nova conferência se o produto mudou enquanto a página estava aberta.
3. O comprador cria uma conta ou entra na conta existente, informa o nome do evento e segue para o checkout do Mercado Pago.
4. O pedido fica pendente. O retorno do navegador, mesmo com `result=success`, não libera o evento.
5. A notificação autenticada do Mercado Pago é confirmada pela API de pagamentos. O servidor confere o pedido, moeda, valor e ambiente da transação, cria uma única sala e agenda o e-mail.
6. Pelo Resend, o cliente recebe o caminho para sua área, orientações de personalização e o link dos participantes. Senhas e chaves de operador não são enviadas por e-mail.
7. Na área do cliente, ele envia logo e banner, escolhe cores e idiomas, salva e publica o evento. O link e o QR Code dos participantes passam a funcionar após a publicação.
8. O estúdio usa a sessão do cliente responsável. O servidor aplica os limites contratados de idiomas, participantes simultâneos e tempo de transmissão. Tempo é reservado em blocos de até cinco segundos enquanto há áudio/transcrição de host, não enquanto ele apenas prepara o evento.
9. Reembolso ou chargeback revoga a publicação e o acesso. Repetir uma notificação não cria outro evento nem outro e-mail de confirmação.

## Telas

- `/` ou `/landing.html`: apresentação e catálogo atualizado.
- `/checkout.html?plan=ID`: contratação.
- `/customer.html`: conta, eventos, personalização e pedidos.
- `/sales.html`: vendas, situação das integrações e catálogo administrativo.
- `/?room=ID`: acesso do participante. Continua usando a tela original do ouvinte.
- `/host.html?room=ID`: estúdio, autenticado como responsável ou administrador.
- `/screen.html?room=ID`: projeção.

Os dados dos pedidos guardam uma cópia das condições do produto. Alterar preço ou vantagens muda as próximas compras; não modifica o que um cliente já contratou.

## Configuração para ativar vendas reais

É necessário configurar no ambiente de hospedagem:

| Variável | Uso |
|---|---|
| `NODE_ENV` | `production` na hospedagem. A imagem Docker já define esse valor. |
| `DATABASE_URL` | PostgreSQL existente, com permissão para criar as novas tabelas `self_service_records` e `self_service_assets`. |
| `APP_BASE_URL` | Origem HTTPS pública da aplicação, sem caminho adicional. Ex.: `https://eventos.suaempresa.com.br`. |
| `MERCADOPAGO_ACCESS_TOKEN` | Token privado do vendedor, no ambiente correto. |
| `MERCADOPAGO_WEBHOOK_SECRET` | Segredo da assinatura das notificações da integração. |
| `MERCADOPAGO_COLLECTOR_ID` | ID do vendedor, opcional; permite validação adicional. |
| `MERCADOPAGO_SANDBOX` | `true` para credenciais/pagamentos de teste; `false` para transações reais. |
| `RESEND_API_KEY` | Chave privada da API do Resend. |
| `EMAIL_FROM` | Remetente em um domínio verificado no Resend. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Conta inicial administrativa. Produção exige senha própria de ao menos 12 caracteres; a credencial de desenvolvimento não é aceita em produção. |
| `TRUST_PROXY_HOPS` | Número de proxies confiáveis. Configure de acordo com a hospedagem, para os limites de tentativas identificarem corretamente o IP. |

As configurações existentes de áudio, tradução, Redis e IA continuam necessárias para esses serviços, independentemente da cobrança.

No Mercado Pago, configure o evento **Payments** e a URL:

```
https://SEU-DOMINIO/api/payments/mercadopago/webhook
```

A assinatura usa os cabeçalhos `x-signature`, `x-request-id` e o ID de `data.id` da query string. Depois da assinatura, o servidor busca o pagamento na API. Consulte a configuração oficial de [notificações do Mercado Pago](https://www.mercadopago.com.br/developers/en/docs/checkout-pro-preferences/payment-notifications).

No Resend, verifique o domínio e configure o remetente. O envio usa a [API de e-mail do Resend](https://resend.com/docs/api-reference/emails/send-email), com chave de idempotência. Falhas ficam em uma fila persistente com tentativas automáticas; o administrador pode reenviar o acesso de um pedido pago.

Sem PostgreSQL, URL pública, pagamento e e-mail configurados, o botão de pagamento fica bloqueado. Não existe endpoint público para simular aprovação. A simulação está restrita aos testes automatizados.

Para uma prévia local sem integrações, use `NODE_ENV=development` e deixe `DATABASE_URL`, `REDIS_URL` e `APP_BASE_URL` vazios. Nesse modo é possível conhecer as telas e editar o catálogo, mas não fazer cobranças. Não use o usuário/senha de desenvolvimento em produção.

Esta entrega altera o código do projeto. A hospedagem precisa receber a nova versão e reiniciar o servidor para disponibilizar as novas APIs; atualizar apenas a página do navegador não faz essa publicação.

## Persistência e isolamento

- Clientes têm autenticação separada dos administradores, senha com scrypt, cookie HttpOnly/SameSite e proteção CSRF nas alterações.
- Logo e banner são enviados como PNG, JPEG ou WebP, com até 5 MB por imagem. Os bytes ficam no PostgreSQL, portanto não dependem do disco temporário da hospedagem. Até 30 envios por evento.
- Identidade visual e glossários são limitados ao cliente responsável; o painel de administrador mantém sua autenticação anterior.
- O registro de pedidos, provisionamento e fila de e-mail são transacionais. As reservas de conexões e horas usam o mesmo banco, inclusive com múltiplas instâncias.
- Em desenvolvimento sem PostgreSQL, o catálogo e as contas funcionam em memória e somem ao reiniciar. Compras ficam desativadas para não registrar cobranças sem persistência.

## Validação

Execute `npm test`. Os testes usam provedor de pagamento e Resend substituídos somente no processo de teste. Cobrem preço do servidor, catálogo, permissões, CSRF, assinatura, valor, notificações duplicadas, uploads, publicação, participantes, consumo de horas, reembolso e recuperação de senha.

Antes de vender, faça uma compra completa no ambiente de testes do provedor, confirme a entrega do e-mail, a publicação do evento e a transmissão com suas integrações reais de IA. Os testes locais não fazem cobranças reais nem enviam mensagens a clientes.

## Ofertas adicionais
Veja UPSELLS.md para configurar ofertas por serviço e alertas antecipados na mesa de operações.

