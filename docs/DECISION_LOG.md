# Diário de decisões

> **Como chegamos** às decisões: achados de spike, mudanças de rumo, becos sem saída e interpretações do enunciado.
> O estado **atual** de cada decisão vive no [ARCHITECTURE.md](../ARCHITECTURE.md); o que mudou no código, no `git log`.
>
> Regras: só se acrescenta (entradas novas no fim, nunca se reescreve uma antiga — se mudou de ideia, crie outra entrada que a substitua); 3 a 5 linhas por entrada; só registre o que não está em outro lugar.

Formato:

```
### DL-NNN · AAAA-MM-DD · Título curto
**Contexto:** o que motivou.  **Decisão/achado:** o que foi decidido ou descoberto.
**Consequência:** o que muda daqui em diante.  **Ref:** ADR, commit, teste.
```

---

### DL-001 · 2026-10-29 · Uma reversão por referência, independente do tipo
**Contexto:** a regra 4 do enunciado proíbe reverter a mesma referência duas vezes "pelo mesmo tipo de operação", o que permitiria `REFUND` + `ROLLBACK` sobre a mesma `BET`.
**Decisão:** no máximo uma reversão efetiva por referência; a leitura literal creditaria duas vezes e violaria a invariante de não duplicar créditos.
**Consequência:** índice único parcial em `reference_transaction_id` para `REFUND`/`ROLLBACK` processados. **Ref:** ARCHITECTURE §14 (I-01).

### DL-002 · 2026-10-29 · Versões resolvidas mais novas que o planejado
**Contexto:** o planejamento não fixou versões; o `bun add` resolveu NestJS 12, MikroORM 7.2, TypeScript 7 (`tsc` nativo) e zod 4, majors mais novos que as APIs que eu conhecia.
**Decisão:** ficar nas versões novas e validar tudo no spike, em vez de fixar versões antigas.
**Consequência:** MikroORM 7 é ESM-only e sem knex; a API foi conferida nos `.d.ts` instalados, não de memória. **Ref:** ARCHITECTURE §13.1.

### DL-003 · 2026-10-29 · Docker roda dentro do WSL, não no Docker Desktop
**Contexto:** a máquina de desenvolvimento não tem Docker Desktop; o Docker Engine roda na distro Ubuntu do WSL, que desligava sozinha após segundos ociosa e derrubava os containers.
**Decisão:** `.wslconfig` com `instanceIdleTimeout=-1` e `vmIdleTimeout=-1` (chaves confirmadas no binário do WSL 3.0.3); o Compose é chamado via `wsl -d Ubuntu --cd …`.
**Consequência:** testes de integração rodam do Windows contra `localhost`; testes de sinal POSIX continuam indo para Linux/CI. **Ref:** README, CLAUDE.md.

### DL-004 · 2026-10-29 · CLI de migrations próprio
**Contexto:** o CLI do MikroORM depende de descoberta de arquivos e de carregar TypeScript, ponto de atrito conhecido com Bun.
**Decisão:** `scripts/migrate.ts` sobre `orm.migrator`, com `migrationsList` explícito e migrations em SQL escrito à mão.
**Consequência:** `up → down → up` funcionou de primeira sob Bun, local e no CI; `migration:create` regenera o índice. **Ref:** ADR-011, `migrations.test.ts`.

### DL-005 · 2026-10-29 · MikroORM não reconhece lock timeout do PostgreSQL
**Contexto:** o design prevê `SET LOCAL lock_timeout` e retry para erros transitórios; esperávamos `LockWaitTimeoutException`.
**Achado:** o conversor do MikroORM 7 para PostgreSQL mapeia `40P01` mas não `55P03`; o erro chega como `DriverException` genérica com `code: '55P03'`.
**Consequência:** a classificação de transitórios (S3-02) usará o SQLSTATE em `err.code`, nunca a classe. **Ref:** `mikro-orm-spike.test.ts`, ARCHITECTURE §6 e §13.1.

### DL-006 · 2026-10-29 · TypeScript 7 removeu `baseUrl`
**Contexto:** o `tsconfig` previa aliases (`@domain/*` etc.).
**Decisão:** abandonar aliases e usar imports relativos sem extensão.
**Consequência:** nenhuma configuração de resolução extra para Bun, `tsc` e Biome. **Ref:** `tsconfig.json`.

### DL-007 · 2026-10-29 · Roles de banco antecipados para o Sprint 0
**Contexto:** roles só são criados pelo init do Postgres em volume vazio; adiá-los ao Sprint 2 exigiria recriar o volume.
**Decisão:** `wallet_owner`/`wallet_app` no init do Compose e grants na migration `bootstrap` (S2-01 antecipado).
**Consequência:** desde o primeiro teste, a app roda sem `DELETE`/`TRUNCATE`/DDL; os testes de integração usam esse role. **Ref:** ADR-012, `migrations.test.ts`.

### DL-008 · 2026-10-29 · CI falhava com a suíte de concorrência vazia
**Contexto:** o primeiro CI falhou só em `test:concurrency`; localmente (Windows) o mesmo comando saía com 0.
**Achado:** o git não versiona pasta vazia; no checkout a pasta não existe, e `bun test --preload` com caminho inexistente sai com 1 sem mensagem. Reproduzido num container `oven/bun:1.4.4`.
**Consequência:** `test/concurrency/.gitkeep` até o Sprint 3; diferenças Windows × Linux passam a ser checadas em container antes de "corrigir no escuro". **Ref:** commit `4ec6ef0`.

### DL-009 · 2026-10-29 · Backoff do domínio sem jitter
**Contexto:** o plano previa backoff exponencial "com jitter" para outbox e `PENDING_REFERENCE`; jitter exige aleatoriedade, e o lint proíbe `Math` no domínio.
**Decisão:** backoff determinístico (`base · 2^n`, com teto) em `domain/shared/backoff.ts`; publishers e workers concorrentes já se evitam com `FOR UPDATE SKIP LOCKED`, então jitter não compra nada ali.
**Consequência:** sequências de retry testáveis com valores exatos (`2, 4, 8 … 300, 300`). Jitter, se necessário, fica no retry de infraestrutura (S3-02). **Ref:** ARCHITECTURE §8.3.

### DL-010 · 2026-10-29 · Referências de BET, WIN e LOSS
**Contexto:** o enunciado só detalha referências de `REFUND`/`ROLLBACK`; `WIN` "pode referenciar" e `BET` não é mencionado.
**Decisão:** `BET` com referência é payload inválido; `WIN`/`LOSS` apontando para algo que não é `BET` é `REFERENCE_MISMATCH` (não `REFERENCE_KIND_NOT_REVERSIBLE`, reservado às reversões).
**Consequência:** o caso `default` da `WagerPolicy` vira inalcançável por construção. **Ref:** ARCHITECTURE §14 (I-12, I-13).

### DL-011 · 2026-10-29 · Atrito do lint anti-`number` no domínio
**Contexto:** a regra que proíbe `Number`/`Math`/`parseFloat` em `domain`/`application` também bloqueou usos legítimos: checar que `version` é inteiro e a sugestão do próprio Biome de usar `Math.min`.
**Decisão:** um único ponto sancionado (`isNonNegativeInteger` em `domain/shared/guards.ts`, com `biome-ignore` justificado) e `useMathMinMax` desligado onde `Math` é proibido.
**Consequência:** a regra continua ampla; cada exceção é explícita e localizada. **Ref:** `biome.json`.

### DL-012 · 2026-10-29 · "Saldo == ledger" precisava valer nos dois sentidos
**Contexto:** o plano (ADR-007) previa um trigger diferido em `wallets`. Ao escrever os testes de violação, ficou claro que isso garante "saldo ⇒ lançamento", mas uma `BET` `PROCESSED` sem lançamento (e sem mexer no saldo) passaria.
**Decisão:** mais dois constraint triggers diferidos: lançamento exige transação `PROCESSED` de mesmo valor, e transação `PROCESSED` que move dinheiro exige seu lançamento; e FKs compostas prendendo o lançamento à wallet, à moeda e à transação certas.
**Consequência:** a invariante "toda alteração de saldo tem lançamento e vice-versa" (§6.2) agora é inteira do schema. **Ref:** ARCHITECTURE §5.1, `schema-constraints.test.ts`.

### DL-013 · 2026-10-29 · Snapshot de replay precisa da própria moeda
**Contexto:** o replay devolve o saldo observado no processamento original; ao mapear, notei que uma rejeição `CURRENCY_MISMATCH` (operação em USD numa wallet BRL) gravaria o saldo da wallet rotulado com a moeda da operação.
**Decisão:** coluna `result_balance_currency`, com CHECK de par (valor e moeda juntos). Corrigido na própria migration, ainda não publicada; o banco local de desenvolvimento foi recriado porque a versão antiga já estava aplicada.
**Consequência:** regra prática: migration só é editada enquanto não foi commitada; depois disso, sempre uma nova. **Ref:** `repositories.test.ts` (snapshot keeps its own currency).

### DL-014 · 2026-10-29 · MikroORM sem dirty-checking nas escritas financeiras
**Contexto:** o desafio destaca Unit of Work e Identity Map do MikroORM; mas o `flush()` decide sozinho a ordem dos statements, e os triggers/FKs compostas exigem transação antes do lançamento, além do `UPDATE … WHERE version = ?` com contagem de linhas.
**Decisão:** o ORM gerencia transação, metadata, consultas e locks; escritas são `em.insert`/`em.nativeUpdate` explícitas, em ordem fixa, e leituras usam `disableIdentityMap`.
**Consequência:** nenhum efeito colateral implícito no commit; o custo é escrever os updates à mão. **Ref:** ADR-013.
