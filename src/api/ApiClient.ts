import { WebSocketMessageClient } from '@phnq/message/WebSocketMessageClient';

import AuthApi from '../auth/AuthApi';
import { API_SERVICE_DOMAIN } from '../domains';
import { ServiceApi } from '../Service';
import { StandaloneClient } from '../ServiceClient';
import { ApiRequestMessage, ApiResponseMessage } from './ApiMessage';

class ApiClient {
  public static createAuthClient(url: string): AuthApi['handlers'] & Omit<StandaloneClient, 'stats' | 'getStats'> {
    return this.create<AuthApi>('phnq-auth', url);
  }

  public static create<
    T extends ServiceApi<D>,
    N extends { type: string } | undefined = undefined,
    D extends string = T['domain'],
  >(domain: D, url: string, onNotify?: (msg: N) => void): T['handlers'] & Omit<StandaloneClient, 'stats' | 'getStats'> {
    let wsClient: WebSocketMessageClient<ApiRequestMessage, ApiResponseMessage> | undefined;
    return new Proxy(
      {},
      {
        get: (_, method: string) => {
          if (method === 'isConnected') {
            return wsClient !== undefined && wsClient.isOpen();
          } else if (['stats', 'getStats'].includes(method)) {
            throw new Error(`Method not available in client: ${method}`);
          }

          return async (payload: unknown) => {
            if (method === 'disconnect') {
              if (wsClient !== undefined && wsClient.isOpen()) {
                await wsClient.close();
              }
              return;
            }

            if (!wsClient) {
              wsClient = WebSocketMessageClient.create<ApiRequestMessage, ApiResponseMessage>(url);

              wsClient.addReceiveHandler(async ({ domain: notifyDomain, method, payload }) => {
                if (onNotify && [domain, API_SERVICE_DOMAIN].includes(notifyDomain)) {
                  switch (method) {
                    case 'notify':
                      return onNotify(payload as N);
                  }
                }
              });
            }

            if (method === 'connect') {
              // connect is handled lazily in WebSocketMessageClient.
              return;
            }

            const response = await wsClient.request({ domain, method, payload });

            if (
              typeof response === 'object' &&
              (response as AsyncIterableIterator<ApiResponseMessage>)[Symbol.asyncIterator]
            ) {
              const responseIter = response as AsyncIterableIterator<ApiResponseMessage>;
              return (async function* () {
                for await (const { payload } of responseIter) {
                  yield payload;
                }
              })();
            } else {
              return (response as ApiResponseMessage).payload;
            }
          };
        },
      },
    ) as T['handlers'] & StandaloneClient;
  }
}

export default ApiClient;
