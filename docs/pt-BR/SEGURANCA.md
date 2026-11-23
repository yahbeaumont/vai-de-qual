# Segurança

Este documento descreve o modelo de segurança da geração atual: o que é protegido, onde estão as fronteiras de confiança, quais ameaças foram consideradas, o que foi implementado, e o que explicitamente não é garantido. Ele não contém relatório de auditoria nem resultado de teste de penetração. Esses documentos são internos e não são publicados, e nada aqui deve ser lido como certificação.

## Ativos

Os ativos são, em ordem de consequência: a integridade do ledger, porque um saldo errado é dinheiro que alguém pode sacar; a disponibilidade do fluxo de pagamento, porque um depósito travado é um incidente de suporte com uma exigência financeira atrelada; os dados pessoais dos jogadores, que incluem um CPF, um nome completo e uma data de nascimento; a capacidade administrativa, porque uma sessão de operador pode ajustar saldos e aprovar saques; e o registro de justiça de cada rodada, porque um jogador tem direito de verificar que um resultado não foi escolhido depois do fato.

## Fronteiras de confiança

**Navegador para a API.** Não confiável. Tudo o que o navegador envia é entrada, incluindo o valor, a escolha de jogo, o id de usuário que ele alega representar e o header `Origin`. O cookie de sessão é uma credencial bearer e é tratado como tal.

**API para PostgreSQL.** Transporte confiável, escritor não confiável. O banco impõe as invariantes que importam, então um bug na API não consegue persistir um saldo ilegal ou um estado de rodada ilegal.

**API para Redis.** Confiável para sessões e contadores, e assumido como falível. Quando falha, a autenticação e as operações com rate limit rejeitam em vez de prosseguir.

**Provedor de pagamento para a API.** Autenticado por assinatura. A rota de webhook é pública, então a assinatura sobre o corpo bruto é a única coisa que separa um evento real de um forjado, e o corpo bruto precisa ser capturado antes de qualquer parsing de JSON.

**Navegador do operador para a API de admin.** A fronteira mais sensível. É protegida pela sessão, pelo papel e por uma checagem exata de origem, nessa ordem de importância.

**API para ferramentas internas.** Duas rotas de rodada aceitam um header de chave compartilhada, comparado em tempo constante. Elas ignoram o guard de sessão por design, não são alcançáveis a partir do front end, e são a menor superfície possível para operações de manutenção.

## Ameaças consideradas

Cookies de sessão roubados ou reproduzidos em replay; session fixation; uma sessão que sobrevive a um bloqueio ou a um logout; cross-site request forgery contra a superfície administrativa; leituras cross-origin de dados de jogadores ou do ledger; webhooks de pagamento forjados ou reenviados em replay; crédito duplicado por retentativas, abas duplicadas ou eventos duplicados; overdraft por débitos concorrentes; adulteração de valores por ponto flutuante ou por valores fornecidos pelo cliente; enumeração de contas por diferenças de tempo ou de erro; credential stuffing contra o login; scraping de resultados de jogos para prever o próximo resultado; escalada de privilégio de PLAYER para ADMIN; e uma dependência comprometida ou um segredo commitado no repositório.

## Controles implementados

**Autenticação.** As senhas são hasheadas com argon2id. Uma tentativa de login para um endereço que não existe ainda executa uma verificação contra um hash fictício, para que o tempo de resposta não revele se a conta existe. O registro impõe um CPF único e um e-mail único no nível do banco, não apenas na validação.

**Sessões.** Tokens opacos de 32 bytes, armazenados no servidor em Redis com o id do usuário e a versão da sessão, entregues em um cookie com `HttpOnly`, `Secure` em produção, `SameSite=Lax` e validade de sete dias. O logout apaga a entrada no Redis. Bloquear um usuário, ou trocar a senha, incrementa a versão na linha do usuário, o que invalida toda sessão existente na requisição seguinte. Uma requisição com sessão ausente, desconhecida ou com versão divergente é rejeitada com 401, e o guard falha fechado com 503 quando o Redis está indisponível.

**Identidade entre abas.** As mutações de jogo e as trocas de seed carregam o id de usuário com o qual o cliente acredita estar agindo. A API o compara com a identidade derivada do cookie e retorna 409 antes de qualquer rate limit ou efeito quando diferem. O header não é uma credencial; é uma checagem de consistência que impede uma aba obsoleta de agir como a conta que fez login depois dela.

**CORS e origens.** O CORS permite uma lista explícita de origens com credenciais habilitadas, nunca um wildcard. Todo controller de admin exige adicionalmente um header `Origin` exatamente igual à origem de admin configurada, em leituras e em escritas, e rejeita um header ausente. A checagem é adicional ao guard de papel, não substituta.

**Autorização.** Os papéis são PLAYER e ADMIN, armazenados na linha do usuário e resolvidos a partir da sessão em cada requisição. Os controllers de admin exigem o papel ADMIN. As rotas internas de rodada exigem a chave compartilhada. Um jogador não consegue abrir uma rota de admin, e um admin não consegue fazer uma aposta, o que é afirmado por um teste de integração em vez de assumido.

**Pagamentos.** A requisição de depósito exige um `Idempotency-Key` sob um índice único. Os valores são inteiros em centavos, interpretados a partir de uma string de dígitos, com checagem de intervalo e normalização antes do uso. O webhook verifica uma assinatura HMAC sobre o corpo bruto com um segredo por ambiente, resolve o depósito a partir dos metadados, do id da sessão ou do id do payment intent, e só credita quando o depósito armazenado ainda está pendente e o provedor reporta a sessão como paga. Um replay é absorvido pela idempotency key do ledger. A URL de retorno do front end nunca credita.

**Ledger.** Todo lançamento é validado quanto a lançamentos balanceados, contas distintas, valores não zero e intervalo de bigint, e então aplicado com uma ordem de lock determinística. Uma constraint `CHECK` proíbe saldo positivo em uma carteira de jogador, e o erro `23514` resultante é traduzido em uma resposta de saldo insuficiente. Os lançamentos são append-only. A reconciliação compara saldos materializados com a soma derivada e reporta divergência sem repará-la.

**Saques.** Um saque pendente por usuário, um intervalo de valor checado na fronteira, e um limite diário calculado no fuso de São Paulo. Aprovação e rejeição são ações administrativas escritas com uma linha de auditoria na mesma transação, e ambas são idempotentes por chave. A rejeição reverte a reserva pelo ledger em vez de editar um saldo.

**Rate limits.** Janelas fixas em Redis, aplicadas por IP e por usuário, em registro, login, depósito, saque, rotação de seed e em cada ação de jogo. Os limites falham fechados. As respostas incluem `Retry-After`, e os contadores são separados por operação, para que um jogo movimentado não esgote o orçamento de um pagamento.

**Auditoria.** As ações administrativas escrevem uma linha de auditoria na mesma transação do seu efeito, com ator, alvo, estado antes e depois, e uma idempotency key. Se a ação é retentada, a linha de auditoria não é duplicada.

**Higiene operacional.** Os segredos vêm de variáveis de ambiente, nunca do repositório; arquivos `.env` são ignorados; a API valida seu ambiente no boot e se recusa a iniciar quando falta um valor obrigatório. As suítes de teste afirmam que estão apontadas para um banco local descartável e um Redis antes de rodar. Um job noturno roda as suítes de distribuição de aleatoriedade, que detectam um gerador enviesado antes dos jogadores.

**Justiça.** Cada jogador tem um hash de server seed comprometido, um nonce monotônico e uma client seed que ele pode alterar. Cada rodada registra o hash de seed e a versão de protocolo em vigor quando ela abriu, então uma rodada histórica pode ser verificada com o protocolo sob o qual foi criada. Os resultados são calculados no servidor, e o cliente nunca fornece um resultado.

## O que não é garantido

A checagem de origem pressupõe um navegador. Qualquer cliente HTTP pode enviar um header `Origin` de sua escolha, então o guard de origem de admin não defende contra um atacante que não é navegador e que detém um cookie de admin válido. Ele aumenta o custo de um ataque cross-site e não faz nada contra um token roubado.

Não há autenticação multifator, nem vínculo de dispositivo, nem confirmação step-up para ajustes grandes, nem detecção de anomalias no comportamento de operadores. Uma credencial de admin basta para ajustar um saldo, e os únicos controles compensatórios são o log de auditoria, a fronteira de papel e o fato de que ajustes são lançamentos com uma contrapartida.

Os rate limits são janelas fixas, não deslizantes, então um chamador consegue dobrar a taxa efetiva em torno da fronteira de uma janela. Eles são limitados por IP e por usuário, o que não impede um atacante distribuído com muitos endereços. O comportamento de falhar fechado transforma uma indisponibilidade do Redis em rejeição de tráfego, que é um trade de disponibilidade aceito deliberadamente.

A revisão de saques é uma decisão humana. Não há score de fraude, nem modelo de velocidade, nem retenção automática, então a qualidade desse controle depende do operador.

Backups, exercícios de restore, controle de acesso ao banco, hardening de host, rotação de segredos e risco do lado do provedor são preocupações operacionais fora da aplicação. A relação com o provedor de pagamento é compartilhada com outros produtos, então uma restrição no nível do provedor afetaria este produto independentemente dos seus próprios controles, e nenhuma mudança na aplicação remove essa exposição.

Por fim, este repositório não publica nenhum resultado de auditoria. Os controles acima são os implementados no código, descritos a partir do código, e vários deles são cobertos por testes de integração que rodam contra PostgreSQL e Redis reais. Isso é evidência de intenção e de comportamento sob teste, não prova de ausência de defeitos.

## Reportando um problema

Este é um repositório de portfólio sem ambiente implantado associado. Se você encontrar um problema nos exemplos publicados ou na descrição do design, abra uma issue neste repositório ou contate o autor pelo perfil linkado no README. Não teste nada contra um serviço ativo; não há nada aqui contra o que testar.
