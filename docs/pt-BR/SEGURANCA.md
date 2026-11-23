# Segurança

Este documento descreve o modelo de segurança da geração atual: o que é protegido, onde ficam as fronteiras de confiança, quais ameaças foram consideradas, o que foi implementado e o que explicitamente não é garantido. Ele não traz relatório de auditoria nem resultado de teste de penetração. Esses documentos são internos e não são publicados, e nada aqui deve ser lido como certificação.

## Ativos

Os ativos são, em ordem de consequência: a integridade do ledger, porque saldo errado é dinheiro que a plataforma deve e não consegue explicar; a disponibilidade do fluxo de pagamento, porque uma compra travada é incidente de suporte com cobrança anexada; os dados de conta, que incluem e-mail, nome, data de nascimento e tudo o que a pessoa escolheu publicar; a capacidade administrativa, porque uma sessão de operador pode remover conteúdo, bloquear conta, conceder entitlement e aprovar repasse; e a integridade do registro de moderação, porque remoção sem registro é indistinguível de censura.

## Fronteiras de confiança

**Navegador para a API.** Não confiável. Tudo o que o navegador envia é entrada, inclusive o valor, o código do plano, o corpo do conteúdo, o id de usuário que ele diz representar e o header `Origin`. O cookie de sessão é credencial bearer e é tratado como tal.

**API para PostgreSQL.** Transporte confiável, escritor não confiável. O banco impõe as invariantes que importam, então um bug na API não persiste saldo ilegal, entitlement que termina antes de começar nem compra em estado que a máquina de estados não tem.

**API para Redis.** Confiável para sessões e contadores, e assumido como falível. Quando falha, autenticação e operações com rate limit rejeitam em vez de seguir.

**Provedor de pagamento para a API.** Autenticado por assinatura. A rota de webhook é pública, então a assinatura sobre o corpo bruto é a única coisa que separa evento real de forjado, e o corpo bruto precisa ser capturado antes de qualquer parsing de JSON.

**Navegador do operador para a API de admin.** A fronteira mais sensível. Fica protegida pela sessão, pelo papel e por uma checagem exata de origem, nessa ordem de importância.

**API para execução de repasse.** A aplicação registra a decisão e o lançamento, e o dinheiro sai pelo provedor. Os dois lados são comparados pela reconciliação, não pela confiança: uma transferência que o provedor reporta e o ledger não tem é exatamente a divergência que o job existe para achar.

## Ameaças consideradas

Cookies de sessão roubados ou reenviados em replay; session fixation; sessão que sobrevive a bloqueio ou logout; cross-site request forgery contra a superfície administrativa; leituras cross-origin de dados de conta, histórico de compra ou extratos do ledger; webhooks de pagamento forjados ou reenviados; concessão dupla de acesso por retentativa, abas duplicadas ou eventos duplicados; estouro de saldo de crédito por resgates concorrentes; adulteração de valor por ponto flutuante ou por valor vindo do cliente; enumeração de contas por diferença de tempo ou de erro; credential stuffing contra o login; scraping de conteúdo premium pelos endpoints públicos; escalada de privilégio de USER para ADMIN; um operador que aprova o mesmo repasse duas vezes; uma dependência comprometida ou um segredo commitado no repositório.

## Controles implementados

**Autenticação.** As senhas são hasheadas com argon2id. Uma tentativa de login para endereço que não existe ainda executa uma verificação contra um hash fictício, para que o tempo de resposta não revele se a conta existe. O cadastro impõe e-mail único no nível do banco, não só na validação.

**Sessões.** Tokens opacos de 32 bytes, guardados no servidor em Redis com o id do usuário e a versão da sessão, entregues em cookie com `HttpOnly`, `Secure` em produção, `SameSite=Lax` e validade de sete dias. O logout apaga a entrada no Redis. Bloquear uma conta, ou trocar a senha, incrementa a versão na linha do usuário, o que invalida toda sessão existente já na requisição seguinte. Requisição com sessão ausente, desconhecida ou com versão divergente é rejeitada com 401, e o guard falha fechado com 503 quando o Redis está indisponível.

**Identidade entre abas.** As mutações de conteúdo e de pagamento carregam o id de usuário com o qual o cliente acredita estar agindo. A API compara com a identidade derivada do cookie e devolve 409 antes de qualquer rate limit ou efeito quando diferem. O header não é credencial; é checagem de consistência que impede uma aba obsoleta de agir como a conta que entrou depois dela.

**CORS e origens.** O CORS permite uma lista explícita de origens com credenciais habilitadas, nunca wildcard. Todo controller de admin exige, além disso, um header `Origin` exatamente igual à origem de admin configurada, em leitura e em escrita, e rejeita header ausente. A checagem é adicional ao guard de papel, não substituta.

**Autorização.** Os papéis são USER e ADMIN, guardados na linha do usuário e resolvidos a partir da sessão em cada requisição. Todo controller de admin exige o papel ADMIN. Um USER não abre rota de admin, e uma conta admin não tem acesso especial a conteúdo premium, o que um teste de integração afirma em vez de supor.

**Controle de acesso.** Toda leitura premium consulta o serviço de entitlement com o id do leitor e o id do conteúdo, e a resposta é produzida no servidor. O front end recebe um preview ou um corpo, nunca uma regra. O resgate de crédito é um lançamento no ledger com chave própria, então duplo clique ou requisição retentada não gasta duas vezes, e um entitlement expirado é recusado na leitura em vez de por um job que talvez não tenha rodado.

**Pagamentos.** A requisição de checkout exige um `Idempotency-Key` sob índice único. Os valores são inteiros em centavos, interpretados a partir de uma string de dígitos, com checagem de faixa e normalização antes do uso. O código do plano é resolvido no servidor contra a tabela de planos, então o preço nunca vem do cliente. O webhook verifica uma assinatura HMAC sobre o corpo bruto com segredo por ambiente, resolve a compra pelos metadados ou pelo id da sessão, e só concede quando a compra armazenada ainda está pendente e o provedor reporta a sessão como paga. Um replay morre na idempotency key do ledger. A URL de retorno do front end nunca concede nada.

**Ledger.** Cada lançamento passa por validação de balanceamento, contas distintas, valores diferentes de zero e intervalo de bigint, e depois é aplicado com ordem de lock fixa. Uma constraint `CHECK` proíbe saldo positivo em conta de crédito, e o erro `23514` resultante é traduzido em resposta de saldo insuficiente. Os lançamentos são append-only. A reconciliação compara saldos materializados com a soma derivada e reporta divergência sem repará-la.

**Repasses.** Um lote de repasse é montado a partir do que o criador ganhou, e a aprovação é ação administrativa escrita com linha de auditoria na mesma transação. Aprovação e rejeição são idempotentes por chave, então envio duplicado produz um lançamento só. Um repasse acima do saldo a pagar do criador é recusado pela mesma constraint que protege os créditos dos usuários, e um estorno é um lançamento, não edição do original.

**Moderação.** Publicar e comentar passam por uma checagem comum de tamanho do corpo, política de link, lista de termos e situação do autor. Conta bloqueada não publica, não comenta e não segue, e o bloqueio vale já na requisição seguinte porque também incrementa a versão da sessão. Uma remoção grava registro de moderação com motivo, ator e alvo, e nunca apaga a linha da publicação.

**Rate limits.** Janelas fixas em Redis, aplicadas por IP e por usuário, em cadastro, login, publicação, comentário, seguir, checkout, resgate de crédito e aprovação de repasse. Os limites falham fechados. As respostas incluem `Retry-After`, e os contadores são separados por operação, para que um feed movimentado não esgote o orçamento de um checkout.

**Auditoria.** As ações administrativas escrevem uma linha de auditoria na mesma transação do seu efeito, com ator, alvo, estado antes e depois, e uma idempotency key. Se a ação é retentada, a linha de auditoria não é duplicada.

**Higiene operacional.** Segredos vêm de variáveis de ambiente, nunca do repositório; arquivos `.env` são ignorados; a API valida o próprio ambiente no boot e se recusa a iniciar quando falta valor obrigatório. As suítes de teste afirmam que estão apontadas para banco local descartável e Redis antes de rodar. Um job agendado roda a reconciliação e sai com código diferente de zero quando um saldo materializado discorda dos lançamentos.

## O que não é garantido

A checagem de origem pressupõe um navegador. Qualquer cliente HTTP envia o header `Origin` que quiser, então o guard de origem de admin não defende contra um atacante que não é navegador e que detém um cookie de admin válido. Ele aumenta o custo de um ataque cross-site e não faz nada contra um token roubado.

Não há autenticação multifator, vínculo de dispositivo, confirmação step-up para repasse grande nem detecção de anomalia no comportamento de operadores. Uma credencial de admin basta para conceder um entitlement ou aprovar um repasse, e os únicos controles compensatórios são o log de auditoria, a fronteira de papel e o fato de que repasses são lançamentos contra uma conta a pagar, não edições.

Os rate limits são janelas fixas, não deslizantes, então um chamador consegue dobrar a taxa efetiva em torno da fronteira de uma janela. Eles são limitados por IP e por usuário, o que não impede um atacante distribuído com muitos endereços. O comportamento de falhar fechado transforma uma indisponibilidade do Redis em rejeição de tráfego, que é um trade de disponibilidade aceito de propósito.

A moderação é lista de termos mais revisão humana. Não há classificador nem retenção automática, então a consistência dela é a consistência da política e da pessoa que a aplica.

A revisão de repasse é decisão humana. Não há score de fraude, modelo de velocidade nem retenção automática, então a qualidade desse controle depende do operador.

Backups, exercícios de restore, controle de acesso ao banco, hardening de host, rotação de segredos e risco do lado do provedor são preocupações operacionais fora da aplicação. A relação com o provedor de pagamento é compartilhada com outros produtos, então uma restrição no nível do provedor afetaria este produto independentemente dos seus próprios controles, e nenhuma mudança na aplicação remove essa exposição.

Por fim, este repositório não publica resultado de auditoria. Os controles acima são os implementados no código, descritos a partir do código, e vários deles são cobertos por testes de integração que rodam contra PostgreSQL e Redis reais. Isso é evidência de intenção e de comportamento sob teste, não prova de ausência de defeito.

## Reportando um problema

Este é um repositório de portfólio, sem ambiente implantado associado. Se você encontrar um problema nos exemplos publicados ou na descrição do design, abra uma issue neste repositório ou fale com o autor pelo perfil linkado no README. Não teste nada contra serviço ativo; não há nada aqui contra o que testar.
