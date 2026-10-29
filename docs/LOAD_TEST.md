# Teste de carga

> Diferencial D-01 do desafio. Pedido: `bun run test:load`, com ambiente, metodologia, throughput, p50/p95/p99, taxa de erro, conflitos de concorrência e outbox lag. Não há meta de RPS. Aqui, a análise vale mais que o número.

## Resumo

| Cenário (3 réplicas, 32 usuários virtuais, 60 s) | Throughput | p50 / p95 / p99 | Erros | Correção |
|---|---|---|---|---|
| Uniforme: 500 wallets, BET/WIN/REFUND/ROLLBACK + 10% de reenvios | **441–523 req/s** | 59–69 / 121–139 / 158–193 ms | 0 | 500 wallets consistentes |
| Hot wallet: 32 usuários na mesma wallet | **151–165 req/s** | 192–198 / 310–375 / 492–859 ms | 0 | saldo = requisições confirmadas |
| Ingestão SQS: rajada de 5000 mensagens (5% duplicadas) | **154–204 msg/s** | conclusão em 12–16 / 22–31 / 23–32 s após o envio | 0 | 5000 transações, 5000 linhas na inbox, fila vazia |

Faixas = mínimo e máximo de 3 execuções completas. Nas três, **nenhum centavo divergiu**: o script falha (exit 2) se o saldo de alguma wallet não bater com o ledger, se o saldo da hot wallet não bater com as respostas `200` recebidas, ou se alguma mensagem SQS virar duas transações.

Achados:
1. **O teste encontrou um gargalo real, que foi corrigido.** O relay da outbox não acompanhava ~1000 eventos/s: o lag chegava a 31 s e a fila levava 14 s para esvaziar depois da carga. Mudamos para envio em pistas paralelas e um único `UPDATE` por lote. Depois disso, o lag máximo ficou entre 0,3 e 2,8 s e a fila esvazia na hora (§5.1).
2. **Neste ambiente, o teto (~500 tx/s) não está nas réplicas.** Com 6 réplicas o throughput é o mesmo; com 64 usuários virtuais a latência dobra e o throughput não sobe. O limite está nos componentes compartilhados de uma única máquina: PostgreSQL, o emulador LocalStack e a CPU do host (§5.2).
3. **Zero conflitos de concorrência sob carga**, inclusive na hot wallet: nenhum lock timeout, deadlock ou retry. O lock por wallet serializa o acesso por espera, e a espera nunca chegou ao `lock_timeout` de 2 s (§5.3).

---

## 1. Como rodar

```bash
# cluster: 3 réplicas atrás do nginx + Prometheus/Grafana (contadores do lado do servidor)
docker compose --profile app --profile observability up -d --build --wait

# recomendado: gerador dentro da rede do Compose (sem o relay de portas do WSL no caminho)
docker compose --profile app --profile observability --profile load run --rm loadgen

# alternativa: a partir do host, contra http://localhost:8080
PROMETHEUS_URL=http://localhost:9090 bun run test:load
```

| Variável | Padrão | O que controla |
|---|---|---|
| `LOAD_SCENARIOS` | `uniform,hot-wallet,sqs-ingestion` | cenários e ordem |
| `LOAD_DURATION_SECONDS` / `LOAD_WARMUP_SECONDS` | 60 / 5 | janela medida e aquecimento (não medido) |
| `LOAD_VUS` | 32 | usuários virtuais (closed loop) |
| `LOAD_WALLETS` | 500 | wallets do cenário uniforme |
| `LOAD_SQS_MESSAGES` / `LOAD_SQS_WALLETS` | 5000 / 200 | tamanho da rajada e número de grupos FIFO |
| `LOAD_TARGET_URL`, `LOAD_DATABASE_URL`, `PROMETHEUS_URL` | Compose | alvo, banco (só leitura, para lag e correção) e Prometheus (opcional) |

O alvo precisa rodar com `AUTH_MODE=disabled`. A validação de token é local, com JWKS em cache, e não é o que este teste mede. Cada execução imprime um JSON por cenário e grava tudo em `load/results/<timestamp>.json`, que fica fora do git. O CI roda uma versão curta (10 s, 500 mensagens) no job `cluster`, só pelas checagens de correção.

## 2. Ambiente

| Item | Valor |
|---|---|
| Máquina | Intel Core i5-14600KF (6P + 8E núcleos, 20 threads), 16 GB de RAM, Windows 11 |
| Containers | Docker Engine 29.3 dentro do WSL2 (Ubuntu): 20 vCPUs e ~7,7 GB visíveis para o Linux |
| Aplicação | 3 réplicas (`APP_ROLES=all`, `NODE_ENV=production`, pool de 10 conexões cada) atrás do nginx 1.27 (round robin, keepalive) |
| PostgreSQL | 17-alpine, configuração padrão (`max_connections=300`), volume no disco virtual do WSL |
| SQS | LocalStack 4: emulador em processo único, não é o serviço da AWS |
| Gerador | `load/run.ts` em container Bun na mesma rede, falando com o nginx (`http://lb:8080`) |
| Observabilidade | Prometheus 3.5 com scrape a cada 5 s, descobrindo as réplicas por DNS; tracing desligado |

Tudo roda na mesma máquina: gerador, nginx, réplicas, banco e broker disputam a mesma CPU, junto com o próprio Windows. Os números servem para comparar versões e configurações entre si. Não são a capacidade de um ambiente de produção.

## 3. Metodologia

**Closed loop.** Cada usuário virtual manda a próxima requisição assim que a anterior responde, sem pausa. Assim o sistema roda no máximo que consegue e o throughput medido é a capacidade, enquanto a latência mostra a fila. A contrapartida é que esse modelo esconde a degradação sob uma taxa de chegada fixa (*coordinated omission*). Por isso a latência aqui é "tempo de serviço sob saturação", e não "latência a N req/s".

**Aquecimento.** Os primeiros 5 s não são medidos: conexões, JIT e pools. A duração vem do relógio monotônico (`performance.now`).

**Cenários:**
- **uniforme.** Cada passo sorteia:
  - 10%: reenvio idêntico de uma requisição já confirmada, que precisa voltar como replay;
  - 10%: `REFUND`/`ROLLBACK` de uma aposta própria ainda não revertida;
  - 55%: `BET` de 1 a 5 BRL numa wallet aleatória;
  - 25%: `WIN`.

  As wallets abrem com 1000,00 BRL.
- **hot wallet.** Todos os usuários alternam `BET 0.01` e `WIN 0.01` numa wallet com 1.000.000,00. Como cada requisição move exatamente um centavo, o saldo esperado é uma contagem simples, comparada com o saldo gravado.
- **ingestão SQS.** 5000 mensagens `BET 1.00` em 200 grupos (um por wallet); 5% são enviadas duas vezes com `MessageDeduplicationId` diferente, então a fila entrega as duas e só a inbox pode deduplicar. O envio leva ~1 s (16 envios concorrentes em lotes de 10); mede-se o tempo até a última transação terminar (`processed_at`).

**Métricas e de onde vêm:**

| Métrica | Fonte |
|---|---|
| Throughput, p50/p95/p99, taxa de erro | cliente. Erro = qualquer resposta que não seja um desfecho decidido (`200`/`202`/`422`): 4xx, 5xx ou falha de rede |
| Conflitos de concorrência | Prometheus: `increase()` de `db_lock_conflicts_total` e `processing_retries_total` na janela do cenário |
| Duplicatas absorvidas pela inbox | exato, pelo banco (linhas da inbox × mensagens enviadas); o contador `inbox_duplicates_total` do Prometheus é aproximado, porque `increase()` extrapola nas bordas da janela |
| Outbox lag | duas medidas, ambas do banco: (a) idade do evento pendente mais antigo, amostrada a cada 1 s durante a carga; (b) atraso de publicação de cada evento (`published_at − occurred_at`) em percentis; mais o tempo para esvaziar a outbox depois da carga |
| Correção | SQL em `numeric` no PostgreSQL: saldo = Σ ledger, último lançamento = saldo e versão, versões sem buraco; saldo da hot wallet = contagem das respostas `200`; uma linha por mensagem SQS |

## 4. Resultados

### 4.1 Três execuções completas (3 réplicas, 32 usuários, 60 s)

**Uniforme**

| Execução | Requisições | req/s | p50 | p95 | p99 | máx | Replays | Outbox: lag máx · publicação p95 |
|---|---|---|---|---|---|---|---|---|
| 1 | 31.383 | 522,7 | 58,6 ms | 121,2 ms | 157,8 ms | 256 ms | 3.165 (10,1%) | 1,9 s · 1,3 s |
| 2 | 26.491 | 441,2 | 68,1 ms | 139,1 ms | 193,0 ms | 455 ms | 2.621 (9,9%) | 2,8 s · 0,5 s |
| 3 | 27.188 | 452,8 | 68,8 ms | 133,4 ms | 172,3 ms | 357 ms | 2.712 (10,0%) | 0,3 s · 0,2 s |

Todas as respostas foram `200`, inclusive os reenvios, que voltaram como replay. Não houve `422`: com saldos de 1000,00 as rejeições quase não ocorrem, e esse caminho é coberto pelos testes de integração, não por este.

**Hot wallet**

| Execução | Requisições | req/s | p50 | p95 | p99 | máx | Saldo esperado = gravado |
|---|---|---|---|---|---|---|---|
| 1 | 9.190 | 152,5 | 191,8 ms | 375,1 ms | 493,3 ms | 763 ms | 999999,78 = 999999,78 |
| 2 | 9.922 | 164,9 | 192,5 ms | 310,6 ms | 491,8 ms | 827 ms | sim |
| 3 | 9.076 | 150,7 | 197,6 ms | 313,5 ms | 859,0 ms | 2.942 ms | sim |

**Ingestão SQS (5000 mensagens + ~250 duplicatas)**

| Execução | msg/s | Conclusão após o envio: p50 / p95 / p99 | Esvaziou em | Linhas na inbox | Fila ao final |
|---|---|---|---|---|---|
| 1 | 153,8 | 16,5 / 31,1 / 32,2 s | 32,5 s | 5000 | vazia |
| 2 | 190,5 | 13,9 / 25,2 / 26,0 s | 26,3 s | 5000 | vazia |
| 3 | 203,9 | 12,4 / 22,2 / 22,9 s | 24,5 s | 5000 | vazia |

Na ingestão, a "latência" é dominada pela fila: as 5000 mensagens entram em ~1 s e saem a ~200/s, então a mediana fica perto da metade do tempo para esvaziar.

**Em todas as execuções:** taxa de erro 0; lock timeouts, deadlocks, falhas de serialização e retries transitórios = 0; mensagens na DLQ = 0; wallets inconsistentes = 0.

### 4.2 Experimentos de diagnóstico

| Configuração | Cenário | req/s ou msg/s | p50 | p95 | p99 |
|---|---|---|---|---|---|
| 3 réplicas, 32 usuários (30 s) | uniforme | 518,4 | 61,2 ms | 110,9 ms | 139,7 ms |
| 6 réplicas, 32 usuários | uniforme | 471,1 | 57,0 ms | 153,7 ms | 205,6 ms |
| 6 réplicas, 64 usuários (30 s) | uniforme | 517,3 | 111,3 ms | 262,4 ms | 327,8 ms |
| 6 réplicas | ingestão SQS | 205,5 | 13,0 s | 23,4 s | 24,1 s |

CPU por container no meio da carga uniforme (`docker stats`):

| | cada réplica | PostgreSQL | LocalStack | nginx | gerador |
|---|---|---|---|---|---|
| 3 réplicas | 106–116% | 201% | 112% | 11% | 20% |
| 6 réplicas | 108–124% | 353% | 110% | 17% | 29% |

## 5. Análise

### 5.1 Achado: o relay da outbox era o gargalo (corrigido)

A primeira execução completa, com o código do Sprint 5, mostrou a API saudável (505 req/s, p99 137 ms) e os eventos atrasados:

| Outbox no cenário uniforme | Antes | Depois |
|---|---|---|
| Lag máximo durante a carga | 31,3 s (p95 das amostras: 29,6 s) | 0,3–2,8 s |
| Atraso de publicação p50 / p95 / p99 | 20,4 / 30,2 / 31,2 s | 0,1 / 0,2–1,3 / 0,3–1,7 s |
| Tempo para esvaziar depois da carga | 14,1 s | 0 s |

Cada transação gera dois eventos, então ~500 tx/s produzem ~1000 eventos/s. O relay, por lote de 50, fazia 5 `SendMessageBatch` em sequência e depois 50 `UPDATE` individuais, tudo dentro da transação que segura as linhas. Isso dava ~800 eventos/s somando os 3 publishers.

Correção (ADR-016):
- **Pistas paralelas.** Os eventos do lote são particionados por `aggregateId` (hash estável) em 4 pistas que enviam em paralelo. Os eventos de uma wallet ficam sempre na mesma pista e saem na ordem do claim, então o paralelismo não inverte eventos de uma mesma wallet. Uma falha de envio afeta só o resto da sua pista.
- **Um `UPDATE` por lote** (`jsonb_to_recordset`) no lugar de um por linha.

O teste unitário `sqs-event-publisher.test.ts` cobre a ordem por agregado e a falha parcial de uma pista. As suítes de integração da outbox continuam iguais e passando.

### 5.2 Achado: o teto de ~500 tx/s é do ambiente, não das réplicas

- Com 3 réplicas, cada processo fica em ~110% de CPU, ou seja, o event loop do Bun saturado. Parecia o limite, mas com 6 réplicas o throughput não subiu (471 req/s).
- Com 6 réplicas e 64 usuários, a latência dobra e o throughput fica em 517 req/s: o sistema está saturado e o cliente não é o limite.
- Ao dobrar as réplicas, o PostgreSQL vai de ~200% para ~350% de CPU sem ganho de vazão, e o LocalStack fica em ~110% (um processo).

Com o que foi medido, não dá para separar qual componente compartilhado limita primeiro. Os candidatos:
- o PostgreSQL, com commit síncrono no disco virtual do WSL e a outbox recebendo ~1000 inserts/s mais as atualizações;
- o emulador de SQS, um processo só;
- a CPU do host, que também roda o Windows.

Próximos passos para separar: `pg_stat_statements` e `pg_stat_wal` durante a carga, perfil de CPU de uma réplica, e o mesmo teste com PostgreSQL e SQS em máquinas separadas (ou SQS real). A conclusão que o experimento sustenta: **a aplicação escala horizontalmente sem perder correção** (6 réplicas, zero divergências), e o limite neste host está fora dela.

### 5.3 Concorrência: zero conflitos, e por quê

Nenhum lock timeout, deadlock ou retry, nem na hot wallet com 32 requisições simultâneas na mesma linha. Isso decorre do desenho:
- o `SELECT … FOR UPDATE` por wallet faz as transações concorrentes **esperarem** em fila em vez de falharem;
- a ordem global de locks (inbox → wallet → transações) impede deadlock;
- a espera é limitada pelo `lock_timeout` de 2 s, que não chegou a ser atingido.

O custo aparece onde deve, na latência da hot wallet. ~150–165 tx/s numa única wallet dá ~6 ms por transação serializada (lock, 4 inserts, update com guarda de versão, commit com os constraint triggers diferidos). Com 32 na fila, a mediana fica em ~190 ms.

Um ponto fora da curva, registrado em vez de descartado: na execução 3 da hot wallet, uma requisição levou 2,9 s (p99 = 859 ms). Como nenhum lock timeout foi contado, a espera no lock ficou abaixo de 2 s. O resto deve ser uma pausa do host (GC ou fsync), propagada a toda a fila da wallet. Se uma wallet quente real precisar de mais vazão, a saída é de produto: sub-saldos ou um ledger de partidas dobradas com a conta da casa fora do caminho crítico. Afrouxar o lock não é opção (ver ARCHITECTURE §16).

### 5.4 Ingestão SQS

~150–205 msg/s com 3 ou 6 réplicas. Cada instância tem um laço de long-poll que recebe até 10 mensagens por ciclo e as processa em paralelo por grupo FIFO. Somando o mesmo efeito do §5.2 (6 réplicas não mudam o número), o limite provável é o emulador, que atende recebimento, deleção e as publicações da outbox no mesmo processo. Se o SQS real confirmar que o laço é o limite, os próximos passos seriam vários laços de recebimento por instância (a garantia de grupo do FIFO e a inbox já tornam isso seguro) ou mais réplicas com o papel `consumer`.

O que importa para correção: as ~250 duplicatas de cada execução foram absorvidas. Ficaram exatamente 5000 linhas na inbox e 5000 transações, e a fila terminou vazia, sem mensagem presa nem na DLQ.

## 6. Ameaças à validade

- **Uma máquina só.** Gerador, nginx, réplicas, PostgreSQL e LocalStack competem por CPU, memória e disco. Durante as execuções 2 e 3, a mesma máquina também rodou suítes de teste e um spike; isso provavelmente explica parte da variação (441–523 req/s).
- **LocalStack não é o SQS.** Latência, vazão e limites são do emulador.
- **Disco do WSL.** O fsync no disco virtual tem outro custo que um SSD dedicado ou um volume de nuvem.
- **Mix favorável.** Saldos grandes geram poucas rejeições, e os reenvios são idênticos, então não há conflitos `409` sob carga. Esses caminhos têm testes próprios de integração e concorrência.
- **Sem autenticação e sem tracing** durante a medição.
- **Contadores do Prometheus** com `increase()` são aproximados. Os números exatos de correção vêm do banco.
- **Closed loop** mede capacidade, não latência sob taxa fixa (§3).
