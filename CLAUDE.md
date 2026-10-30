# CLAUDE.md

Guia para o Claude Code trabalhar neste repositório.

## Projeto

**Distributed Wagering Processor** (Jungle Gaming) — serviço financeiro que processa operações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) vindas de provedores por HTTP e SQS, correto sob duplicação, desordem, concorrência e múltiplas instâncias.

Leia antes de mudar algo relevante:

- [Desafio.md](Desafio.md) — especificação original (fonte da verdade dos requisitos; não editar)
- [docs/OVERVIEW.md](docs/OVERVIEW.md) — requisitos com IDs (`RF-*`, `RN-*`, `R-*`, `T-*`, `D-*`)
- [docs/BACKLOG.md](docs/BACKLOG.md) — sprints e itens; marque `[x]` ao concluir
- [ARCHITECTURE.md](ARCHITECTURE.md) — decisões (ADRs), schema, fluxos, contratos HTTP, failure codes

[docs/DECISION_LOG.md](docs/DECISION_LOG.md) é o diário de decisões: **não precisa lê-lo** para trabalhar, só acrescentar entradas (ver Fluxo de trabalho).

## Stack

Bun 1.4.4 (runtime, package manager e test runner) · TypeScript 7 strict · NestJS 12 · PostgreSQL 17 · MikroORM 7 (`EntitySchema`) · AWS SQS via LocalStack 4 · Docker Compose · zod 4 · pino · prom-client · Biome 2.

Notas de versão que importam:
- TypeScript 7 não aceita `baseUrl`/aliases: use **imports relativos sem extensão**.
- MikroORM 7 é ESM-only; erros do Postgres que ele não mapeia (ex.: `55P03` lock timeout) chegam como `DriverException` — classifique pelo SQLSTATE em `err.code`.
- Para dinheiro, `numeric` volta do driver como string; nunca converta para `number`.

## Comandos

Mantenha esta seção em sincronia com o `package.json`.

```bash
docker compose up -d --wait          # postgres + localstack (filas criadas no init)
bun install
bun run dev                          # app com watch (porta 3000)
bun run typecheck                    # tsc --noEmit
bun run lint                         # biome check  (CI usa: bunx biome ci .)
bun run format                       # biome format --write
bun run migration:up                 # aplica migrations (MIGRATION_DATABASE_URL, role wallet_owner)
bun run migration:down [--all]       # reverte a última (ou todas)
bun run migration:create <nome>      # gera arquivo + atualiza migrations/index.ts
bun run test:unit
bun run test:integration             # exige compose de pé
bun run test:concurrency             # exige compose de pé
bun run test                         # todas as suítes
bun run test:load                    # carga contra o cluster em :8080 (docs/LOAD_TEST.md)
```

Profiles do Compose: `app` (3 réplicas + nginx), `observability` (Prometheus, Grafana, Jaeger), `auth` (Keycloak, com `AUTH_MODE=keycloak`), `load` (`loadgen`).

## Regras invioláveis (invariantes não negociáveis)

1. **Dinheiro nunca é `number`.** Use `Money` (bigint em centavos). Nada de `parseFloat`, `Number(amount)`, `toFixed` ou aritmética nativa sobre valores monetários. No banco, `numeric(20,2)`.
2. **Idempotência só no banco.** Nunca use `Map`/cache em memória como garantia.
3. **Eventos só pela outbox**, gravados na mesma transação SQL do efeito financeiro. Nunca chame o SQS de dentro do use case.
4. **Ledger é append-only.** Nunca escreva `UPDATE`/`DELETE` em `wallet_ledger_entries`, nem em migrations de dados.
5. **Saldo só muda com a wallet travada** (`WalletRepository.lockForUpdate`, `SELECT … FOR UPDATE`) e via `Wallet.debit/credit`, que devolvem o lançamento. Nunca `read → calculate → update` solto.
6. **Nenhum lock global.** Lock é por linha de wallet.
7. **Ack no SQS só depois do commit.**
8. **Garantias no schema.** Nova invariante de unicidade/imutabilidade/não-negatividade ⇒ constraint, índice ou trigger na migration, com teste de integração tentando violá-la via SQL.
9. **Tudo precisa funcionar com N instâncias.** Nada de estado em memória compartilhado entre requisições que afete correção.

## Arquitetura (resumo)

Hexagonal + DDD tático. Regra de dependência:

```
interfaces ─┐
            ├─> application ─> domain
infrastructure ┘   (implementa as ports de application)
```

- `src/domain`: TypeScript puro. **Proibido** importar `@nestjs/*`, `@mikro-orm/*`, `@aws-sdk/*`, `zod` ou qualquer coisa fora de `src/domain`.
- Entidades e value objects: construtor `private`/`protected` + factories estáticas (`create`, `open`, `from`, `rehydrate`). `rehydrate` **não** revalida transições.
- Estado encapsulado (`private _campo` + getter); transições explícitas; estados terminais lançam `InvalidTransactionStateError`.
- Persistência: `EntitySchema` + mappers em `src/infrastructure/persistence`; o domínio não conhece o ORM.
- Escritas financeiras são explícitas (`em.insert`, `em.nativeUpdate … WHERE version = ?`) dentro de `UnitOfWork.run`, na ordem: wallet/transação → ledger → outbox. Não use `persist()`/`flush()` para essas tabelas; leituras com `disableIdentityMap` (ADR-013).
- Toda mudança de saldo passa por `TransactionScope`: `wallets.lockForUpdate` → domínio → `transactions.insert/update` → `ledger.append` → `wallets.update(wallet, expectedVersion)` → `outbox.enqueue`.
- Autenticação: todo endpoint passa pelo `AuthGuard` global (porta `ProviderIdentityPort`); rotas abertas usam `@Public()`. `AUTH_MODE=disabled` (padrão, todo chamador é `trusted`) ou `keycloak` (`JwtProviderIdentity`). A autorização fica nos casos de uso: comandos recebem `principal` obrigatório (`TRUSTED` em workers, scripts e testes); rotas de backoffice usam `assertBackoffice`.
- Tracing: `src/infrastructure/observability/tracing.ts` precisa continuar sendo o **primeiro import** do `main.ts` (instrumenta `http` e `pg` antes de serem carregados). Spans manuais via `inSpan`; atributos nunca levam valores monetários.
- Use cases em `src/application/use-cases`; HTTP e SQS chamam **o mesmo** `ProcessWagerTransaction`.
- Ordem de locks numa transação: inbox → wallet → wager_transactions → inserts. Não inverta.

## Convenções

- **Idioma:** código, identificadores, nomes de arquivos e mensagens de commit em inglês; documentação (`*.md`) em português.
- **Tom da documentação pública:** profissional e direto. Fale de requisitos, invariantes e critérios de qualidade, não de "desafio", "pontos" ou "avaliação". Nada de notas sobre o sistema operacional da máquina de desenvolvimento (isso vai em `CLAUDE.local.md`, fora do git). `Desafio.md` é o enunciado e não muda.
- Commits no formato Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `chore:`).
- **Commits e PRs sem atribuição ao Claude:** nada de `Co-Authored-By: Claude …`, "Generated with Claude Code" ou qualquer menção ao assistente em mensagens de commit, descrições de PR ou código. O autor é só o dono do repositório.
- Repositório remoto: https://github.com/RodrigoTorreao/jungle-backend (branch padrão `main`).
- Erros de domínio são classes tipadas; o mapeamento para HTTP fica só no exception filter (ver ARCHITECTURE §9). Não lance `HttpException` de dentro de `application`/`domain`.
- Novo `failureCode` ⇒ atualizar a tabela da ARCHITECTURE §9.2.
- Novo evento ⇒ subclasse de `IntegrationEvent` com `eventType` e `version` no tipo; `data` só com tipos JSON (`MoneyProps`, nunca `Money`).
- Logs: use o logger com contexto; nunca logue payload completo, `amount` ou saldos.
- Migrations: sempre com `up` **e** `down`; nunca edite uma migration já aplicada — crie outra.
- IDs: UUIDv7 via porta `IdGenerator`. Tempo via porta `Clock` (nada de `new Date()` no domínio).

## Testes

- `bun test`. Unidade em `test/unit`, integração em `test/integration`, concorrência em `test/concurrency`, helpers em `test/support`.
- Integração e concorrência usam **PostgreSQL e LocalStack reais**. Não mocke banco nem SQS nessas suítes.
- Determinismo: nada de `sleep` fixo; use `waitFor(cond, timeout)`. Paralelismo real com `Promise.all` em conexões independentes ou processos (`Bun.spawn`).
- Todo teste de integração/concorrência que cria wallets ou move dinheiro termina com `assertLedgerConsistency`. Testes que não tocam em wallets (health, migrations) não precisam.
- Crash em pontos exatos via `FaultInjector` (`FAULT_POINTS=...`), nunca via timing.
- Um bug corrigido ganha um teste que falhava antes.

## Banco e testes de integração

- Roles: `wallet_owner` (dono do schema, roda migrations) e `wallet_app` (runtime: `SELECT/INSERT/UPDATE`, sem `DELETE`/`TRUNCATE`/DDL). Criados em `docker/postgres/init`; grants em `Migration…_bootstrap`.
- Migrations são SQL escrito à mão (`this.addSql`) registradas em `src/infrastructure/persistence/migrations/index.ts` — não use geração por diff do ORM.
- Testes de mensageria criam filas próprias com `createTestQueues()` (`test/support/sqs.ts`) e as apagam no `afterAll`; nunca usem as filas fixas do Compose. Consumer e workers são montados direto (`buildConsumer`, `pollOnce()`, `runOnce()`) para ficarem determinísticos; `ManualClock` controla backoff e TTL.
- Testes multi-processo (`test/support/cluster.ts`): `startInstance` sobe `bun src/main.ts` real numa porta livre e captura os logs JSON; `killInstance` é SIGKILL. `FAULT_MODE=kill` faz a instância se matar no ponto exato. Testes de `SIGTERM` são pulados em plataformas sem semântica de sinal POSIX e sempre rodam no CI (Linux).
- Quedas de dependência: `TcpProxy` (`test/support/tcp-proxy.ts`) na frente do Postgres ou do LocalStack; `stop()`/`start()` simulam a queda real.
- `patches/kysely@0.29.6.patch` corrige um vazamento de conexão (ADR-014). Não remova; ao atualizar MikroORM/Kysely, reaplique com `bun patch` e rode `test/integration/resilience`.
- Crash em teste: `new ArmedFaultInjector(['after-commit-before-ack'])` passado ao consumer/publisher ou `connectPersistence(db, { faults })` para `before-commit`. Em modo `throw` o `SimulatedCrashError` deixa o estado de um processo morto; o modo `kill` é para os testes multi-processo.
- Cada arquivo de teste de integração chama `createTestDatabase()` (clone do template migrado) e `db.drop()` no `afterAll`. Use `db.appUrl` para o que a app faz e `db.ownerUrl` só para DDL/sondar constraints.

## Fluxo de trabalho

1. Pegue o próximo item do [BACKLOG](docs/BACKLOG.md) na ordem dos sprints.
2. Implemente com testes; rode `typecheck`, `lint` e as suítes afetadas.
3. Se uma decisão mudou, registre na ARCHITECTURE (nova linha em ADRs ou interpretação).
4. Achado de spike, mudança de rumo, beco sem saída ou interpretação ambígua da especificação ⇒ acrescente uma entrada `DL-NNN` no fim do [DECISION_LOG](docs/DECISION_LOG.md): 3 a 5 linhas, só o que não está no ARCHITECTURE nem no git. Nunca reescreva entradas antigas; implementação de rotina não entra.
5. Marque o item como `[x]` no backlog.
