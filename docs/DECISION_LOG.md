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
