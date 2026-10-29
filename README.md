# Jungle Wagering — Distributed Wagering Processor

Serviço financeiro que processa operações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) recebidas de provedores por HTTP e SQS, correto sob mensagens duplicadas, fora de ordem, concorrentes e com múltiplas instâncias.

- Enunciado: [Desafio.md](Desafio.md)
- Arquitetura e decisões: [ARCHITECTURE.md](ARCHITECTURE.md)
- Requisitos: [docs/OVERVIEW.md](docs/OVERVIEW.md) · Plano: [docs/BACKLOG.md](docs/BACKLOG.md)

> **Status:** Sprint 0 concluído — fundação (Bun + NestJS + MikroORM + PostgreSQL + LocalStack), migrations reversíveis, harness de testes e CI. O domínio de wagering começa no Sprint 1.

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

### Como os testes isolam o banco

O preload `test/support/integration-preload.ts` cria e migra um banco *template* uma vez por execução. Cada arquivo de teste clona esse template (`CREATE DATABASE … TEMPLATE`) e o descarta no fim, então os arquivos nunca compartilham estado. As suítes de integração e concorrência não devem rodar em paralelo entre si (compartilham o template).

## Windows com Docker no WSL2 (sem Docker Desktop)

- Rode o Compose de dentro do WSL: `wsl -d Ubuntu --cd <pasta-do-projeto> -- docker compose up -d --wait`. As portas `5432` e `4566` ficam acessíveis em `localhost` no Windows.
- A distro WSL **desliga quando fica ociosa** e derruba os containers. Mantenha um terminal WSL aberto (ou `wsl -d Ubuntu -- sleep infinity` em segundo plano) enquanto desenvolve.
- Testes que dependem de sinais POSIX (`SIGTERM`, `SIGKILL`) devem rodar em Linux (WSL2, container ou CI).

## CI

`.github/workflows/ci.yml` roda typecheck, `biome ci`, testes de unidade e — com o Compose de pé no runner — migrations `up → down → up`, integração e concorrência.
