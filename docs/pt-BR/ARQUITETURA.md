# Arquitetura

## Contexto

Vai de Qual é uma plataforma de comunidade de futebol para o mercado brasileiro. Leitores e analistas criam perfis, publicam posts e análises de partida, comentam, se seguem, salvam itens e recebem notificações. Parte do conteúdo fica atrás de planos pagos, créditos compram itens avulsos, e criadores recebem uma fatia do que o seu conteúdo gera. Operadores usam um backoffice para moderação, bloqueio de conta, inspeção de planos e entitlements, aprovação de repasse, extratos do ledger e o log de auditoria.

O conteúdo é o produto, e o dinheiro é menor do que parece. Mas é o dinheiro que precisa ser explicável linha por linha, e é por isso que o ledger tem um único caminho de escrita e que a superfície administrativa é uma zona de segurança separada.

Esta geração vai de um produto de comunidade em arquivo HTML único para quatro peças em runtime: um front end estático, uma API modular, PostgreSQL e Redis. A camada financeira e de acesso é nova, e a história dessa transição está em [ESTUDO-DE-CASO.md](ESTUDO-DE-CASO.md).

## Componentes e responsabilidades

**Front end da comunidade.** Uma aplicação Next.js compilada para arquivos estáticos. Ela não guarda nenhuma regra que afete dinheiro ou acesso: valida formatos para dar feedback, renderiza as respostas da API e trata o acesso como um fato devolvido pela API, nunca como flag local. Uma publicação premium chega como preview, a menos que a API decida o contrário.

**Portal administrativo.** Um segundo build estático da mesma base de código, em outro hostname, com entry point, rotas e origem próprios, para entrar em allowlist de forma independente.

**API.** Um processo NestJS com módulos de funcionalidade: auth, perfis e grafo social, conteúdo e moderação, planos e pagamentos, créditos, repasses a criadores, administração. Duas peças ficam abaixo de todos eles: o ledger, que é dono de toda escrita em saldo, e a reconciliação, que é entry point de CLI e não controller. Cada módulo é dono dos seus controllers, services, guards e constantes, e o acesso entre módulos usa services exportados.

**PostgreSQL.** O ledger de registro e o estado do produto. Dinheiro é `bigint` em centavos, nunca ponto flutuante. As constraints codificam invariantes que não podem depender de um caminho de código: saldo de crédito do usuário não pode ser positivo, período de entitlement não pode terminar antes de começar, e estados de compra e de moderação têm um conjunto fixo de valores legais.

**Redis.** Sessões no servidor, contadores de rate limit de janela fixa e contadores de notificação. Não guarda dinheiro nem nada que não dê para reconstruir, e todo consumidor falha fechado: se o Redis cai, a autenticação devolve 503 em vez de admitir a requisição.

**Provedor de pagamento.** Stripe Checkout para compra de planos e de pacotes de crédito. A API nunca vê dados de cartão.

## Fronteiras e contratos

Toda requisição passa pelo guard global de sessão, a menos que método e caminho estejam em uma allowlist pública curta (health, register, login, webhook). O guard resolve o cookie em uma sessão no Redis, carrega o usuário e rejeita usuário bloqueado ou versão de sessão obsoleta.

A fronteira de dinheiro é o módulo de ledger. Nada fora dele escreve saldo. Quem chama passa uma idempotency key, um tipo de transação e uma lista de pares de código de conta e valor. O módulo valida pelo menos dois lançamentos em contas distintas, nenhum valor zero, soma zero e o intervalo do bigint, depois atualiza os saldos materializados e anexa os lançamentos. Quem precisa de atomicidade com uma linha de domínio passa o próprio transaction client. Os tipos em uso são compra de plano, compra de crédito, resgate de crédito, repasse a criador, estorno e ajuste manual.

A fronteira de acesso é o serviço de entitlement. Toda leitura premium o consulta com o id do leitor e o id do conteúdo, e ele responde a partir das linhas de entitlement e das contas de crédito. Nunca lê flag do cliente, e o front end não tem caminho de código que decida sozinho que uma publicação premium é gratuita.

A fronteira de webhook é o módulo de pagamentos. A rota é pública porque o provedor não consegue manter sessão, e a autenticação é uma assinatura HMAC sobre o corpo bruto com segredo por ambiente. O handler mapeia um conjunto pequeno de tipos de evento para transições de estado e responde 200 a todo o resto, para o provedor parar de retentar.

A fronteira de conteúdo é o módulo de moderação. Todo caminho de publicação passa pela mesma checagem: tamanho do corpo, política de link, lista de termos e a situação do autor. Uma remoção grava um registro de moderação e uma linha de auditoria em uma transação e nunca apaga a publicação, então o registro do que foi removido sobrevive à remoção.

A fronteira do banco é o Prisma, com migrations aplicadas por comando de release, nunca `migrate dev` contra ambiente compartilhado, e a API não roda migration no boot.

## Fluxo de requisição

Uma compra de plano, de ponta a ponta:

1. `POST /plans/checkout` com um `Idempotency-Key` obrigatório e um código de plano. Os rate limits rodam primeiro, por IP e por usuário.
2. Em uma transação, a API bloqueia a linha do usuário, procura a chave, insere uma compra pendente e faz commit.
3. A API pede ao provedor uma sessão de checkout com o id da compra nos metadados e uma idempotency key do provedor. Grava id da sessão, URL e expiração; se a chamada falhar, marca a compra como falha.
4. O comprador paga na página do provedor e volta para o front end, que atualiza. A URL de retorno não carrega autoridade nenhuma.
5. O provedor envia um evento assinado. O handler verifica a assinatura, resolve e bloqueia a compra, confirma que ela ainda está pendente e que a sessão está paga, lança a transação no ledger com uma chave derivada da sessão, marca a compra como paga e grava o entitlement com o seu período, depois responde 200.
6. A tela da conta lê o entitlement e o saldo de créditos; a URL de retorno só aciona um refresh.

Uma publicação é mais curta. O endpoint de publicação valida o corpo com zod, confere a situação do autor e a lista de termos, grava a publicação e faz commit. Nada nesse caminho toca o ledger: publicar é gratuito, e o acesso se decide na leitura.

Uma página de feed é uma query por keyset sobre seguidores e itens salvos, com cursor, e pergunta ao serviço de entitlement uma vez por página, não uma vez por item. Uma publicação premium devolve o corpo só quando um entitlement ou um crédito resgatado a cobre; caso contrário, devolve um preview e o motivo.

## Modelo de dados, conceitualmente

As contas formam uma árvore por prefixo de código em quatro classes: ativos (caixa no provedor e valores a receber), passivos (saldos de crédito dos usuários e valores a pagar a criadores), receita (períodos de plano reconhecidos e créditos consumidos) e despesas (repasses a criadores e taxas do provedor). Todo usuário ganha uma subconta de crédito no cadastro, e cada conta carrega um saldo materializado igual à soma com sinal dos seus lançamentos.

Uma transação de ledger é um cabeçalho com idempotency key, tipo e descrição. Os lançamentos pertencem a uma transação e referenciam uma conta com um valor com sinal. Lançamentos são append-only, sem caminho de update ou delete.

Ao redor do ledger, as tabelas de produto são profile, follow, post, comment, saved item, notification, report, moderation action, plan, purchase, entitlement, credit pack, payout e audit. Compras, entitlements e repasses referenciam o ledger por convenção, por meio de tipos de transação e prefixos de chave. Um entitlement registra a origem (compra de plano, pacote de crédito ou concessão manual), o plano a que se refere, início e fim. Uma linha de auditoria é escrita na mesma transação de cada ação administrativa, com uma chave que torna a ação reproduzível sem duplicação.

## Deploy

Dois alvos de hospedagem estática (comunidade e admin) e um contêiner para a API. O front end é construído por ambiente porque a origem da API é compilada nele. A API valida o próprio ambiente no boot com zod e se recusa a iniciar quando falta um valor. As migrations rodam como comando de release antes de o novo processo receber tráfego. Um job agendado roda o entry point de reconciliação, que sai com código diferente de zero quando um saldo materializado discorda dos lançamentos por trás dele.

## Limites conhecidos

Não há fila na frente do provedor, então uma chamada lenta ocupa uma requisição. Não há event store: o handler aplica as transições direto, e um evento ausente é pego pela reconciliação, não por um agendamento de retentativa. A reconciliação reporta divergência e nunca a corrige, de propósito, com algum custo operacional. O feed é fan-out na leitura: uma consulta por keyset junta os seguidores na hora da requisição, então uma conta que segue muitos criadores paga por isso em toda página, e um cache com fan-out na escrita foi considerado e ficou de fora porque cria uma segunda cópia do grafo que pode discordar da primeira. A moderação é lista de termos mais revisão humana, sem classificador. Multi-região, read replica e afinidade de sessão entre instâncias estão fora de escopo: a API assume um primário PostgreSQL e um Redis por ambiente.
