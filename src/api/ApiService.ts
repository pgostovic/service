import { createLogger } from '@phnq/log';
import { MessageConnection } from '@phnq/message';
import { WebSocketMessageServer } from '@phnq/message/WebSocketMessageServer';
import http from 'http';

import Context, { ContextData } from '../Context';
import { API_SERVICE_DOMAIN } from '../domains';
import Service from '../Service';
import { ApiRequestMessage, ApiResponseMessage, NotifyApi } from './ApiMessage';

const log = createLogger('ApiService');

interface Config {
  port: number;
  transformResponsePayload?: (payload: unknown, message: ApiRequestMessage) => unknown;
  transformRequestPayload?: (payload: unknown, message: ApiRequestMessage) => unknown;
  path?: string;
  pingPath?: string;
}

class ApiService extends Service<NotifyApi> {
  private apiServiceConfig: Config;
  private httpServer: http.Server;
  private wsServer: WebSocketMessageServer<ApiRequestMessage, ApiResponseMessage>;

  constructor(config: Config) {
    super(API_SERVICE_DOMAIN, {
      ...config,
      handlers: {
        notify: async m => {
          const conn = this.wsServer.getConnection(m.recipient.id);
          if (conn) {
            conn.send({ domain: API_SERVICE_DOMAIN, method: 'notify', payload: m.payload });
          }
        },
      },
    });

    this.apiServiceConfig = config;

    const { path = '/', pingPath = path } = config;

    this.httpServer = http.createServer();
    this.wsServer = new WebSocketMessageServer<ApiRequestMessage, ApiResponseMessage>({
      path,
      httpServer: this.httpServer,
    });
    this.httpServer.on('request', (req, res) => {
      if (req.url === pingPath) {
        res.writeHead(200);
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    this.wsServer.onConnect = (conn, req) => this.onConnect(conn, req);
    this.wsServer.onReceive = (conn, message) => this.onReceiveClientMessage(conn, message);
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
    conn: MessageConnection<ApiRequestMessage, ApiResponseMessage>,
    req: http.IncomingMessage,
  ): Promise<void> {
    conn.setData('langs', getLangs(req));
  }

  private async onReceiveClientMessage(
    conn: MessageConnection<ApiRequestMessage, ApiResponseMessage>,
    requestMessage: ApiRequestMessage,
  ): Promise<ApiResponseMessage | AsyncIterableIterator<ApiResponseMessage>> {
    const { domain, method, payload: payloadRaw } = requestMessage;
    const { transformRequestPayload = p => p, transformResponsePayload = p => p } = this.apiServiceConfig;

    const payload = transformRequestPayload(payloadRaw, requestMessage);

    const context: ContextData = {
      identity: conn.getData<string | undefined>('identity'),
      langs: conn.getData<string[]>('langs'),
      connectionId: conn.id,
    };

    const serviceClient = this.getClient<{
      [key: string]: (payload: unknown) => Promise<unknown | AsyncIterableIterator<unknown>>;
    }>(domain);

    return Context.apply<ApiResponseMessage | AsyncIterableIterator<ApiResponseMessage>>(context, async () => {
      const response = await serviceClient[method](payload);
      if (typeof response === 'object' && (response as AsyncIterableIterator<unknown>)[Symbol.asyncIterator]) {
        return (async function* (): AsyncIterableIterator<ApiResponseMessage> {
          for await (const payload of response as AsyncIterableIterator<unknown>) {
            conn.setData('identity', Context.current.identity);
            yield { payload: transformResponsePayload(payload, requestMessage), stats: 0 };
          }
        })();
      } else {
        conn.setData('identity', Context.current.identity);
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
