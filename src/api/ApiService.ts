import { createLogger } from '@phnq/log';
import { Anomaly, MessageConnection } from '@phnq/message';
import { WebSocketMessageServer } from '@phnq/message/WebSocketMessageServer';
import { readFileSync } from 'fs';
import http from 'http';
import https from 'https';

import Context, { ContextData } from '../Context';
import { API_SERVICE_DOMAIN } from '../domains';
import Service from '../Service';
import ServiceClient from '../ServiceClient';
import { ApiRequestMessage, ApiResponseMessage, NotifyApi } from './ApiMessage';

const log = createLogger('ApiService');

interface Config {
  secure?: false;
  port: number;
  transformResponsePayload?: (payload: unknown, message: ApiRequestMessage) => unknown;
  transformRequestPayload?: (payload: unknown, message: ApiRequestMessage) => unknown;
  path?: string;
  pingPath?: string;
  logConnections?: boolean;
}

interface SecureConfig extends Omit<Config, 'secure'> {
  secure: true;
  keyPath: string;
  certPath: string;
}

interface ConnectionAttributes {
  langs: string[];
  identity?: string;
}

class ApiService<A = never> extends Service<NotifyApi> {
  private apiServiceConfig: Config | SecureConfig;
  private wsServer: WebSocketMessageServer<ApiRequestMessage, ApiResponseMessage, ConnectionAttributes & A>;
  private readonly _httpServer: http.Server;
  public onHttpRequest: (
    req: http.IncomingMessage,
    res: http.ServerResponse<http.IncomingMessage> & {
      req: http.IncomingMessage;
    },
  ) => void = (_, res) => {
    res.writeHead(404);
    res.end();
  };

  constructor(config: Config | SecureConfig) {
    super('_phnq-api', {
      ...config,
      handlers: {
        notify: async m => {
          const conn = this.wsServer.getConnection(m.recipient.id);
          if (conn) {
            conn.send({ domain: m.domain || API_SERVICE_DOMAIN, method: 'notify', payload: m.payload });
          }
        },
      },
    });

    this.apiServiceConfig = config;

    const { path = '/', pingPath = path, secure } = config;

    if (secure) {
      const { keyPath, certPath } = config as SecureConfig;
      this._httpServer = https.createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) });
    } else {
      this._httpServer = http.createServer();
    }

    this.wsServer = new WebSocketMessageServer<ApiRequestMessage, ApiResponseMessage, ConnectionAttributes & A>({
      path,
      httpServer: this.httpServer,
    });
    this.httpServer.on('request', (req, res) => {
      if (req.url === pingPath) {
        res.writeHead(200);
        res.end();
      } else {
        this.onHttpRequest(req, res);
      }
    });
    this.wsServer.onConnect = (conn, req) => this.onConnect(conn, req);
    this.wsServer.onDisconnect = conn => this.onDisconnect(conn);
    this.wsServer.onReceive = (conn, message) => this.onReceiveClientMessage(conn, message);
  }

  get httpServer(): http.Server {
    return this._httpServer;
  }

  public async start(): Promise<void> {
    const { port } = this.apiServiceConfig;

    log('Starting server...');
    await new Promise<void>((resolve, reject): void => {
      try {
        this.httpServer.listen({ port: port }, resolve);
      } catch (err) {
        reject(err);
      }
    });
    log('Server listening on port %d', port);

    log('Connecting to pub/sub...');
    await this.connect();
    log('Connected to pub/sub.');
  }

  public async stop(): Promise<void> {
    log('Stopping server...');
    await this.wsServer.close();

    if (this.httpServer.listening) {
      await new Promise<void>((resolve, reject): void => {
        try {
          this.httpServer.close((): void => {
            resolve();
          });
        } catch (err) {
          reject(err);
        }
      });
    }

    log('Disconnecting from pub/sub...');
    await this.disconnect();

    log('Stopped.');
  }

  /**
   * This is where WebSocket connections are established. Both the initial
   * HTTP request and the underlying MessageConnection abstraction are available
   * here as parameters. It is a convenient place to harvest headers from the
   * HTTP request for the purpose of storing connection-persisnet data.
   */
  private async onConnect(
    conn: MessageConnection<ApiRequestMessage, ApiResponseMessage, ConnectionAttributes>,
    req: http.IncomingMessage,
  ): Promise<void> {
    if (this.apiServiceConfig.logConnections) {
      log('Connected:', conn.id);
    }
    conn.setAttribute('langs', getLangs(req));
  }

  private async onDisconnect(
    conn: MessageConnection<ApiRequestMessage, ApiResponseMessage, ConnectionAttributes>,
  ): Promise<void> {
    if (this.apiServiceConfig.logConnections) {
      log('Disconnected:', conn.id);
    }
  }

  private checkAccess(domain: string, method: string): void {
    if (domain.trim().charAt(0) === '_' || method.trim().charAt(0) === '_') {
      throw new Anomaly(`Inaccessible: ${domain}.${method}`);
    }
  }

  private async onReceiveClientMessage(
    conn: MessageConnection<ApiRequestMessage, ApiResponseMessage, ConnectionAttributes>,
    requestMessage: ApiRequestMessage,
  ): Promise<ApiResponseMessage | AsyncIterableIterator<ApiResponseMessage>> {
    const { domain, method, payload: payloadRaw } = requestMessage;

    this.checkAccess(domain, method);

    const { transformRequestPayload = p => p, transformResponsePayload = p => p } = this.apiServiceConfig;

    const payload = transformRequestPayload(payloadRaw, requestMessage);

    const contextData: ContextData = {
      originDomain: domain,
      identity: conn.getAttribute('identity'),
      langs: conn.getAttribute('langs'),
      connectionId: conn.id,
    };

    const serviceClient = ServiceClient.get<{
      domain: typeof domain;
      handlers: Record<string, (payload: unknown) => Promise<unknown | AsyncIterableIterator<unknown>>>;
    }>(domain);

    return Context.apply(contextData, async () => {
      const response = await serviceClient[method](payload);
      if (typeof response === 'object' && (response as AsyncIterableIterator<unknown>)[Symbol.asyncIterator]) {
        return (async function* (): AsyncIterableIterator<ApiResponseMessage> {
          Context.apply(contextData);
          for await (const payload of response as AsyncIterableIterator<unknown>) {
            conn.setAttribute('identity', Context.current.identity);
            yield { payload: transformResponsePayload(payload, requestMessage), stats: 0 };
          }
        })();
      } else {
        conn.setAttribute('identity', Context.current.identity);
        return { payload: transformResponsePayload(response, requestMessage), stats: 0 };
      }
    });
  }
}

export default ApiService;

const getLangs = (req: http.IncomingMessage): string[] => {
  const acceptLangHeader = req.headers['accept-language'];
  if (acceptLangHeader) {
    return acceptLangHeader.split(',').map(lang => lang.split(';')[0]);
  }
  return ['en'];
};
