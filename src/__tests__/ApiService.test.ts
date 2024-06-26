import { Anomaly } from '@phnq/message';
import { get } from 'http';

import { ApiService, Context, Serializable, Service, ServiceClient } from '..';
import { ApiClient } from '../browser';
import { Handler } from '../Service';

const notificationsFruit: FruitNotification[] = [];
const notificationsVeg: FruitNotification[] = [];

describe('ApiService', () => {
  beforeAll(async () => {
    await fruitService.connect();
    await vegService.connect();
    await apiService.start();
    await fruitWsClientWrongPort.connect();
    await vegWsClient.connect();
  });

  afterAll(async () => {
    await fruitService.disconnect();
    await vegService.disconnect();
    await apiService.stop();
    await fruitWsClient.disconnect();
    await fruitWsClientWrongPort.disconnect();
    await vegWsClient.disconnect();
    await fruitClient.disconnect();
  });

  beforeEach(() => {
    notificationsFruit.length = 0;
    notificationsVeg.length = 0;
  });

  it('throws if client url port is wrong', async () => {
    let theErr: unknown;
    try {
      const resp = await fruitWsClientWrongPort.ping();
      expect(resp).not.toBe('pong');
      throw 'unreachable';
    } catch (err) {
      theErr = err;
    } finally {
      expect(theErr).not.toBe('unreachable');
    }
  });

  it('throws if client url path is wrong', async () => {
    try {
      await fruitWsClientWrongPath.ping();
      throw 'unreachable';
    } catch (err) {
      expect(err).not.toBe('unreachable');
    }
  });

  it('does ping from client', async () => {
    expect(await fruitWsClient.ping()).toBe('pong');
  });

  it('calls service method from another service', async () => {
    expect(await fruitWsClient.getKinds()).toStrictEqual(['apple', 'orange', 'pear']);
  });

  it('calls service iterator method from another service', async () => {
    const responses: string[] = [];
    for await (const response of await fruitWsClient.getKindsIterator()) {
      responses.push(response);
    }
    expect(responses).toStrictEqual(['apple', 'orange', 'pear']);
  });

  it('handles anomalies', async () => {
    try {
      await fruitWsClient.doErrors('anomaly');
      throw 'unreachable';
    } catch (err) {
      expect(err).not.toBe('unreachable');
    }
  });

  it('handles errors', async () => {
    try {
      await fruitWsClient.doErrors('error');
      throw 'unreachable';
    } catch (err) {
      expect(err).not.toBe('unreachable');
    }
  });

  it('uses client from service handler', async () => {
    expect(await fruitWsClient.getVeggies()).toStrictEqual(['carrot', 'celery', 'broccoli']);
    expect(notificationsFruit).toStrictEqual([{ bubba: 'gump', type: 'bubba' }]);
    expect(notificationsVeg).toStrictEqual([]);
  });

  it('responds with a 200 status for ping path', async () => {
    const statusCode = await new Promise<number | undefined>(resolve => {
      get('http://localhost:55777', resp => {
        resolve(resp.statusCode);
      });
    });
    expect(statusCode).toBe(200);
  });

  it('Does not allow access to methods starting with underscore (via API)', async () => {
    try {
      await fruitWsClient._noAccess();
      throw 'unreachable';
    } catch (err) {
      expect(err).not.toBe('unreachable');
    }
  });

  it('Does allow access to methods starting with underscore (via ServiceClient)', async () => {
    const secret = await fruitClient._noAccess();
    expect(secret).toBe('secret');
  });
});

// ========================== TEST INFRASTRUCTURE ==========================

const apiService = new ApiService({ port: 55777 });

interface FruitNotification {
  type: 'bubba';
  bubba: string;
}

const vegWsClient = ApiClient.create<VegApi, FruitNotification>('vegWs', 'ws://localhost:55777', n => {
  notificationsVeg.push(n);
});

const fruitWsClient = ApiClient.create<FruitApi, FruitNotification>('fruitWs', 'ws://localhost:55777', n => {
  notificationsFruit.push(n);
});

const fruitClient = ServiceClient.create<FruitApi>('fruitWs');

const fruitWsClientWrongPort = ApiClient.create<FruitApi>('fruitWs', 'ws://localhost:55778');
const fruitWsClientWrongPath = ApiClient.create<FruitApi>('fruitWs', 'ws://localhost:55777/wrong-path');

interface VegApi {
  domain: 'vegWs';
  handlers: {
    getKinds(): Promise<string[]>;
  };
}

const getVegKinds: Handler<VegApi, 'getKinds'> = async () => {
  if (Context.current.get('bubba') !== 'gump') {
    throw new Error('Nope');
  }

  await Context.current.notify<FruitNotification>({ type: 'bubba', bubba: 'gump' });

  return ['carrot', 'celery', 'broccoli'];
};

const vegService = new Service<VegApi>('vegWs', {
  handlers: { getKinds: getVegKinds },
});

interface FruitApi {
  domain: 'fruitWs';
  handlers: {
    getKinds(): Promise<string[]>;
    getKindsIterator(): Promise<AsyncIterableIterator<string>>;
    doErrors(type: 'error' | 'anomaly' | 'none'): Promise<void>;
    getFromContext(key: string): Promise<Serializable | undefined>;
    getVeggies(): Promise<string[]>;
    _noAccess(): Promise<string>;
  };
}

const getKinds: Handler<FruitApi, 'getKinds'> = async () => ['apple', 'orange', 'pear'];

const getKindsIterator: Handler<FruitApi, 'getKindsIterator'> = async () =>
  (async function* () {
    yield 'apple';
    yield 'orange';
    yield 'pear';
  })();

const doErrors: Handler<FruitApi, 'doErrors'> = async type => {
  switch (type) {
    case 'anomaly':
      throw new Anomaly('the anomaly');

    case 'error':
      throw new Error('the error');
  }
};

const getFromContext: Handler<FruitApi, 'getFromContext'> = async key => {
  Context.current.set('private', 'only4me');

  if (getMyData() !== 'only4me') {
    throw new Error('Did not get private data');
  }

  return Context.current.get(key);
};

const getMyData = (): string | undefined => {
  return Context.current.get<string>('private');
};

const getVeggies: Handler<FruitApi, 'getVeggies'> = async () => {
  Context.current.set('bubba', 'gump');
  const vegClient = Context.current.getClient<VegApi>('vegWs');
  return await vegClient.getKinds();
};

const _noAccess: Handler<FruitApi, '_noAccess'> = async () => {
  return 'secret';
};

const fruitService = new Service<FruitApi>('fruitWs', {
  handlers: { getKinds, getKindsIterator, doErrors, getFromContext, getVeggies, _noAccess },
});
