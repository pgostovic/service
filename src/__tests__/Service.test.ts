import { matchCategory } from '@phnq/log';
import { Anomaly } from '@phnq/message';

import { Context, Serializable, Service, ServiceClient } from '..';

if (process.env.PHNQ_MESSAGE_LOG_NATS === '1') {
  matchCategory(/.+/);
}

describe('Service', () => {
  beforeAll(async () => {
    await fruitService.connect();
    await vegService.connect();
  });

  afterAll(async () => {
    await fruitService.disconnect();
    await fruitClient.disconnect();
    await vegService.disconnect();
  });

  it('does latency test', async () => {
    expect(typeof (await fruitService.testLatency())).toBe('number');
  });

  it('does ping from client', async () => {
    expect(await fruitClient.ping()).toBe('pong');
  });

  it('calls service method from another service', async () => {
    expect(await fruitClient.getKinds()).toStrictEqual(['apple', 'orange', 'pear']);
  });

  it('calls service iterator method from another service', async () => {
    const responses: string[] = [];
    for await (const response of await fruitClient.getKindsIterator()) {
      responses.push(response);
    }
    expect(responses).toStrictEqual(['apple', 'orange', 'pear']);
  });

  it('throws if connection fails', async () => {
    try {
      await ServiceClient.create<FruitApi>('fruit', {
        signSalt: 'abcd1234',
        nats: { servers: ['nats://localhost:4225'] }, // wrong port
      }).connect();
      fail('should have thrown');
    } catch (err) {
      // do nothing
    }
  });

  it('handles anomalies', async () => {
    try {
      await fruitClient.doErrors('anomaly');
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(Anomaly);
    }
  });

  it('handles errors', async () => {
    try {
      await fruitClient.doErrors('error');
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
    }
  });

  it('throws when setting a handler without a domain', () => {
    const anonService = new Service({
      signSalt: 'abcd1234',
      nats: { servers: ['nats://localhost:4224'] },
    });

    expect(() => {
      anonService.addHandler('nope', () => Promise.resolve('yo'));
    }).toThrow();
  });

  it('throws when testing latency without a domain', async () => {
    const anonService = new Service({
      signSalt: 'abcd1234',
      nats: { servers: ['nats://localhost:4224'] },
    });

    try {
      await anonService.testLatency();
      fail('should have thrown');
    } catch (err) {
      // nothing
    }

    await anonService.disconnect();
  });

  it('returns client connected state', async () => {
    const client = ServiceClient.create<FruitApi>('fruit', {
      signSalt: 'abcd1234',
      nats: { servers: ['nats://localhost:4224'] },
    });
    expect(client.isConnected).toBe(false);
    await client.connect();
    expect(client.isConnected).toBe(true);
    await client.disconnect();
    expect(client.isConnected).toBe(false);
  });

  it('returns service connected state', async () => {
    const service = new Service({
      signSalt: 'abcd1234',
      domain: 'some-service',
      nats: { servers: ['nats://localhost:4224'] },
    });
    expect(service.isConnected).toBe(false);
    await service.connect();
    expect(service.isConnected).toBe(true);
    await service.disconnect();
    expect(service.isConnected).toBe(false);
  });

  it('throws if no handler is found', async () => {
    const fruitClientBadApi = ServiceClient.create<{ nope(): Promise<void> }>('fruit', {
      signSalt: 'abcd1234',
      nats: { servers: ['nats://localhost:4224'] },
    });

    try {
      await fruitClientBadApi.nope();
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(Anomaly);
      expect((err as Anomaly).message).toBe('No handler for method: nope');
    }

    fruitClientBadApi.disconnect();
  });

  it('throws when calling Context.current if there is no context', () => {
    expect(() => {
      Context.current;
    }).toThrow();
  });

  it('should return false from Context.hasCurrent if there is no context', () => {
    expect(Context.hasCurrent).toBe(false);
  });

  it('should retrieve current context', () => {
    Context.apply({ foo: 'bar' }, () => {
      expect(Context.hasCurrent).toBe(true);
      expect(Context.current.get<string>('foo')).toBe('bar');
    });
  });

  it('applies context', async () => {
    await new Promise(resolve => {
      Context.apply({ language: 'icelandic' }, async () => {
        try {
          expect(await fruitClient.getFromContext('language')).toBe('icelandic');
          expect(Context.current.get('private')).toBeUndefined();
        } catch (err) {
          fail(err);
        }
        resolve();
      });
    });
  });

  it('uses client from service handler', async () => {
    expect(await fruitClient.getVeggies()).toStrictEqual(['carrot', 'celery', 'broccoli']);
  });
});

// ========================== TEST INFRASTRUCTURE ==========================

const wait = (millis = 0): Promise<void> =>
  new Promise((resolve): void => {
    setTimeout(resolve, millis);
  });

const vegService = new Service({
  signSalt: 'abcd1234',
  domain: 'veg',
  nats: { servers: ['nats://localhost:4224'] },
});

interface VegApi {
  getKinds(): Promise<string[]>;
}

const getVegKinds: VegApi['getKinds'] = async () => {
  if (Context.current.get('bubba') !== 'gump') {
    throw new Error('Nope');
  }

  return ['carrot', 'celery', 'broccoli'];
};

vegService.addHandler('getKinds', getVegKinds);

const fruitService = new Service({
  signSalt: 'abcd1234',
  domain: 'fruit',
  nats: { servers: ['nats://localhost:4224'] },
});

interface FruitApi {
  getKinds(): Promise<string[]>;
  getKindsIterator(): Promise<AsyncIterableIterator<string>>;
  doErrors(type: 'error' | 'anomaly' | 'none'): Promise<void>;
  getFromContext(key: string): Promise<Serializable | undefined>;
  getVeggies(): Promise<string[]>;
}

const getKinds: FruitApi['getKinds'] = async () => ['apple', 'orange', 'pear'];

const getKindsIterator: FruitApi['getKindsIterator'] = async () =>
  (async function* () {
    await wait(200);
    yield 'apple';
    await wait(200);
    yield 'orange';
    await wait(200);
    yield 'pear';
  })();

const doErrors: FruitApi['doErrors'] = async type => {
  switch (type) {
    case 'anomaly':
      throw new Anomaly('the anomaly');

    case 'error':
      throw new Error('the error');
  }
};

const getFromContext: FruitApi['getFromContext'] = async key => {
  Context.current.set('private', 'only4me');

  if (getMyData() !== 'only4me') {
    throw new Error('Did not get private data');
  }

  return Context.current.get(key);
};

const getMyData = (): string | undefined => {
  return Context.current.get<string>('private');
};

const getVeggies: FruitApi['getVeggies'] = async () => {
  if (Context.current.getClient) {
    Context.current.set('bubba', 'gump');
    const vegClient = Context.current.getClient<VegApi>('veg');
    return await vegClient.getKinds();
  }
  throw new Error('getClient not defined');
};

fruitService.addHandler('getKinds', getKinds);
fruitService.addHandler('getKindsIterator', getKindsIterator);
fruitService.addHandler('doErrors', doErrors);
fruitService.addHandler('getFromContext', getFromContext);
fruitService.addHandler('getVeggies', getVeggies);

const fruitClient = ServiceClient.create<FruitApi>('fruit', {
  signSalt: 'abcd1234',
  nats: { servers: ['nats://localhost:4224'] },
});
