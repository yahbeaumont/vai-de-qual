# Estudo de caso: de uma página de 2 MB a um ledger

## O ponto de partida

Em agosto de 2026 a marca entregou uma comunidade de futebol. Torcedores e analistas publicavam posts e análises de partida, leitores os seguiam, comentavam, salvavam o que queriam ler de novo, e parte do conteúdo ficava atrás de acesso pago. A aplicação inteira era um arquivo HTML por superfície: cerca de 2 MB de marcação, estilos, roteamento e regras de negócio em um único documento, com Cloud Functions chamadas pelo navegador. O repositório tinha 280 arquivos e cerca de 55 mil linhas em 135 commits. Para uma comunidade de conteúdo, esse formato era barato de construir e chegou ao ar.

Dois meses depois a mesma comunidade precisou carregar dinheiro, e o formato não dava conta. Acesso pago era um booleano no registro do usuário: nenhum diário, nenhuma fronteira transacional, nenhum lugar onde uma invariante pudesse morar. A confirmação de pagamento não tinha fronteira confiável, porque o navegador voltava da página de checkout com um identificador na URL. A autorização morava no mesmo documento da interface, então o painel de admin era protegido por uma checagem no cliente contra o registro do usuário.

Abaixo dessas três havia uma quarta: os bundles publicados não voltavam para um commit. Arquivos tinham sido editados no lugar, copiados de uma branch para outra e servidos por um rewrite de hospedagem que apontava para um artefato mais antigo, então nenhuma regra tinha origem rastreável.

## Restrições

O trabalho não podia ser um refactor, e também não podia ser um exercício greenfield. A marca, a audiência e o modelo de conteúdo continuavam, então o produto antigo servia de referência de comportamento e de voz, não de especificação de dinheiro. A camada nova impõe requisitos duros: toda movimentação de dinheiro tem de ser reconstruível, a superfície administrativa tem de ser uma zona de segurança separada, o fluxo de pagamento não pode depender da palavra do cliente, e o acesso ao conteúdo pago tem de sobreviver a um reload, a um segundo dispositivo e a um plano que venceu sem ninguém olhar. A equipe era pequena, então a arquitetura tinha de caber em uma ou duas cabeças.

A stack saiu dessas restrições: PostgreSQL para transações, constraints `CHECK` e aritmética inteira exata; Redis para sessões e contadores de rate limit com TTL; NestJS para fronteiras de módulo e guards; Prisma para migrations revisáveis; exportação estática do Next.js porque o front end não precisa de runtime de servidor, e todo processo que não vai para produção é um processo a menos para corrigir.

## O que foi construído

A geração atual é uma exportação estática com um build separado para o portal administrativo, uma API NestJS dividida por funcionalidade, PostgreSQL como ledger de registro, Redis para sessões e rate limits, e Stripe para pagamento de planos e de créditos. O dinheiro só se move por um ledger de partidas dobradas. Uma compra só é confirmada por um webhook assinado. O acesso ao conteúdo premium é um entitlement com período no lugar de uma flag, gravado na mesma transação do pagamento que o comprou. As sessões são no servidor, opacas e versionadas. Um job de reconciliação recalcula todo saldo materializado a partir dos seus lançamentos e reporta o que não fecha. As métricas internas desta geração não são publicadas aqui; a fundação sobre a qual ela foi escrita tinha 24 arquivos e 15 commits.

## Os quatro problemas difíceis

### Um saldo que sobrevive à concorrência

A primeira tentativa checava o saldo dentro da função de lançamento. Um teste de concorrência com resgates paralelos mostrou a falha: duas transações leem o mesmo valor, as duas concluem que há folga, e as duas escrevem. Um lock resolveu o caso de quem pegava o lock, e não fez nada por um script de migration que esqueceu de pegar.

O desenho levou a invariante para o banco. Contas de crédito são contas de passivo com uma flag, e uma constraint `CHECK` proíbe saldo armazenado positivo em conta marcada, dada uma convenção de sinal em que um crédito ao usuário é lançamento negativo. A função de lançamento passa a ter um único modo de falha: a constraint rejeita o update, o driver reporta SQLSTATE `23514`, e isso vira erro de saldo insuficiente e 422. Nada é cortado e nada é reparado.

Dois detalhes saíram daí. Os saldos são atualizados em ordem fixa por código de conta, porque lançamentos que tocam o mesmo par em ordens opostas geram deadlock, e um deadlock dentro de um checkout é uma compra perdida. A reconciliação virou um CLI que recalcula cada saldo materializado a partir dos lançamentos e reporta a diferença sem corrigi-la.

### O problema da verdade nos pagamentos

O fluxo de compra parece simples até a lista de modos de falha: o comprador fecha a aba, volta duas vezes, volta sem pagar, paga depois que a sessão expirou, ou o webhook chega duas vezes.

O desenho que sobreviveu trata o webhook como o único evento que movimenta dinheiro, e faz o registro local existir antes de qualquer chamada de rede: uma linha de compra é commitada primeiro, e só depois a sessão de checkout é pedida. O header `Idempotency-Key` é obrigatório, e o índice único transforma requisição duplicada em leitura da linha original. A mesma chave com payload diferente é conflito, e uma colisão na corrida de inserção é retentável porque a primeira transação pode não ter feito commit.

O handler verifica a assinatura sobre o corpo bruto, bloqueia o usuário e a compra, reconfere que o status ainda é pendente, lança a transação no ledger com uma chave derivada da sessão do provedor, e marca a compra como paga e grava o entitlement na mesma transação. Um replay encontra o status já não pendente e responde 200 sem tocar no ledger.

### A superfície de segurança de um front end estático

Um front end estático em um host, uma API em outro, um portal administrativo em um terceiro e uma API pública alcançável de qualquer lugar formam uma combinação em que a configuração padrão está errada. A reescrita trocou as checagens de admin no cliente por um guard de papel, e depois somou um guard de origem em toda rota de admin: header `Origin` igual à origem de admin configurada, em leitura e em escrita, e falha fechado.

As sessões viraram tokens opacos em Redis com um contador de versão na linha do usuário, então um bloqueio ou um logout invalida todos os dispositivos. Isso criou um problema que a primeira geração nunca teve: duas abas abertas, uma delas já com outra conta depois de um logout e login. As mutações de conteúdo e de pagamento agora carregam o id de usuário que o cliente acredita ter, e divergência é conflito.

O header de origem não é segredo. O guard é defesa em profundidade; os controles reais são a sessão, o papel e o log de auditoria.

### Migrar sem cadeia de proveniência

A reconstrução começou vazia com uma regra: nada do código histórico entra no caminho ativo até origem, commit, hash, classificação e motivo de reuso estarem registrados. A fundação foram 24 arquivos e 15 commits de governança e fronteiras de diretório, e sua saída principal foi uma matriz de componentes rotulados como confirmed, partial ou unproven. Os front ends saíram como unproven, então o trabalho visual foi refeito contra um alvo fixo; as funções de backend saíram como partial, então foram reescritas com o mesmo comportamento e outro formato. Isso converteu "achamos que é isso que ele faz" em afirmações com evidência.

## O que mudou no caminho

Duas abordagens foram abandonadas no meio. A checagem de saldo saiu da aplicação para o banco depois de um teste de concorrência, não depois de uma revisão. O acesso pago era um booleano até a primeira renovação: booleano não responde até quando, não dá para auditar contra um pagamento e não representa duas concessões que se sobrepõem, então virou uma linha de entitlement com origem e período. A estratégia de teste também mudou: os testes iniciais mockavam o banco e passavam enquanto as constraints estavam erradas, então as suítes que importam rodam contra PostgreSQL e Redis reais e afirmam uma constraint violando-a.

## O que eu faria diferente

Começar pelo ledger e pelo CLI de reconciliação antes de qualquer funcionalidade de produto, inclusive autenticação. O ledger é o que todo módulo usa, e construí-lo depois significou reescrever código de conta que cresceu em torno de uma premissa mais simples.

Escrever a máquina de estados da compra como uma tabela de estados, eventos e efeitos antes do handler; as transições foram descobertas enquanto eu as codificava, o que custou tempo. Modelar o entitlement antes da primeira tela premium, não depois da primeira reclamação de plano que venceu cedo.

Colocar prazo no trabalho de proveniência e decidir de antemão quais componentes valem ser provados. Provar os front ends foi certo, mas a investigação passou do valor que devolveu. E não entregar um produto como um único arquivo HTML: foi barato de colocar no ar e caro de deixar assim.

## O que este repositório não contém

A camada comercial é omitida como um todo: o catálogo de planos e seus preços, as regras de entitlement que decidem o que cada plano libera, o cálculo da fatia do criador, o texto da política de moderação e os valores de limite. É a parte com o incentivo mais direto a ser copiada sem os controles ao redor, e um conjunto de regras parcialmente redigido continua sendo um conjunto de regras. O que resta é a engenharia que tornou essas regras seguras de rodar: como o dinheiro é registrado, como um pagamento vira acesso, e como uma sessão é confiável.
