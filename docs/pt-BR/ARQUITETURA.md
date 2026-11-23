# Arquitetura

## Contexto

Vai de Qual é uma plataforma de apostas para o mercado brasileiro. Os jogadores abastecem uma carteira via Pix, jogam jogos de cassino ou apostam em uma liga de futebol simulada, e solicitam saques que um operador aprova manualmente. Os operadores usam um backoffice para gestão de usuários, ajustes manuais, a fila de saques, extratos do ledger e o log de auditoria. O produto opera sob a regulamentação brasileira de apostas, e é por isso que cada movimentação de dinheiro precisa ser explicável e que a superfície administrativa é uma zona de segurança separada.

Esta geração leva a marca de um produto de comunidade em arquivo HTML único para quatro peças em runtime: um front end estático, uma API modular, PostgreSQL e Redis. O produto transacional é novo, e a história dessa transição está em [ESTUDO-DE-CASO.md](ESTUDO-DE-CASO.md).

## Componentes e responsabilidades

**Front end do jogador.** Uma aplicação Next.js compilada para arquivos estáticos. Ela não contém nenhuma regra que afete dinheiro: valida formatos para dar feedback, anima as rodadas e renderiza as respostas da API. A animação do Crash é conduzida localmente a partir de um timestamp do servidor, então o navegador desenha a curva mas nunca decide o resultado.

**Portal administrativo.** Um segundo build estático a partir da mesma base de código, em um hostname diferente, com seu próprio entry point, rotas e origem, para que possa entrar em allowlist de forma independente.

**API.** Um processo NestJS com 13 módulos de funcionalidade: auth, admin, ledger, wallet, payments, withdrawals, bonus, núcleo de games, e um módulo por jogo (crash, mines, double, slots, league). Os módulos são donos dos seus controllers, services, guards e constantes; o acesso entre módulos usa services exportados. 48 rotas HTTP, algumas administrativas e duas internas.

**PostgreSQL.** O ledger de registro e o estado do produto. Dinheiro é `bigint` em centavos, nunca ponto flutuante. As constraints codificam invariantes que não podem depender de um caminho de código: saldos de carteira de jogador não podem ser positivos, estados de rodada têm um conjunto fixo de valores legais, e arrays de tabuleiro de jogo têm checagens de formato. 22 migrations, 13 modelos.

**Redis.** Sessões no servidor, contadores de rate limit de janela fixa e contadores de rotação. Não guarda dinheiro nem nada que não possa ser reconstruído, e todo consumidor falha fechado: se o Redis está indisponível, a autenticação retorna 503 em vez de admitir a requisição.

**Provedor de pagamento.** Stripe Checkout em modo de pagamento, restrito a Pix. A API nunca vê dados de cartão ou credenciais bancárias.

## Fronteiras e contratos

Toda requisição passa pelo guard global de sessão, a menos que seu método e caminho estejam em uma pequena allowlist pública (health, register, login, webhook) ou que seja uma das duas rotas internas de rodada. O guard resolve o cookie para uma sessão no Redis, carrega o usuário, e rejeita um usuário bloqueado ou uma versão de sessão obsoleta.

A fronteira de dinheiro é o módulo de ledger. Nada fora dele escreve um saldo. Quem chama passa uma idempotency key, um tipo de transação e uma lista de pares de código de conta e valor. O módulo valida pelo menos dois lançamentos em contas distintas, nenhum valor zero, soma zero e o intervalo do bigint, depois atualiza os saldos materializados e anexa os lançamentos. Um chamador que precisa de atomicidade entre uma linha de domínio e seu lançamento passa seu próprio transaction client.

A fronteira de webhook é o módulo de payments. A rota é pública porque o provedor não consegue manter uma sessão, e ela é autenticada por uma assinatura HMAC sobre o corpo bruto com um segredo por ambiente. O handler mapeia um pequeno conjunto de tipos de evento para transições de estado e responde 200 a todo o resto, para que o provedor pare de retentar.

Duas rotas internas de rodada atendem ferramentas de manutenção, protegidas por uma chave compartilhada comparada em tempo constante e nunca chamadas pelo front end.

A fronteira do banco é o Prisma, com migrations aplicadas por um comando de release, nunca `migrate dev` contra um ambiente compartilhado, e a API não roda migrations no boot.

## Fluxo de requisição

Um depósito, de ponta a ponta:

1. `POST /payments/deposit` com um `Idempotency-Key` obrigatório e um valor como string de inteiro. Os rate limits rodam primeiro, por IP e por usuário.
2. Em uma transação: bloqueia a linha do usuário, procura a chave, soma os depósitos pendentes e pagos do dia para o limite diário no fuso de São Paulo, insere um depósito pendente, faz commit.
3. Pede ao provedor uma sessão de checkout carregando o id do depósito nos metadados e uma idempotency key do provedor. Persiste o id da sessão, a URL e a expiração; em caso de falha, marca o depósito como falho.
4. O jogador paga a cobrança Pix na página do provedor. A sessão de checkout e a cobrança Pix expiram em relógios separados, ambas em 30 minutos, e nenhuma é calculada a partir da outra.
5. O provedor envia um evento assinado. O handler verifica a assinatura, resolve e bloqueia o depósito, confirma que ele ainda está pendente e que a sessão está paga, lança a transação no ledger com uma chave derivada da sessão, marca o depósito como pago, registra o progresso de bônus na mesma transação, e retorna 200.
6. A tela da carteira lê o saldo da linha da conta; a URL de retorno apenas dispara um refresh.

Uma rodada é mais curta. O endpoint de aposta bloqueia o usuário, incrementa o nonce, abre a rodada, debita a aposta pelo ledger com uma chave derivada do id da rodada, e faz commit. A liquidação ou o cashout bloqueia o usuário e depois a rodada, calcula o payout no servidor, lança uma segunda transação com sua própria chave, e grava o estado terminal. Um cashout concorrente perde a corrida pelo lock e recebe o estado terminal em vez de um segundo pagamento.

## Modelo de dados, conceitualmente

As contas formam uma árvore por prefixo de código em quatro classes: ativos (caixa e recebíveis), passivos (carteiras de jogadores, dinheiro em trânsito), receita (resultados de jogos e taxas) e despesas (prêmios, bônus concedido, taxas do provedor). Cada jogador ganha uma subconta de passivo no registro, e uma segunda guarda o saldo de bônus. Cada conta carrega um saldo materializado igual à soma com sinal dos seus lançamentos.

Uma transação de ledger é um cabeçalho com uma idempotency key, um tipo e uma descrição. Os lançamentos pertencem a uma transação e referenciam uma conta com um valor com sinal. Os lançamentos são append-only, sem caminho de update ou delete.

Depósitos, saques, rodadas e eventos da liga referenciam o ledger por convenção, por meio de tipos de transação e prefixos de chave. Uma rodada registra o hash de seed em vigor quando ela abriu, a versão de protocolo usada para sua aleatoriedade, e seu estado terminal. Uma linha de auditoria é escrita na mesma transação de cada ação administrativa, com uma chave que torna a ação reproduzível sem duplicação.

## Deploy

Dois alvos de hospedagem estática (jogador e admin) e um contêiner para a API. O front end é construído por ambiente porque a origem da API é compilada nele. A API valida seu ambiente no boot com zod e se recusa a iniciar quando falta um valor. As migrations rodam como um comando de release antes de o novo processo receber tráfego. Um job de CI noturno roda seis suítes de distribuição de aleatoriedade com um milhão de amostras cada, contra um banco descartável.

## Limites conhecidos

Não há fila entre a API e o provedor, então uma chamada lenta ocupa uma requisição. Não há event store: o handler aplica transições diretamente, e um evento ausente é pego pela reconciliação, não por um agendamento de retentativas. A liga simulada é conduzida por um cron externo que chama um entry point de CLI, então ela para se esse agendador parar. A reconciliação reporta divergência e nunca a repara, deliberadamente, com algum custo operacional. Multi-região, read replicas e afinidade de sessão entre instâncias estão fora de escopo: a API assume um primário PostgreSQL e um Redis por ambiente.
