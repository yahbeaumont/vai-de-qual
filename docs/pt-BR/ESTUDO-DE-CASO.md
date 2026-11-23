# Estudo de caso: de uma página de 2 MB a um ledger

## O ponto de partida

Em agosto de 2026 a marca entregou uma comunidade de análise esportiva. Tipsters publicavam palpites, assinantes pagavam pelo acesso, e a aplicação inteira era um arquivo HTML por superfície: cerca de 2 MB de marcação, estilos, roteamento e regras de negócio em um único documento, com Cloud Functions chamadas pelo navegador. O repositório tinha 280 arquivos e cerca de 55,000 linhas em 135 commits. Para um produto de conteúdo com acesso pago, esse formato era barato de construir e foi entregue.

Dois meses depois o produto seguinte era uma plataforma de apostas regulada, e esse formato não conseguia carregá-la. O produto de comunidade não tinha carteira nenhuma: o acesso pago era uma flag no registro do usuário. Uma plataforma em que jogadores depositam, apostam e sacam precisa de um saldo que possa ser gasto, limitado e auditado, e o documento antigo não oferecia nada sobre o que construir isso. Não havia diário para reconstruir uma movimentação, nem fronteira transacional onde uma invariante pudesse viver, nem lugar onde um pagamento pudesse ser confirmado por algo além de um navegador voltando de uma página de checkout com um identificador na URL. A autorização vivia no mesmo documento da interface, então o painel de admin era protegido por uma checagem no cliente contra o registro do usuário.

Abaixo dessas três havia uma quarta: os bundles implantados não podiam ser ligados de volta a um commit. Arquivos tinham sido editados no lugar, copiados entre branches, e servidos por um rewrite de hospedagem que apontava para um artefato mais antigo, então nenhuma regra tinha origem rastreável.

## Restrições

O trabalho não podia ser um refactor, e também não podia ser um exercício greenfield. A marca, a audiência e o modelo de conteúdo continuavam, então o produto antigo era referência de comportamento e de voz, não especificação de dinheiro. O novo domínio impõe requisitos duros: cada movimentação de dinheiro tem de ser reconstruível, a superfície administrativa tem de ser uma zona de segurança separada, e o fluxo de pagamento não pode depender de um cliente dizendo a verdade. A equipe era pequena, então a arquitetura tinha de caber em uma ou duas cabeças.

A stack seguiu dessas restrições: PostgreSQL para transações, constraints `CHECK` e aritmética inteira exata; Redis para sessões e contadores de rate limit com TTL; NestJS para fronteiras de módulo e guards; Prisma para migrations revisáveis; exportação estática do Next.js porque o front end não precisa de runtime de servidor, e todo processo não implantado é um processo a menos para corrigir.

## O que foi construído

A geração atual tem 360 arquivos e cerca de 52,000 linhas em 67 commits, com 22 arquivos de teste. A API são 13 módulos de funcionalidade, 48 rotas HTTP e 22 migrations sobre 13 modelos. O front end é uma exportação estática com um build separado para o portal administrativo. O dinheiro se move apenas por um ledger de partidas dobradas. Depósitos são creditados apenas por um webhook assinado. As sessões são no servidor, opacas e versionadas. Seis suítes de distribuição de aleatoriedade rodam um milhão de amostras cada, em uma agenda noturna.

## Os quatro problemas difíceis

### Um saldo que sobrevive à concorrência

A primeira tentativa checava o saldo dentro da função de lançamento. Um teste de concorrência com débitos paralelos mostrou a falha: duas transações leem o mesmo valor, ambas concluem que há espaço, e ambas escrevem. Um lock resolveu para os chamadores que pegavam o lock, e não fez nada por um script de migration que esqueceu.

O desenho levou a invariante para o banco de dados. As carteiras de jogadores são contas de passivo com uma flag, e uma constraint `CHECK` proíbe saldo armazenado positivo em uma conta marcada, dada uma convenção de sinal em que um crédito ao jogador é um lançamento negativo. A função de lançamento passa a ter um único modo de falha: a constraint rejeita o update, o driver reporta SQLSTATE `23514`, e isso se torna um erro de saldo insuficiente e um 422. Nada é cortado e nada é reparado.

Dois detalhes saíram disso. Os saldos são atualizados em ordem determinística por código de conta, porque lançamentos que tocam o mesmo par em ordens opostas geram deadlock, e um deadlock dentro de uma aposta é uma rodada perdida. A reconciliação virou um CLI que recalcula cada saldo materializado a partir dos seus lançamentos e reporta a diferença sem corrigi-la.

### O problema da verdade nos pagamentos

O fluxo de depósito parece simples até que os modos de falha sejam listados: o jogador fecha a aba, volta duas vezes, volta sem pagar, paga depois que a sessão expirou, ou o webhook chega duas vezes.

O desenho que sobreviveu trata o webhook como o único evento que movimenta dinheiro, e faz o registro local existir antes de qualquer chamada de rede: uma linha de depósito é commitada primeiro, depois uma sessão de checkout é solicitada. O header `Idempotency-Key` é obrigatório, e seu índice único transforma uma requisição duplicada em uma leitura da linha original. A mesma chave com um valor diferente é um conflito, e uma colisão durante a corrida de inserção é retentável porque a primeira transação pode não ter feito commit.

O handler verifica a assinatura sobre o corpo bruto, bloqueia o usuário e o depósito, reconfere que o status ainda é pendente, lança a transação no ledger com uma chave derivada da sessão do provedor, e marca o depósito como pago na mesma transação. Um replay encontra o status não mais pendente e retorna 200 sem tocar no ledger. A sessão de checkout e a cobrança Pix expiram em relógios separados, porque começam em momentos diferentes.

### A superfície de segurança de um front end estático

Um front end estático em um host, uma API em outro, um portal administrativo em um terceiro e uma API pública alcançável de qualquer lugar é uma combinação em que a configuração padrão está errada. A reescrita substituiu as checagens de admin no cliente por um guard de papel, e depois adicionou um guard de origem em cada rota de admin: um header `Origin` igual à origem de admin configurada, em leituras e em escritas, falhando fechado.

As sessões se tornaram tokens opacos em Redis com um contador de versão na linha do usuário, então um bloqueio ou um logout invalida todos os dispositivos. Isso criou um problema que a primeira geração nunca teve: duas abas, uma das quais fez logout e login como outra conta. As mutações de jogo agora carregam o id de usuário que o cliente acredita ter, e uma divergência é um conflito.

O header de origem não é um segredo. O guard é defesa em profundidade; os controles reais são a sessão, o papel e o log de auditoria.

### Migrar sem uma cadeia de proveniência

A reconstrução começou vazia com uma regra: nada do código histórico entra no caminho ativo até que sua origem, commit, hash, classificação e motivo de reuso estejam registrados. A fundação foram 24 arquivos e 15 commits de governança e fronteiras de diretório, e sua principal saída foi uma matriz de componentes rotulados como confirmed, partial ou unproven. Os front ends saíram como unproven, então o trabalho visual foi reconstruído contra um alvo fixo; as funções de backend saíram como partial, então foram reescritas com o mesmo comportamento e um formato diferente. Isso converteu "achamos que é isso que ele faz" em afirmações com evidência.

## O que mudou no caminho

Duas abordagens foram abandonadas no meio do percurso. A checagem de saldo saiu da aplicação para o banco de dados depois de um teste de concorrência, não depois de uma revisão. A expiração do depósito era um valor único até os dois relógios do provedor deixarem claro que um número não conseguia descrever os dois. A estratégia de testes também mudou: os testes iniciais mockavam o banco e passavam enquanto as constraints estavam erradas, então as suítes que importam rodam contra PostgreSQL e Redis reais e afirmam uma constraint violando-a.

## O que eu faria diferente

Começar pelo ledger e pelo CLI de reconciliação antes de qualquer funcionalidade de produto, incluindo autenticação. O ledger é do que todo módulo depende, e construí-lo depois significou reescrever código de carteira que cresceu em torno de uma premissa mais simples.

Escrever a máquina de estados do depósito como uma tabela de estados, eventos e efeitos antes do handler; as transições foram descobertas enquanto eram codificadas, o que custou tempo.

Colocar prazo no trabalho de proveniência e decidir de antemão quais componentes valem ser provados. Provar os front ends foi certo, mas a investigação passou do valor que retornou. E não entregar um produto como um único arquivo HTML: foi barato de implantar e caro de deixar.

## O que este repositório não contém

A camada comercial é omitida como um todo: a matemática dos jogos, os parâmetros de retorno e de margem, as fórmulas de odds e payout, as regras de bônus e rollover e os valores de limite. É a parte com o incentivo mais direto a ser copiada sem os controles ao redor dela, e um conjunto de regras parcialmente redigido continua sendo um conjunto de regras. O que resta é a engenharia que tornou essas regras seguras de rodar: como o dinheiro é registrado, como um pagamento se torna saldo, e como uma sessão é confiável.
