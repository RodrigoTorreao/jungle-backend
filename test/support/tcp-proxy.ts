import net from 'node:net';

/**
 * A TCP relay between the app and one dependency (PostgreSQL, LocalStack) that a test can cut
 * and restore: `stop()` drops every open connection (ECONNRESET) and refuses new ones
 * (ECONNREFUSED) — what a real outage looks like to the driver — and `start()` brings the same
 * port back.
 */
export class TcpProxy {
  private server: net.Server | undefined;
  private readonly sockets = new Set<net.Socket>();

  private constructor(
    private readonly target: { host: string; port: number },
    private listenPort: number,
  ) {}

  static async create(target: { host: string; port: number }): Promise<TcpProxy> {
    const proxy = new TcpProxy(target, 0);
    await proxy.start();
    return proxy;
  }

  get port(): number {
    return this.listenPort;
  }

  /** Rewrites `url` so it goes through this proxy. */
  wrap(url: string): string {
    const parsed = new URL(url);
    parsed.hostname = '127.0.0.1';
    parsed.port = String(this.listenPort);
    return parsed.toString();
  }

  start(): Promise<void> {
    if (this.server !== undefined) {
      return Promise.resolve();
    }
    const server = net.createServer((client) => {
      const upstream = net.connect(this.target.port, this.target.host);
      this.sockets.add(client);
      this.sockets.add(upstream);
      const teardown = () => {
        client.destroy();
        upstream.destroy();
        this.sockets.delete(client);
        this.sockets.delete(upstream);
      };
      client.on('error', teardown).on('close', teardown);
      upstream.on('error', teardown).on('close', teardown);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.listenPort, '127.0.0.1', () => {
        const address = server.address();
        if (address !== null && typeof address === 'object') {
          this.listenPort = address.port;
        }
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    if (server !== undefined) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}
