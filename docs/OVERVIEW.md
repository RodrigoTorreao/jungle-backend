# Visão Geral — Distributed Wagering Processor

> Documento de escopo. Consolida **tudo** que o desafio ([Desafio.md](../Desafio.md)) exige e os diferenciais que vamos entregar.
> Cada item tem um ID estável, usado no [BACKLOG.md](BACKLOG.md) e nos testes para rastreabilidade.
> Decisões técnicas e seus porquês ficam no [ARCHITECTURE.md](../ARCHITECTURE.md).

---

## 1. O problema em uma frase

Um serviço financeiro que recebe operações de apostas (`BET → WIN | LOSS | REFUND | ROLLBACK`) de vários provedores — por **HTTP** e por **SQS** —, com entrega **at-least-once**, mensagens **duplicadas**, **fora de ordem** e **concorrentes**, rodando em **várias instâncias**, e que precisa continuar **financeiramente correto**: nunca duplica crédito/débito, nunca perde evento confirmado, nunca deixa saldo negativo.

## 2. Como seremos avaliados

| Área | Pts | Onde mora a resposta |
|---|---:|---|
| Correção financeira | 20 | `Money` (bigint), ledger imutável, constraints de aritmética, reconciliação |
| Concorrência | 20 | `SELECT … FOR UPDATE` por wallet + `version` + `CHECK (balance >= 0)` |
| Idempotência | 15 | `UNIQUE (provider_id, idempotency_key)` + `payloadHash` canônico + inbox |
| Mensageria e falhas | 15 | inbox/outbox na mesma transação SQL, backoff, DLQ, shutdown gracioso |
| Modelagem e arquitetura | 10 | domínio puro, factories, portas/adaptadores |
| Testes | 10 | PostgreSQL e LocalStack reais, paralelismo real, ≥3 processos, crash injection |
| Observabilidade | 5 | logs JSON com contexto, métricas Prometheus, health live/ready |
| Documentação | 5 | `README.md` + `ARCHITECTURE.md` |

### Falhas eliminatórias (checklist permanente)

- [ ] Nenhum `number`/`float` para dinheiro (lint + revisão)
- [ ] Nenhum saldo negativo por race (CHECK no banco + teste 50x paralelo)
- [ ] Nenhum débito/crédito duplicado (UNIQUE no banco + testes de redelivery)
- [ ] Idempotência 100% persistente (nenhum cache em memória como garantia)
- [ ] Correto com múltiplas instâncias (teste com ≥ 3 processos)
- [ ] Nenhum evento publicado antes do commit (outbox)
- [ ] Ledger auditável e imutável (trigger + `REVOKE UPDATE, DELETE`)
- [ ] Testes de integração usam PostgreSQL e SQS reais

---

## 3. Pré-requisitos

### 3.1 Ambiente de desenvolvimento

| Ferramenta | Versão | Uso |
|---|---|---|
| **Bun** | 1.4.4 (fixada em `packageManager` e no CI) | runtime, package manager, test runner |
| **Docker Desktop** + **Compose v2** | recente | PostgreSQL, LocalStack, Keycloak, Prometheus, Grafana, múltiplas instâncias da app |
| **WSL2** (Windows) | — | backend do Docker; recomendado também para rodar os testes de crash/SIGTERM (sinais POSIX não existem nativamente no Windows) |
| **Git** | — | versionamento |
| `awslocal` / AWS CLI *(opcional)* | — | inspeção manual das filas |
| `psql` *(opcional)* | — | inspeção manual do banco |

### 3.2 Stack obrigatória

| Item | Escolha |
|---|---|
| Runtime / PM / testes | Bun 1.x |
| Linguagem | TypeScript `strict` |
| Framework | NestJS |
| Banco | PostgreSQL (17) |
| Mensageria | AWS SQS via **LocalStack** |
| ORM | **MikroORM** (preferencial do desafio) |
| Orquestração local | Docker Compose |
| Migrations | versionadas e reversíveis (`up`/`down`) |

### 3.3 Bibliotecas de apoio previstas

`@aws-sdk/client-sqs`, `zod` (validação de contratos e config), `pino`/`nestjs-pino` (logs JSON), `prom-client` (métricas), `@nestjs/terminus` (health), `jose` (validação de JWT/JWKS), Biome (lint + format). Nenhuma lib de decimal: `Money` usa `bigint` em centavos (ver ARCHITECTURE, ADR-002).

---

## 4. Restrições invioláveis

| ID | Restrição | Como garantimos |
|---|---|---|
| R-01 | Sem `number`/`float`/`double` para dinheiro | `Money` sobre `bigint`; coluna `numeric(20,2)`; regra de lint proibindo `parseFloat`/`Number()` em módulos monetários |
| R-02 | Sem cache em memória como garantia de idempotência | unicidade no banco (`wager_transactions`, `inbox_messages`) |
| R-03 | Não confiar só em SQS FIFO | FIFO é otimização; o banco é a garantia final |
| R-04 | Não publicar eventos antes do commit | Transactional Outbox |
| R-05 | Ledger nunca sobrescrito/excluído | trigger `BEFORE UPDATE OR DELETE` + `REVOKE` para o role da aplicação |
| R-06 | Sem lock global | lock de **linha** por `wallet_id` |
| R-07 | Sem `read → calculate → update` sem controle | `FOR UPDATE` + `WHERE version = :expected` |
| R-08 | Correto com múltiplas instâncias | nenhum estado compartilhado em memória; testes com ≥ 3 processos |
| R-09 | Unicidade, imutabilidade e não-negatividade **no schema** | `UNIQUE`, `CHECK`, índices parciais, triggers e constraint triggers diferidos |

---

## 5. Requisitos funcionais

### 5.1 Domínio

| ID | Requisito |
|---|---|
| RF-D01 | `Money` imutável, escala fixa 2, multi-moeda, erro em operação entre moedas diferentes |
| RF-D02 | `Money.from` rejeita `NaN`, `Infinity`, notação científica, string vazia, > 2 casas, negativos |
| RF-D03 | `Wallet` (aggregate root): `open`, `rehydrate`, `debit`, `credit`; saldo nunca negativo; `version` começa em 1 e só incrementa quando o saldo muda |
| RF-D04 | `WagerTransaction`: `create` (nasce `PENDING`), `rehydrate`, transições explícitas, estados terminais imutáveis |
| RF-D05 | `WalletLedgerEntry` estruturalmente imutável; `create` valida `balanceBefore ± money === balanceAfter` |
| RF-D06 | `InboxMessage` e `OutboxMessage` (com `scheduleRetry` e backoff) |
| RF-D07 | `IntegrationEvent<T>` abstrato + uma subclasse por evento, `eventType`/`version` no tipo |
| RF-D08 | Taxonomia de `FailureCode` estável e documentada |
| RF-D09 | Construtores privados + factories estáticas; `rehydrate` não revalida transições |

### 5.2 Regras de negócio

| ID | Regra |
|---|---|
| RN-01 | `BET` debita; rejeita com `INSUFFICIENT_FUNDS` se saldo insuficiente |
| RN-02 | `WIN` credita; pode referenciar a `BET` da mesma rodada |
| RN-03 | `LOSS` não move saldo e não gera ledger |
| RN-04 | `REFUND` credita; só referencia `BET` `PROCESSED`; uma única vez |
| RN-05 | `ROLLBACK` aplica o inverso da referência (`BET`, `WIN` ou `REFUND`); uma única vez |
| RN-06 | `REFUND`/`ROLLBACK` exigem `referenceExternalTransactionId` |
| RN-07 | Referência resolvida por `(providerId, referenceExternalTransactionId)` e deve ter mesmo provider, player, wallet, moeda e rodada |
| RN-08 | Valor da reversão = valor da referência (sem reversão parcial) |
| RN-09 | `REJECTED` não altera saldo nem gera ledger |
| RN-10 | Replay de operação processada retorna o **resultado original**, incluindo o saldo daquele momento |
| RN-11 | Referência ausente → `PENDING_REFERENCE`, reprocessada por worker com backoff exponencial e limite; esgotado → `REJECTED` (`REFERENCE_NOT_FOUND`) + evento |
| RN-12 | Reversão que deixaria saldo negativo → `REJECTED` com `REVERSAL_WOULD_OVERDRAW` (≠ `INSUFFICIENT_FUNDS`) |
| RN-13 | `OPENING` é interno: só nasce na criação de wallet com saldo > 0 |
| RN-14 | Mesma idempotency key com payload diferente → conflito (não replay) |
| RN-15 | No máximo uma wallet por `playerId + currency` |

### 5.3 API HTTP

| ID | Endpoint | Observação |
|---|---|---|
| RF-H01 | `POST /wallets` | `OPENING` + ledger `CREDIT` na mesma transação; duplicata → 409 |
| RF-H02 | `GET /wallets/:walletId` | |
| RF-H03 | `GET /wallets/:walletId/ledger?cursor=&limit=` | cursor opaco e estável (keyset) |
| RF-H04 | `GET /wagering/transactions/:transactionId` | |
| RF-H05 | `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | |
| RF-H06 | `POST /wagering/transactions` | `Idempotency-Key` obrigatório; `idempotentReplay` na resposta |
| RF-H07 | `POST /wallets/:walletId/reconciliation` | divergência: log + métrica + `consistent: false`, nunca corrige |
| RF-H08 | `GET /health/live`, `GET /health/ready` | sem autenticação |
| RF-H09 | Mapeamento de status HTTP que distingue: payload inválido, conflito de idempotência, rejeição de negócio, aceite pendente, falha transitória | consistente entre endpoints |
| RF-H10 | `GET /metrics` | formato Prometheus |

### 5.4 Processamento assíncrono

| ID | Requisito |
|---|---|
| RF-Q01 | Consumidor de `wager-transactions.fifo` reutiliza **o mesmo use case** do HTTP |
| RF-Q02 | Dedup por inbox persistente `(consumerName, messageId)` na mesma transação SQL |
| RF-Q03 | `ack` (DeleteMessage) **somente após o commit** |
| RF-Q04 | Classificação de erro: negócio (ack), transitório (retry com backoff), permanente (DLQ) |
| RF-Q05 | Limite de tentativas antes da DLQ `wager-transactions-dlq.fifo` |
| RF-Q06 | `SIGTERM`: conclui mensagens em andamento ou devolve visibilidade |
| RF-Q07 | Outbox publisher concorrente-seguro (vários publishers), sem perder e sem duplicar indefinidamente |
| RF-Q08 | Eventos mínimos: `WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`, `WagerTransactionPendingReference` |
| RF-Q09 | Worker agendado de `PENDING_REFERENCE` com backoff exponencial e TTL |

---

## 6. Requisitos não funcionais

| ID | Requisito |
|---|---|
| RNF-01 | Unidade de concorrência = `walletId`; wallets distintas em paralelo |
| RNF-02 | Correto com ≥ 3 instâncias simultâneas |
| RNF-03 | Tolerância a indisponibilidade temporária de PostgreSQL e SQS (retry/backoff, readiness) |
| RNF-04 | Logs JSON com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`; sem dados sensíveis/payload financeiro completo |
| RNF-05 | Métricas: transações por status, duplicatas, retries, DLQ, conflitos de lock, outbox lag, latência |
| RNF-06 | Migrations versionadas e reversíveis |
| RNF-07 | Shutdown gracioso (HTTP, consumer, workers, pool do banco) |

---

## 7. Testes obrigatórios

### Unidade (`test/unit`)
| ID | Cobertura |
|---|---|
| T-U01 | `Money`: escala, ausência de arredondamento implícito, entradas inválidas, imutabilidade |
| T-U02 | Invariantes de `Wallet` (saldo não negativo, version, moeda) |
| T-U03 | Regras de `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK` |
| T-U04 | Conflito de moeda |
| T-U05 | Idempotency key com payload divergente |
| T-U06 | Máquina de estados de `WagerTransaction` (terminais) |
| T-U07 | `WalletLedgerEntry.create` rejeita aritmética inconsistente |
| T-U08 | `OutboxMessage.scheduleRetry` (backoff) e hash canônico |

### Integração (`test/integration`, PostgreSQL e LocalStack reais)
| ID | Cobertura |
|---|---|
| T-I01 | Migrations `up → down → up` e todas as constraints/triggers |
| T-I02 | Atomicidade entre wallet, ledger, inbox e outbox (falha injetada antes do commit ⇒ nada persiste) |
| T-I03 | Inbox e redelivery |
| T-I04 | Publishers concorrentes sobre a mesma outbox |
| T-I05 | Retry e DLQ |
| T-I06 | Recuperação após reinicialização |

### Concorrência (`test/concurrency`, paralelismo real)
| ID | Cenário |
|---|---|
| T-C01 | Mesma aposta enviada 50x em paralelo → um único débito |
| T-C02 | Saldo 100.00, duas apostas de 80.00 simultâneas → 1 `PROCESSED`, 1 `REJECTED`, saldo 20.00, 1 débito |
| T-C03 | Wallets distintas em paralelo |
| T-C04 | ≥ 3 processos/instâncias simultâneos |
| T-C05 | Worker morto **depois do commit e antes do ack** |
| T-C06 | Dois publishers sobre a mesma outbox |
| T-C07 | `ROLLBACK`/`REFUND` entregue antes da referência |
| T-C08 | Reinício do serviço com comprovação da consistência final |

**Invariante final de todo teste:** `wallet.balance == saldo reconstruído pelo ledger` (helper compartilhado `assertLedgerConsistency`).

---

## 8. Diferenciais que vamos entregar

| ID | Diferencial | Prioridade |
|---|---|---|
| D-01 | Teste de carga `bun run test:load` com relatório (ambiente, metodologia, throughput, p50/p95/p99, erros, conflitos, outbox lag) | Alta |
| D-02 | Garantia **"saldo == ledger" no schema** via constraint trigger diferido + encadeamento de `balance_before/after` | Alta |
| D-03 | Prometheus + Grafana provisionados no Compose (dashboard pronto) | Média |
| D-04 | Autenticação com **Keycloak** (OIDC, client credentials por provedor, role de backoffice) | Média (vale 0 pts — timebox) |
| D-05 | OpenTelemetry (traces HTTP → use case → SQL → SQS) | Baixa |
| D-06 | Ledger de partidas dobradas (conta da casa/provedor) | Baixa (stretch) |
| D-07 | Job periódico de reconciliação por amostragem | Média |
| D-08 | CI (GitHub Actions) rodando unit + integração + concorrência com Compose | Média |
| D-09 | Roles de banco separados (owner de migration × app com grants mínimos) | Alta (barato e reforça R-05/R-09) |
| D-10 | Script de demo para a apresentação (cenários da seção 8 e crash recovery ao vivo) | Média |

## 9. Entregáveis

- Código-fonte + `docker-compose.yml` subindo tudo com um comando
- `README.md` — setup, comandos, como rodar cada suíte e a demo
- `ARCHITECTURE.md` — decisões, trade-offs, limitações, diagramas
- Migrations reversíveis
- Suítes de teste (unit, integração, concorrência) e teste de carga com relatório em `docs/LOAD_TEST.md`

## 10. Fora de escopo

- Reversão parcial; câmbio entre moedas; moedas com escala ≠ 2 (o modelo é multi-moeda, mas a escala é fixa em 2).
- Cadastro de jogadores/usuários próprio (identidade fica no IdP).
- UI/backoffice.
- Alta disponibilidade real do PostgreSQL/SQS (fora do Compose local).
