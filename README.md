# Jungle Wagering — Distributed Wagering Processor

Serviço financeiro que processa operações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) recebidas de provedores por HTTP e SQS, correto sob mensagens duplicadas, fora de ordem, concorrentes e com múltiplas instâncias.

- Enunciado: [Desafio.md](Desafio.md)
- Arquitetura e decisões: [ARCHITECTURE.md](ARCHITECTURE.md)
- Requisitos: [docs/OVERVIEW.md](docs/OVERVIEW.md) · Plano: [docs/BACKLOG.md](docs/BACKLOG.md)
- Diário de decisões: [docs/DECISION_LOG.md](docs/DECISION_LOG.md)

> **Status:** Sprints 0–6 concluídos — domínio, schema com as garantias financeiras, API HTTP, mensageria (SQS, inbox, outbox, pendências), observabilidade (logs com contexto, `/metrics`, `/health/ready`), correção comprovada com 3 processos reais, `kill -9` e `SIGTERM`, e os diferenciais: teste de carga com relatório ([docs/LOAD_TEST.md](docs/LOAD_TEST.md)), Prometheus + Grafana, autenticação com Keycloak, traces OpenTelemetry e reconciliação periódica.

## Pré-requisitos

| Ferramenta | Versão |
|---|---|
| [Bun](https://bun.sh) | 1.4.4 (fixada em `packageManager`) |
| Docker Engine + Compose v2 | Docker Desktop, ou Docker dentro do WSL2 |

## Setup

```bash
bun install
cp .env.example .env
docker compose up -d --wait          # PostgreSQL 17 + LocalStack (SQS)
bun run migration:up
bun run dev                          # http://localhost:3000/health/live
```

O Compose cria:

- **PostgreSQL** com os roles `wallet_owner` (dono do schema, roda migrations) e `wallet_app` (runtime, sem `DELETE`/`TRUNCATE`/DDL) e o banco `wagering`.
- **LocalStack** com as filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo` (redrive com `maxReceiveCount=5`) e `wagering-events.fifo`.

## Papéis do processo

A mesma aplicação roda qualquer combinação de papéis via `APP_ROLES` (lista separada por vírgula, ou `all`):

| Papel | O que faz |
|---|---|
| `api` | endpoints HTTP (sempre sobem `/health/*`) |
| `consumer` | consome `wager-transactions.fifo` (inbox, DLQ, backoff) |
| `outbox-publisher` | publica a outbox em `wagering-events.fifo` |
| `pending-reference-worker` | resolve transações `PENDING_REFERENCE` |
| `reconciliation-worker` | reconcilia uma amostra de wallets por minuto (`RECONCILIATION_*`) |

```bash
APP_ROLES=all bun run dev
```

Variáveis de mensageria e workers estão em `.env.example` (`SQS_*`, `OUTBOX_*`, `PENDING_REFERENCE_*`).

## Cluster local: 3 réplicas atrás de um load balancer

```bash
docker compose --profile app up -d --build --wait   # migrate + 3× app + nginx em :8080
curl http://localhost:8080/health/ready
curl http://localhost:8080/metrics
docker compose --profile app stop app                # SIGTERM: drena e para cada réplica
```

Operação:

| Endpoint | Para quê |
|---|---|
| `GET /health/live` | o processo responde |
| `GET /health/ready` | PostgreSQL e filas alcançáveis; 503 durante o shutdown |
| `GET /metrics` | métricas Prometheus (catálogo no ARCHITECTURE §10) |

### Profiles opcionais

```bash
# métricas, dashboard e traces
OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318 \
  docker compose --profile app --profile observability up -d --build --wait
# Grafana: http://localhost:3001 · Prometheus: http://localhost:9090 · Jaeger: http://localhost:16686

# autenticação com Keycloak (realm importado; admin em http://localhost:8180, admin/admin)
AUTH_MODE=keycloak docker compose --profile app --profile auth up -d --build --wait
curl -s http://localhost:8180/realms/wagering/protocol/openid-connect/token \
  -d grant_type=client_credentials -d client_id=provider-a -d client_secret=provider-a-secret
```

Clients do realm: `provider-a` e `provider-b` (provedores, claim `provider_id`) e `backoffice` (role `wallet-admin`: criar wallet, ledger, reconciliação). Os segredos são `<client>-secret`, só para desenvolvimento. Detalhes e matriz de autorização no ARCHITECTURE §11.

### Teste de carga

```bash
docker compose --profile app --profile observability up -d --build --wait
docker compose --profile app --profile observability --profile load run --rm loadgen
# ou, do host: PROMETHEUS_URL=http://localhost:9090 bun run test:load
```

Metodologia, resultados e análise em [docs/LOAD_TEST.md](docs/LOAD_TEST.md). O alvo precisa estar com `AUTH_MODE=disabled`.

## Comandos

| Comando | O que faz |
|---|---|
| `bun run dev` / `bun run start` | sobe a API (com watch / sem watch) |
| `bun run typecheck` | `tsc --noEmit` (TypeScript 7, modo estrito) |
| `bun run lint` / `bun run format` | Biome (inclui regras que proíbem `number` para dinheiro e imports de framework no domínio) |
| `bun run migration:up` | aplica migrations pendentes (role `wallet_owner`) |
| `bun run migration:down [--all]` | reverte a última (ou todas) |
| `bun run migration:create <nome>` | cria migration vazia e registra no índice |
| `bun run test:unit` | testes de unidade, sem infraestrutura |
| `bun run test:integration` | PostgreSQL e LocalStack reais; exige o Compose de pé |
| `bun run test:concurrency` | idem, com paralelismo real |
| `bun run test` | todas as suítes |
| `bun run test:load` | teste de carga contra o cluster em `:8080` ([docs/LOAD_TEST.md](docs/LOAD_TEST.md)) |

### Como os testes isolam o banco

O preload `test/support/integration-preload.ts` cria e migra um banco *template* uma vez por execução. Cada arquivo de teste clona esse template (`CREATE DATABASE … TEMPLATE`) e o descarta no fim, então os arquivos nunca compartilham estado. As suítes de integração e concorrência não devem rodar em paralelo entre si (compartilham o template).

### Testes com sinais POSIX no Windows

O teste de `SIGTERM` só roda em Linux (no Windows ele é pulado). Para rodá-lo, ou a suíte de concorrência inteira, num container Linux na rede do Compose:

```bash
wsl -d Ubuntu --cd . -- docker run --rm --network jungle-wagering_default -v "$PWD:/src:ro" oven/bun:1.4.4 sh /src/scripts/test-in-linux.sh ./test/concurrency
```

## Windows com Docker no WSL2 (sem Docker Desktop)

- Rode o Compose de dentro do WSL: `wsl -d Ubuntu --cd <pasta-do-projeto> -- docker compose up -d --wait`. As portas `5432` e `4566` ficam acessíveis em `localhost` no Windows.
- Por padrão, a distro WSL **desliga quando fica ociosa** e derruba os containers. Para evitar, crie `%USERPROFILE%\.wslconfig` com o conteúdo abaixo e rode `wsl --shutdown` uma vez:

  ```ini
  [general]
  instanceIdleTimeout=-1

  [wsl2]
  vmIdleTimeout=-1
  ```
- Testes que dependem de sinais POSIX (`SIGTERM`, `SIGKILL`) devem rodar em Linux (WSL2, container ou CI).

## CI

`.github/workflows/ci.yml` roda typecheck, `biome ci`, testes de unidade e — com o Compose de pé no runner — migrations `up → down → up`, integração e concorrência. O job `cluster` constrói a imagem, sobe 3 réplicas atrás do nginx, faz um smoke test, roda uma carga curta com as checagens de correção, percorre o fluxo de autenticação com o Keycloak real e para as réplicas com `SIGTERM`.
