# Decisões

Sete registros. Cada um é uma decisão que moldou a geração atual, escrita depois do fato, com as alternativas que estavam realmente na mesa. As datas são a fase em que a decisão foi tomada, não a data da escrita.

---

## ADR-001: Um ledger de partidas dobradas com saldo materializado

**Fase:** novembro de 2026, primeiras semanas da reescrita.

**Contexto.** O produto de comunidade não tinha carteira. O acesso pago era uma flag no registro do usuário, então não havia saldo a proteger nem histórico a reconstruir. A plataforma de apostas introduz um saldo que pode ser gasto, e com ele a questão de onde a invariante vive.

**Decisão.** Cada movimentação de dinheiro é uma transação composta de pelo menos dois lançamentos em contas distintas, cujos valores com sinal somam zero. As contas seguem um plano de quatro classes (ativos, passivos, receita, despesas) com subcontas por prefixo de código. Uma única função lança transações: ela valida o conjunto de lançamentos, atualiza o saldo armazenado de cada conta na mesma transação de banco, e anexa os lançamentos. As carteiras dos jogadores são contas de passivo cujo saldo é o negativo dos fundos disponíveis do jogador, o que mantém a convenção de sinal consistente em todo o plano. O saldo armazenado é, portanto, uma projeção do diário, mantida em tempo de escrita, e um job de reconciliação recalcula a projeção a partir dos lançamentos para detectar divergência.

**Alternativas consideradas.** Uma única coluna `balance` com uma tabela de auditoria append-only foi rejeitada porque a tabela de auditoria seria um log, não um registro: nada a obrigaria a concordar com o saldo. Derivar o saldo dos lançamentos em cada leitura foi rejeitado porque o caminho quente é uma aposta, e uma agregação sobre um diário crescente ficaria dentro da transação que detém o lock do usuário. Fazer event sourcing de toda a carteira foi rejeitado por ser uma mudança maior do que o produto precisava.

**Consequências.** As leituras são uma única busca de linha, e a invariante tem um único ponto de imposição. O custo é um fato duplicado: o saldo e o diário podem discordar se algo escrever o saldo fora da função de lançamento, então o job de reconciliação é obrigatório e não opcional, e ele reporta em vez de reparar. Adicionar um novo tipo de movimentação significa escolher contas e um prefixo de chave, não escrever nova aritmética de saldo, que é a parte que fez a decisão valer a pena durante o trabalho nos jogos.

---

## ADR-002: Colocar a invariante de saldo no banco de dados, não apenas na aplicação

**Fase:** novembro de 2026, durante o marco do ledger.

**Contexto.** Uma checagem no código da aplicação protege os caminhos que lembram de chamá-la. A carteira já havia produzido uma classe de bugs em que um caminho de código debitava uma aposta sem reconferir o saldo, e o modo de falha era um saldo disponível negativo que só aparecia depois. Com uma única função de lançamento o risco diminui mas não desaparece: um novo módulo de jogo, um script de migration ou um ajuste manual ainda pode construir um lançamento que estoure o saldo de um jogador.

**Decisão.** A invariante vive no PostgreSQL. As contas de carteira de jogador carregam uma flag, e uma constraint `CHECK` exige que uma conta marcada nunca tenha saldo positivo, dada a convenção de sinal do ADR-001. Qualquer lançamento que estoure o saldo de um jogador falha na constraint. A função de lançamento reconhece o SQLSTATE `23514` nessas constraints, inclusive quando o driver o envolve em um erro aninhado, e o traduz em um erro de saldo insuficiente que a camada HTTP mapeia para um 422. Nada é cortado, nenhum saldo é ajustado à força, e a transação sofre rollback por inteiro. Uma segunda constraint faz o mesmo para a subconta de bônus. O estado de rodada e a forma do tabuleiro têm constraints pelo mesmo motivo: combinações ilegais não podem ser persistidas nem por um escritor com bug.

**Alternativas consideradas.** Checar o saldo dentro da função de lançamento com um `SELECT` antes do update foi rejeitado porque reintroduz a corrida de ler-depois-escrever, a menos que a leitura seja um lock, e porque protege apenas os chamadores daquela função. Um trigger foi rejeitado por ser mais difícil de revisar e mais fácil de desativar do que uma constraint. Contar com uma reconciliação noturna para pegar overdrafts foi rejeitado de imediato: a reconciliação é um detector, não um controle.

**Consequências.** O caminho de erro é menos óbvio: uma violação de constraint chega como erro de driver e precisa ser mapeada com cuidado, ou aparece como um 500. O retorno é que a invariante vale para todo escritor, incluindo migrations e scripts avulsos, e que a suíte de testes pode afirmá-la tentando um overdraft em vez de mockar um service. Também torna a convenção de sinal estrutural, então ela é documentada em um único lugar e verificada em tempo de leitura: o endpoint da carteira se recusa a servir um saldo com o sinal errado em vez de retornar um número negativo.

---

## ADR-003: Apenas um webhook verificado credita um depósito

**Fase:** novembro de 2026, marco de pagamentos.

**Contexto.** O provedor de pagamento redireciona o navegador de volta para a aplicação com um identificador de sessão na URL. Esse redirecionamento é o sinal mais conveniente disponível e o menos confiável: ele pode sofrer replay, ser forjado, disparado sem pagamento, ou perdido quando o jogador fecha a aba. O produto já havia sido desenhado com checkout hospedado, então o dinheiro é cobrado fora da aplicação e o único sinal autoritativo é um evento assinado.

**Decisão.** O ciclo de vida do depósito é uma máquina de estados: pending, paid, failed, expired. Um depósito é criado e commitado antes de a sessão de checkout ser solicitada, então o registro local sempre existe primeiro. A requisição exige um header `Idempotency-Key`, armazenado sob um índice único; a mesma chave com o mesmo payload retorna o depósito original, a mesma chave com um payload diferente retorna 409, e uma corrida de chave duplicada é resolvida lendo a linha de volta, com um miss de busca tratado como erro retentável e não como sucesso. A única transição para paid acontece no handler do webhook, depois de uma checagem de assinatura HMAC sobre o corpo bruto da requisição, e apenas quando o depósito armazenado ainda está pendente e o provedor reporta a sessão como paga. O handler bloqueia o usuário e o depósito, lança a transação no ledger com uma chave derivada do id da sessão do provedor, e marca o depósito como pago na mesma transação. Uma sessão concluída com status não pago permanece pendente, porque a confirmação do Pix pode chegar depois.

**Alternativas consideradas.** Creditar no redirecionamento e reconciliar depois foi rejeitado porque torna o cliente a fonte de verdade do dinheiro. Fazer polling no provedor a partir da API em um timer foi rejeitado porque duplica a máquina de retentativas do provedor e adiciona um agendador a um sistema que de outra forma não tem nenhum. Creditar em qualquer evento que mencione a sessão foi rejeitado porque os tipos de evento diferem em significado e alguns chegam antes da liquidação.

**Consequências.** Os depósitos ficam pendentes até que um evento chegue, então um webhook que nunca é entregue deixa dinheiro no limbo até a reconciliação, e o endpoint precisa ser público e estar corretamente configurado por ambiente. Replays são baratos: a chave do ledger os absorve, e a checagem de status torna uma segunda transição um no-op. Os modos de falha ficam visíveis na linha do depósito e não em um saldo, e é isso que torna as conversas de suporte tratáveis.

---

## ADR-004: Tratar a janela do checkout e a janela do Pix como dois relógios

**Fase:** novembro de 2026, marco de pagamentos.

**Contexto.** O provedor expõe duas expirações que parecem similares e não são. A sessão de checkout tem uma expiração definida quando é criada. A cobrança Pix tem sua própria expiração, contada a partir do momento em que o payment intent é confirmado, o que acontece depois que o jogador abre a página de pagamento. Um único valor de "expira em" na aplicação estaria errado para uma delas, e um único evento de expiração rotularia depósitos de forma errada e silenciosa.

**Decisão.** Os dois relógios são definidos de forma explícita e independente, cada um em 30 minutos, e a API armazena a expiração da sessão de checkout como o valor que retorna ao cliente. A expiração do Pix é configurada nas opções do método de pagamento, não derivada. A máquina de estados tem transições separadas para um pagamento concluído, um pagamento falho e uma sessão expirada, e a transição de expirada nunca credita. O front end mostra a expiração da sessão porque é essa a janela em que o jogador está de fato.

**Alternativas consideradas.** Uma única expiração calculada como a mais cedo das duas foi rejeitada porque expiraria depósitos cuja cobrança Pix ainda é pagável, e porque a aplicação não consegue observar o relógio do Pix diretamente. Estender a janela do checkout ao máximo permitido e ignorar a janela do Pix foi rejeitado porque mostraria aos jogadores uma contagem regressiva que não corresponde à cobrança que eles estão pagando.

**Consequências.** Dois valores para armazenar, duas transições para testar, e uma carga de documentação que este registro existe para carregar. Em troca, a semântica de expiração corresponde ao provedor em vez de aproximá-lo, e a consulta de reconciliação consegue distinguir uma sessão que expirou de uma cobrança que falhou, o que importa quando um jogador afirma que pagou dentro da janela.

---

## ADR-005: Uma allowlist exata de Origin para a superfície administrativa

**Fase:** novembro de 2026, marco do backoffice.

**Contexto.** O portal administrativo é um build estático em seu próprio hostname, a API está em outro, e o cookie de sessão é enviado com credenciais. A primeira geração checava o papel de admin no navegador, o que não é uma fronteira. Mesmo com um guard de papel no servidor, um cookie de admin válido pode ser usado a partir de uma página em outra origem se a API aceitar requisições cross-origin de qualquer lugar, e o risco é assimétrico: um jogador perdendo uma aposta é um ticket de suporte, uma sessão de operador sendo conduzida por uma página de terceiros é um incidente.

**Decisão.** Dois controles independentes. O CORS usa uma allowlist exata de origens com credenciais habilitadas, nunca um wildcard e nunca correspondência por sufixo, então apenas os front ends configurados conseguem ler respostas. Sobre isso, todo controller de admin exige um header `Origin` exatamente igual à origem de admin configurada, em leituras e em escritas, então uma requisição forjada de outra origem é rejeitada mesmo quando carrega uma sessão válida. A comparação é contra a configuração, não contra um eco do header da requisição, e um header ausente é uma rejeição, não uma aprovação. O guard de papel de admin também roda; o guard de origem é adicional, não substituto.

**Alternativas consideradas.** Contar com `SameSite=Strict` para o cookie de admin foi rejeitado porque quebraria a navegação pretendida a partir do site do jogador e porque atributos de cookie são política de navegador, não decisão de autorização. Um token CSRF por formulário de admin foi considerado e mantido como adição futura, mas a checagem de origem cobre a mesma classe de ataque com menos estado e também se aplica a GET. Checar apenas em escritas foi rejeitado: leituras de admin expõem dados de usuários e do ledger.

**Consequências.** O header de origem é uma convenção de navegador, não um segredo, então um cliente que não é navegador pode enviar o valor que quiser. O guard, portanto, assume que o navegador impõe a origem em requisições cross-site e não defende contra um cliente que mente; é por isso que o guard de papel, a versão de sessão e o log de auditoria continuam no lugar. Operacionalmente, deploys de preview e hostnames alternativos precisam de configuração explícita, e uma origem de admin mal configurada falha fechada com um 403 em vez de degradar em silêncio.

---

## ADR-006: Dividir o monólito em módulos em torno de um único caminho de dinheiro

**Fase:** novembro de 2026, início da reescrita.

**Contexto.** O produto de comunidade era um arquivo HTML por superfície com as regras embutidas, e Cloud Functions que faziam cada uma a sua própria persistência. A plataforma transacional tinha de ser construída com fronteiras visíveis: autenticação, carteira, pagamentos, saques, jogos, backoffice. O risco de uma divisão em módulos é a modularidade cosmética, em que os diretórios mudam e o acoplamento não.

**Decisão.** A API é dividida por funcionalidade, com um módulo por jogo e módulos compartilhados para ledger, wallet, payments e auth. A regra que torna a divisão real é que dinheiro tem exatamente um caminho: nenhum módulo escreve um saldo, e toda movimentação passa pelo serviço de ledger com uma chave e um tipo. Os módulos de jogo são donos da sua aleatoriedade, regras e persistência, mas chamam a mesma função de lançamento dentro da sua própria transação. Os guards são globais onde a regra é global (sessão) e locais onde a regra é local (papel de admin, origem de admin, chave interna). O módulo de ledger não tem dependência de payments ou de games, e é isso que permite que o CLI de reconciliação seja um entry point simples.

**Alternativas consideradas.** Uma divisão em camadas (controllers, services, repositories) foi rejeitada porque agrupa por papel técnico e deixa o caminho do dinheiro espalhado entre camadas. Manter os jogos em um único módulo com um discriminador `game` foi rejeitado depois dos dois primeiros jogos, quando os condicionais começaram a se multiplicar no código de liquidação. Um serviço separado por contexto delimitado (payments como seu próprio artefato de deploy) foi rejeitado como sobrecarga operacional que a equipe não conseguiria carregar neste tamanho.

**Consequências.** Mais arquivos, mais fiação de módulos, e um risco real de imports circulares entre jogos e carteira, e é por isso que o ledger fica abaixo dos dois. O benefício aparece nos testes: a suíte do ledger roda contra o banco sem um jogo, as suítes dos jogos rodam sem pagamentos, e a suíte de pagamentos exercita o webhook com um payload assinado. Também dá a cada jogo seus próprios rate limits e constantes, do que o produto precisava porque os jogos falham de formas diferentes.

---

## ADR-007: Reconstruir a partir da proveniência em vez de copiar adiante

**Fase:** setembro a novembro de 2026, fundação da reconstrução.

**Contexto.** Os bundles implantados do produto de comunidade não podiam ser mapeados de volta a um commit com confiança. Arquivos tinham sido editados no lugar, copiados entre branches, e servidos a partir de um rewrite de hospedagem que apontava para um artefato mais antigo. Em um domínio regulado, "esta regra veio de algum lugar" não é uma resposta aceitável, e uma reescrita que copia código não verificado herda a mesma incerteza com um timestamp novo.

**Decisão.** O repositório de reconstrução começou quase vazio: 24 arquivos e 15 commits de governança, fronteiras de diretório e regras de reuso antes de qualquer código de funcionalidade. Cada arquivo candidato do repositório histórico tinha de registrar sua origem, commit, hash, classificação e motivo de reuso antes de entrar no caminho ativo. O que não pudesse ser estabelecido permanecia rotulado como não comprovado e fora do caminho. O repositório histórico foi preservado intacto como referência, e o alvo visual foi fixado para que uma reescrita não pudesse derivar para um redesign. A geração atual foi então escrita contra essas fronteiras, com o ledger e o fluxo de pagamento desenhados primeiro.

**Alternativas consideradas.** Continuar no repositório histórico com uma branch de limpeza foi rejeitado porque o artefato implantado não podia ser ligado a um commit, então a limpeza não resolveria o problema de proveniência. Copiar o HTML e refatorar no lugar foi rejeitado pelo mesmo motivo mais o tamanho do arquivo. Uma reescrita greenfield completa e sem referência foi rejeitada porque o comportamento do produto, incluindo seus casos de borda, era a especificação.

**Consequências.** Semanas de trabalho antes da primeira funcionalidade, e código que teve de ser reescrito em vez de reusado, incluindo regras que provavelmente funcionavam. A fundação também criou documentação que precisa ser mantida e um processo de governança que desacelera mudanças pequenas. O que ela comprou é uma base de código em que cada regra tem um dono, uma fase e um teste, que é a propriedade que tornou possível revisar o trabalho posterior de ledger e de segurança.
