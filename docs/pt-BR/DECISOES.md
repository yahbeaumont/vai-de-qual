# Decisões

Sete registros. Cada um é uma decisão que moldou a geração atual, escrita depois do fato, com as alternativas que estavam de fato na mesa. As datas indicam a fase em que a decisão foi tomada, não a data da escrita.

---

## ADR-001: Um ledger de partidas dobradas com saldo materializado

**Fase:** novembro de 2026, primeiras semanas da reescrita.

**Contexto.** O produto de comunidade não tinha saldo. Acesso pago era um booleano no registro do usuário, então não havia saldo a proteger nem histórico a reconstruir. A segunda geração vende planos, vende créditos e paga criadores, o que traz dinheiro que entra antes de o conteúdo ser consumido e dinheiro que sai para outra pessoa. Junto com ele vem a pergunta sobre onde a invariante mora.

**Decisão.** Toda movimentação de dinheiro é uma transação composta de pelo menos dois lançamentos em contas distintas, cujos valores com sinal somam zero. As contas seguem um plano de quatro classes (ativos, passivos, receita, despesas), com subcontas por prefixo de código. Uma única função lança transações: valida o conjunto de lançamentos, atualiza o saldo armazenado de cada conta na mesma transação de banco e anexa os lançamentos. A conta de crédito de um usuário é um passivo cujo saldo é o negativo do que ele pode gastar, o que mantém a convenção de sinal igual em todo o plano, e a conta a pagar de um criador segue a mesma convenção para o que a plataforma deve. O saldo armazenado é, portanto, projeção do diário, mantida em tempo de escrita, e um job de reconciliação recalcula a projeção a partir dos lançamentos para detectar desvio.

**Alternativas consideradas.** Uma coluna `balance` única com tabela de auditoria append-only foi rejeitada porque a tabela seria um log, não um registro: nada a obrigaria a concordar com o saldo. Derivar o saldo dos lançamentos em toda leitura foi rejeitado porque o caminho quente é uma leitura premium ou um resgate de crédito, e uma agregação sobre um diário crescente ficaria dentro da transação que detém o lock do usuário. Fazer event sourcing da conta inteira foi rejeitado por ser uma mudança maior do que o produto pedia.

**Consequências.** As leituras são uma busca de linha, e a invariante tem um único ponto de imposição. O custo é um fato duplicado: saldo e diário podem discordar se algo escrever o saldo fora da função de lançamento, e por isso o job de reconciliação é obrigatório, não opcional, e reporta em vez de reparar. Adicionar um tipo novo de movimentação significa escolher contas e um prefixo de chave, não escrever aritmética de saldo nova. Essa parte se pagou quando os repasses a criadores chegaram algumas semanas depois.

---

## ADR-002: Colocar a invariante de saldo no banco, não só na aplicação

**Fase:** novembro de 2026, durante o marco do ledger.

**Contexto.** Uma checagem no código da aplicação protege os caminhos que lembram de chamá-la. A camada de crédito já tinha produzido uma classe de bugs em que um caminho resgatava créditos sem reconferir o saldo, e o modo de falha era uma conta de crédito em que a plataforma devia mais do que tinha arrecadado, visível só em um extrato que ninguém lia. Com uma única função de lançamento o risco diminui, mas não desaparece: um módulo novo, um script de migration ou um ajuste manual ainda consegue montar um lançamento que estoure uma conta.

**Decisão.** A invariante mora no PostgreSQL. As contas de crédito carregam uma flag, e uma constraint `CHECK` exige que conta marcada nunca tenha saldo positivo, dada a convenção de sinal do ADR-001. Qualquer lançamento que estoure o saldo de um usuário falha na constraint. A função de lançamento reconhece o SQLSTATE `23514` nessas constraints, inclusive quando o driver o envolve em erro aninhado, e o traduz em erro de saldo insuficiente, que a camada HTTP mapeia para 422. Nada é cortado, nenhum saldo é ajustado no braço, e a transação sofre rollback inteira. Uma segunda constraint aplica a mesma regra às contas a pagar de criadores, então um repasse maior do que o criador ganhou também não é persistido. Períodos de entitlement e estados de compra têm constraints pelo mesmo motivo: combinação ilegal não é persistida nem por um escritor com bug.

**Alternativas consideradas.** Checar o saldo dentro da função com um `SELECT` antes do update foi rejeitado porque reintroduz a corrida de ler e depois escrever, a menos que a leitura seja um lock, e porque protege só os chamadores daquela função. Um trigger foi rejeitado por ser mais difícil de revisar e mais fácil de desligar do que uma constraint. Contar com reconciliação noturna para pegar estouro foi rejeitado de saída: reconciliação é detector, não controle.

**Consequências.** O caminho de erro fica menos óbvio: violação de constraint chega como erro de driver e precisa ser mapeada com cuidado, ou aparece como 500. Em troca, a invariante vale para todo escritor, incluindo migrations e scripts avulsos, e a suíte de testes consegue afirmá-la tentando um estouro em vez de mockar um service. A convenção de sinal também passa a ser estrutural, então está documentada em um lugar só e verificada na leitura: o endpoint da conta se recusa a servir saldo com o sinal errado em vez de devolver número negativo para a interface.

---

## ADR-003: Só um webhook verificado ativa um plano pago

**Fase:** novembro de 2026, marco de pagamentos.

**Contexto.** O provedor de pagamento redireciona o navegador de volta para a aplicação com um identificador de sessão na URL. Esse redirecionamento é o sinal mais conveniente disponível e o menos confiável: dá para reenviar em replay, forjar, acionar sem pagamento, ou perder quando o comprador fecha a aba. O produto já tinha sido desenhado com checkout hospedado, então o dinheiro é cobrado fora da aplicação e o único sinal autoritativo é um evento assinado.

**Decisão.** O ciclo de vida da compra é uma máquina de estados: pending, paid, failed, expired. Uma compra é criada e commitada antes de a sessão de checkout ser pedida, então o registro local sempre existe primeiro. A requisição exige um header `Idempotency-Key`, guardado sob índice único; a mesma chave com o mesmo payload devolve a compra original, a mesma chave com payload diferente devolve 409, e uma corrida de chave duplicada é resolvida lendo a linha de volta, com um miss de busca tratado como erro retentável e não como sucesso. A única transição para pago acontece no handler do webhook, depois de uma checagem de assinatura HMAC sobre o corpo bruto da requisição, e só quando a compra armazenada ainda está pendente e o provedor reporta a sessão como paga. O handler bloqueia o usuário e a compra, lança a transação no ledger com uma chave derivada do id da sessão do provedor, e marca a compra como paga e grava o entitlement na mesma transação. Uma compra, então, nunca fica paga sem o acesso que ela comprou, e acesso nunca é concedido sem pagamento. Uma sessão concluída com status não pago continua pendente, porque uma confirmação atrasada ainda pode chegar.

**Alternativas consideradas.** Conceder acesso no redirecionamento e reconciliar depois foi rejeitado porque torna o cliente a fonte de verdade do dinheiro. Fazer polling no provedor a partir da API em um timer foi rejeitado porque duplica a máquina de retentativa do provedor e adiciona um agendador a um sistema que de outra forma não tem nenhum. Agir em qualquer evento que mencione a sessão foi rejeitado porque os tipos de evento têm significados diferentes e alguns chegam antes da liquidação.

**Consequências.** As compras ficam pendentes até um evento chegar, então um webhook que nunca é entregue deixa o comprador sem acesso até a reconciliação, e o endpoint precisa ser público e estar bem configurado em cada ambiente. Replays saem baratos: a chave do ledger os absorve, e a checagem de status torna uma segunda transição um no-op. Os modos de falha aparecem na linha da compra e não em um saldo, e é isso que torna tratável uma conversa de suporte sobre um plano que não apareceu.

---

## ADR-004: Tratar o acesso como entitlement com período, não como flag

**Fase:** novembro de 2026, marco de planos.

**Contexto.** A primeira geração guardava o acesso pago como booleano no registro do usuário. Isso bastava enquanto havia um produto e nenhuma renovação. Com vários planos, renovações, upgrades, expiração, concessões manuais e itens avulsos comprados com crédito, o booleano não responde o que o produto pergunta todo dia: desde quando, até quando, qual plano, quem concedeu, e o que aconteceu com o acesso que expirou semana passada. Também não dá para reconciliar com pagamentos, porque booleano não tem valor nem data para comparar com um lançamento.

**Decisão.** Acesso é uma linha. Um entitlement registra a origem (compra de plano, pacote de crédito ou concessão manual), o plano a que se refere, um início, um fim e um status. Toda leitura premium consulta o serviço de entitlement, que lê essas linhas e o saldo de créditos e responde com uma decisão e um motivo. Expiração é propriedade da linha, avaliada na leitura, não um job que precisa rodar: um job agendado que troca flags é um job que pode falhar em silêncio e deixar conteúdo pago aberto. O entitlement é gravado na mesma transação da confirmação da compra, então um pagamento não existe sem o seu acesso, e uma concessão manual é ação administrativa auditada em vez de edição no banco. Créditos ficam fora desse modelo: saldo de crédito é conta do ledger, e resgatar um crédito é um lançamento que reconhece receita pelo item que ele libera.

**Alternativas consideradas.** Manter o booleano e somar uma data de renovação foi rejeitado porque perde o histórico e não representa duas concessões sobrepostas, que é exatamente o que um upgrade produz. Uma coluna `plan` no usuário foi rejeitada pelo mesmo motivo, mais a impossibilidade de auditar quem a alterou. Um job agendado de expiração foi rejeitado porque o modo de falha dele é acesso de graça, e porque o caminho de leitura consegue avaliar uma data sem processo em background. Tratar créditos como entitlements foi rejeitado porque crédito é dinheiro devido, e dinheiro devido pertence ao ledger.

**Consequências.** Mais linhas, um join no caminho de leitura premium, e toda decisão de acesso passando por um único serviço, que é o ponto. A pergunta de suporte "por que esta conta tem acesso" agora tem resposta com origem e data. O custo é que linhas expiradas se acumulam e pedem uma política de arquivamento, e que o serviço de entitlement vira dependência de quase todo módulo de conteúdo, então ele fica pequeno e sem regra de produto.

---

## ADR-005: Uma allowlist exata de Origin para a superfície administrativa

**Fase:** novembro de 2026, marco do backoffice.

**Contexto.** O portal administrativo é um build estático no próprio hostname, a API está em outro, e o cookie de sessão é enviado com credenciais. A primeira geração checava o papel de admin no navegador, o que não é fronteira. Mesmo com um guard de papel no servidor, um cookie de admin válido pode ser usado a partir de uma página em outra origem se a API aceitar requisição cross-origin de qualquer lugar. O risco é assimétrico: se um leitor perde acesso a uma publicação, é um ticket de suporte; se uma sessão de operador é conduzida por uma página de terceiros, é um incidente.

**Decisão.** Dois controles independentes. O CORS usa allowlist exata de origens com credenciais habilitadas, nunca wildcard e nunca correspondência por sufixo, então só os front ends configurados conseguem ler respostas. Em cima disso, todo controller de admin exige um header `Origin` exatamente igual à origem de admin configurada, em leitura e em escrita, então uma requisição forjada de outra origem é rejeitada mesmo carregando sessão válida. A comparação é contra a configuração, não contra um eco do header da requisição, e header ausente é rejeição, não aprovação. O guard de papel de admin também roda; o guard de origem é adicional, não substituto.

**Alternativas consideradas.** Contar com `SameSite=Strict` para o cookie de admin foi rejeitado porque quebraria a navegação pretendida a partir do site da comunidade e porque atributos de cookie são política de navegador, não decisão de autorização. Um token CSRF por formulário de admin foi considerado e ficou como adição futura, mas a checagem de origem cobre a mesma classe de ataque com menos estado e vale também para GET. Checar só nas escritas foi rejeitado: leituras de admin expõem dados de conta, histórico de compra e extratos do ledger.

**Consequências.** O header de origem é convenção de navegador, não segredo, então um cliente que não é navegador envia o valor que quiser. O guard, portanto, assume que o navegador impõe a origem em requisições cross-site e não defende contra um cliente que mente; é por isso que o guard de papel, a versão de sessão e o log de auditoria continuam no lugar. Na operação, deploys de preview e hostnames alternativos precisam de configuração explícita, e uma origem de admin mal configurada falha fechada com 403 em vez de degradar em silêncio.

---

## ADR-006: Dividir o monólito em módulos em torno de um único caminho de dinheiro

**Fase:** novembro de 2026, início da reescrita.

**Contexto.** O produto de comunidade era um arquivo HTML por superfície com as regras embutidas, e Cloud Functions que faziam cada uma a sua própria persistência. A segunda geração tinha de ser construída com fronteiras visíveis: autenticação, perfis e grafo social, conteúdo e moderação, planos e pagamentos, créditos, repasses a criadores, administração. O risco de uma divisão em módulos é a modularidade cosmética, em que os diretórios mudam e o acoplamento não.

**Decisão.** A API é dividida por funcionalidade, com o ledger e o serviço de entitlement abaixo dos módulos de funcionalidade. A regra que torna a divisão real é que dinheiro tem exatamente um caminho: nenhum módulo escreve saldo, e toda movimentação passa pelo serviço de ledger com uma chave e um tipo. O módulo de repasses é dono do lote, da aprovação e do extrato, e lança pela mesma função dentro da própria transação em vez de editar saldo. Guards são globais onde a regra é global (sessão) e locais onde a regra é local (papel de admin, origem de admin). O módulo de ledger não depende de pagamentos, conteúdo ou repasses, e é isso que permite o CLI de reconciliação ser um entry point simples; o módulo de grafo social não depende do ledger, o que mantém a leitura do feed barata.

**Alternativas consideradas.** Uma divisão em camadas (controllers, services, repositories) foi rejeitada porque agrupa por papel técnico e deixa o caminho do dinheiro distribuído entre camadas. Um único módulo de conteúdo com discriminador `type` foi rejeitado quando publicações premium, comentários e itens salvos começaram a pedir regras diferentes de moderação e de acesso, porque a ramificação apareceu no caminho de leitura. Um serviço separado por contexto delimitado (pagamentos como artefato de deploy próprio) foi rejeitado como sobrecarga operacional que a equipe não conseguiria carregar neste tamanho.

**Consequências.** Mais arquivos, mais fiação de módulos e risco real de import circular em torno do serviço de entitlement. É por isso que ele fica abaixo de conteúdo e acima de nada. O benefício aparece nos testes: a suíte do ledger roda contra o banco sem uma compra, a suíte de conteúdo roda sem pagamentos, e a suíte de pagamentos exercita o webhook com payload assinado. Também dá a cada superfície os próprios rate limits e constantes, do que o produto precisava porque publicar, comentar e fazer checkout falham de formas diferentes.

---

## ADR-007: Reconstruir a partir da proveniência em vez de copiar adiante

**Fase:** setembro a novembro de 2026, fundação da reconstrução.

**Contexto.** Os bundles publicados do produto de comunidade não voltavam para um commit com confiança. Arquivos tinham sido editados no lugar, copiados de uma branch para outra e servidos por um rewrite de hospedagem que apontava para um artefato mais antigo. Em um produto onde uma regra decide se um pagamento libera conteúdo, "esta regra veio de algum lugar" não é resposta aceitável, e uma reescrita que copia código não verificado herda a mesma incerteza com carimbo de data novo.

**Decisão.** O repositório de reconstrução começou quase vazio: 24 arquivos e 15 commits de governança, fronteiras de diretório e regras de reuso antes de qualquer código de funcionalidade. Cada arquivo candidato do repositório histórico tinha de registrar origem, commit, hash, classificação e motivo de reuso antes de entrar no caminho ativo. O que não dava para estabelecer permanecia rotulado como não comprovado e fora do caminho. O repositório histórico ficou intacto como referência, e o alvo visual foi fixado para que uma reescrita não derivasse para um redesign. A geração atual foi escrita contra essas fronteiras, com o ledger, o modelo de entitlement, o fluxo de pagamento e o caminho de repasse desenhados primeiro.

**Alternativas consideradas.** Continuar no repositório histórico com uma branch de limpeza foi rejeitado porque o artefato publicado não se ligava a um commit, então a limpeza não resolveria o problema de proveniência. Copiar o HTML e refatorar no lugar foi rejeitado pelo mesmo motivo, mais o tamanho do arquivo. Uma reescrita greenfield completa e sem referência foi rejeitada porque o comportamento do produto, incluindo os casos de borda, era a especificação.

**Consequências.** Semanas de trabalho antes da primeira funcionalidade, e código que teve de ser reescrito em vez de reusado, incluindo regras que provavelmente funcionavam. A fundação também criou documentação para manter e um processo de governança que desacelera mudança pequena. O que ela comprou é uma base de código em que cada regra tem dono, fase e teste, que é a propriedade que tornou possível revisar o trabalho posterior de ledger e de segurança.
