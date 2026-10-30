/**
 * Live demonstration against the running stack (`docker compose up -d --build --wait`):
 *
 *   bun run demo            # correctness scenarios through nginx and the 3 replicas
 *   bun run demo --chaos    # plus: kill a replica (SIGKILL) in the middle of the traffic
 *
 * Every scenario checks its own outcome and the script exits non-zero on any surprise. The
 * crash *between commit and ack* at an exact point is a test, not a demo step:
 * `bun test test/concurrency/crash-recovery.test.ts`.
 *
 * Env: DEMO_BASE_URL (default http://localhost:8080), DOCKER (command used for --chaos,
 * default `docker`). Requires AUTH_MODE=disabled.
 */
const baseUrl = process.env.DEMO_BASE_URL ?? 'http://localhost:8080';
const docker = (process.env.DOCKER ?? 'docker').split(' ');
const chaos = process.argv.includes('--chaos');
const PROVIDER = 'demo-provider';
const runId = Bun.randomUUIDv7().slice(-8);
const touchedWallets: string[] = [];
let failures = 0;

// --- output -------------------------------------------------------------------------------------

const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const title = (text: string) => console.log(`\n${bold(text)}`);
const say = (text: string) => console.log(`  ${dim(text)}`);
function check(condition: boolean, text: string) {
  console.log(`  ${condition ? '\x1b[32m✔' : '\x1b[31m✘'}\x1b[0m ${text}`);
  if (!condition) failures += 1;
}

// --- API ----------------------------------------------------------------------------------------

interface Wallet {
  readonly id: string;
  readonly playerId: string;
}

async function call(method: string, path: string, body?: unknown, key?: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  // biome-ignore lint/suspicious/noExplicitAny: demo output, fields are read by name
  return { status: response.status, body: (await response.json().catch(() => ({}))) as any };
}

async function openWallet(amount: string): Promise<Wallet> {
  const playerId = Bun.randomUUIDv7();
  const response = await call('POST', '/wallets', {
    playerId,
    initialBalance: { amount, currency: 'BRL' },
  });
  if (response.status !== 201) throw new Error(`wallet: ${JSON.stringify(response.body)}`);
  touchedWallets.push(response.body.id);
  return { id: response.body.id, playerId };
}

function wager(wallet: Wallet, kind: string, amount: string, extra: Record<string, unknown> = {}) {
  const externalTransactionId = `demo-${runId}-${Bun.randomUUIDv7()}`;
  const body = {
    providerId: PROVIDER,
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: `round-${runId}`,
    gameId: 'demo-game',
    kind,
    money: { amount, currency: 'BRL' },
    ...extra,
  };
  return {
    body,
    key: `${PROVIDER}:${externalTransactionId}`,
    send: () =>
      call('POST', '/wagering/transactions', body, `${PROVIDER}:${externalTransactionId}`),
  };
}

const RETRYABLE = new Set([502, 503, 504]);

/** What a provider does on a network error or a gateway/transient status: resend it unchanged. */
async function untilAnswered(send: () => ReturnType<typeof call>) {
  for (let attempt = 1; ; attempt++) {
    const response = await send().catch((error: unknown) => {
      if (attempt === 5) throw error;
      return undefined;
    });
    if (response !== undefined && (!RETRYABLE.has(response.status) || attempt === 5)) {
      return response;
    }
    await Bun.sleep(250 * attempt);
  }
}

const balanceOf = async (wallet: Wallet) =>
  (await call('GET', `/wallets/${wallet.id}`)).body.balance.amount as string;

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await Bun.sleep(200);
  }
  return false;
}

// --- scenarios ----------------------------------------------------------------------------------

async function lastCoinRace() {
  title('1. Saldo 100.00, duas apostas de 80.00 ao mesmo tempo');
  const wallet = await openWallet('100.00');
  const [a, b] = await Promise.all([
    wager(wallet, 'BET', '80.00').send(),
    wager(wallet, 'BET', '80.00').send(),
  ]);
  const statuses = [a.status, b.status].sort();
  say(`respostas: ${statuses.join(' e ')}`);
  check(statuses[0] === 200 && statuses[1] === 422, 'exatamente uma aceita, a outra 422');
  const rejected = a.status === 422 ? a : b;
  check(rejected.body.failureCode === 'INSUFFICIENT_FUNDS', 'a recusada diz INSUFFICIENT_FUNDS');
  check((await balanceOf(wallet)) === '20.00', 'saldo final 20.00 — nunca negativo');
}

async function fiftyIdenticalRequests() {
  title('2. A mesma aposta enviada 50 vezes em paralelo (retries de um provedor)');
  const wallet = await openWallet('100.00');
  const bet = wager(wallet, 'BET', '10.00');
  const responses = await Promise.all(Array.from({ length: 50 }, () => bet.send()));
  const fresh = responses.filter((r) => r.status === 200 && !r.body.idempotentReplay).length;
  const replays = responses.filter((r) => r.status === 200 && r.body.idempotentReplay).length;
  say(`${fresh} processada, ${replays} replays, distribuídos entre as réplicas`);
  check(fresh === 1 && replays === 49, 'um único processamento, 49 replays com a mesma resposta');
  check((await balanceOf(wallet)) === '90.00', 'debitado uma vez só: saldo 90.00');
  const ledger = await call('GET', `/wallets/${wallet.id}/ledger`);
  check(ledger.body.items.length === 2, 'ledger: abertura + 1 débito');
}

async function outOfOrderReference() {
  title('3. REFUND chega antes da aposta que ele estorna');
  const wallet = await openWallet('100.00');
  const bet = wager(wallet, 'BET', '30.00');
  const refund = wager(wallet, 'REFUND', '30.00', {
    referenceExternalTransactionId: bet.body.externalTransactionId,
  });
  const early = await refund.send();
  check(early.status === 202, `REFUND sem referência → 202 ${early.body.status}`);
  check((await bet.send()).status === 200, 'a aposta chega → 200 (saldo 70.00 por um instante)');
  const resolved = await waitFor(
    async () =>
      (await call('GET', `/wagering/transactions/${early.body.transactionId}`)).body.status ===
      'PROCESSED',
    15_000,
  );
  check(resolved, 'o worker resolve o REFUND pendente');
  check((await balanceOf(wallet)) === '100.00', 'saldo de volta a 100.00');
}

async function killReplicaUnderTraffic() {
  title('4. Uma réplica morre (SIGKILL) no meio do tráfego');
  const ps = Bun.spawnSync([...docker, 'compose', 'ps', '-q', 'app']);
  const containers = ps.stdout.toString().trim().split('\n').filter(Boolean);
  if (ps.exitCode !== 0 || containers.length < 2) {
    check(false, `precisa de 2+ réplicas e do docker (${docker.join(' ')})`);
    return;
  }
  const wallets = await Promise.all(Array.from({ length: 20 }, () => openWallet('1000.00')));
  const bets = Array.from({ length: 400 }, (_, i) =>
    wager(wallets[i % wallets.length] as Wallet, 'BET', '1.00'),
  );
  let sent = 0;
  const traffic = Promise.all(
    Array.from({ length: 16 }, async () => {
      while (sent < bets.length) {
        const bet = bets[sent++];
        if (bet) await bet.send().catch(() => undefined);
      }
    }),
  );
  await Bun.sleep(300);
  const victim = containers[0] as string;
  say(`docker kill ${victim.slice(0, 12)} com o tráfego em andamento`);
  Bun.spawnSync([...docker, 'kill', victim]);
  await traffic;

  // A provider resends whatever it did not get an answer for; resending everything is the
  // strongest check: every request must now have exactly one outcome.
  const outcomes = await Promise.all(bets.map((bet) => untilAnswered(bet.send)));
  const processed = outcomes.filter((r) => r.status === 200).length;
  const byStatus = new Map<string, number>();
  for (const r of outcomes) {
    const key = `${r.status} ${r.body.code ?? r.body.status}`;
    byStatus.set(key, (byStatus.get(key) ?? 0) + 1);
  }
  say(`reenvio: ${[...byStatus].map(([key, count]) => `${count}× ${key}`).join(', ')}`);
  check(processed === bets.length, `${processed}/${bets.length} apostas com desfecho único`);
  const balances = await Promise.all(wallets.map(balanceOf));
  const total = balances.reduce((cents, amount) => cents + BigInt(amount.replace('.', '')), 0n);
  check(total === 2_000_000n - 40_000n, 'soma dos saldos = 20 × 1000.00 − 400 × 1.00');
  say('reiniciando a réplica');
  Bun.spawnSync([...docker, 'compose', 'up', '-d', '--wait', 'app']);
}

async function reconcileEverything() {
  title(`Reconciliação de todas as ${touchedWallets.length} wallets usadas`);
  const results = await Promise.all(
    touchedWallets.map((id) => call('POST', `/wallets/${id}/reconciliation`)),
  );
  check(
    results.every((r) => r.body.consistent === true),
    'saldo == Σ ledger em todas (comparação em numeric no PostgreSQL)',
  );
}

// --- main ---------------------------------------------------------------------------------------

const ready = await fetch(`${baseUrl}/health/ready`).catch(() => undefined);
if (ready?.status !== 200) {
  console.error(`${baseUrl} não está pronto. Suba o stack: docker compose up -d --build --wait`);
  process.exit(1);
}
console.log(bold(`Demo contra ${baseUrl}`));
await lastCoinRace();
await fiftyIdenticalRequests();
await outOfOrderReference();
if (chaos) await killReplicaUnderTraffic();
await reconcileEverything();
console.log(failures === 0 ? `\n${bold('Tudo certo.')}` : `\n${bold(`${failures} falha(s).`)}`);
process.exit(failures === 0 ? 0 : 1);

export {}; // a module: top-level await
