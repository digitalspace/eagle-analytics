'use strict';

// Read once by src/config.js, so these are set before the module under test loads.
process.env.FRONT_DOOR_ID = 'front-door-id-for-tests';
// Two of the four addresses the OpenShift cluster calls out from, as deployed.
process.env.TRUSTED_PROXY_IPS = '142.34.194.121,142.34.194.122';

const assert = require('node:assert');
const { test } = require('node:test');

const geo = require('../src/ingest/enrich-geo');
const { loadModule } = require('./helpers/load-config');

// What a real GeoLite2 city record looks like, trimmed to the parts that are read plus the
// coordinates, which must not come out the other end.
const RECORDS = {
  '24.108.0.1': {
    country: { iso_code: 'CA', names: { en: 'Canada' } },
    subdivisions: [{ iso_code: 'BC', names: { en: 'British Columbia' } }],
    city: { names: { en: 'Victoria' } },
    location: { latitude: 48.4283, longitude: -123.3645, accuracy_radius: 20 },
    postal: { code: 'V8W' }
  },
  '2606:4700:4700::1111': {
    country: { iso_code: 'US', names: { en: 'United States' } }
  }
};

const READER = { get: (ip) => RECORDS[ip] || null };

function request(headers) {
  return { header: (name) => headers[name.toLowerCase()] };
}

const PRIVATE = [
  '10.1.2.3',
  '172.16.0.1',
  '172.31.255.254',
  '192.168.1.10',
  '127.0.0.1',
  '169.254.10.1',
  '0.0.0.0',
  '::1',
  '::',
  'fe80::1ff:fe23:4567:890a',
  'fd00::1',
  // Upper case matters: an IPv6 address is case-insensitive, and penguin-analytics' version of this
  // check treated FD00::1 as routable.
  'FD00::1',
  'fc00::1',
  '::ffff:192.168.1.1',
  ''
];

for (const ip of PRIVATE) {
  test(`${ip || 'an empty address'} is not routable`, () => {
    assert.strictEqual(geo.isPrivateIp(ip), true);
  });
}

const PUBLIC = [
  '24.108.0.1',
  '172.32.0.1',
  '8.8.8.8',
  '142.34.128.10',
  '2606:4700:4700::1111',
  '::ffff:8.8.8.8'
];

for (const ip of PUBLIC) {
  test(`${ip} is routable`, () => {
    assert.strictEqual(geo.isPrivateIp(ip), false);
  });
}

// The address demi-apim-<env> stamps in X-Client-Ip for a request that came through the OpenShift
// cluster, and the address the Functions front end appends for APIM's own outbound hop.
const CLUSTER = '142.34.194.121';
const APIM_HOP = '20.104.10.20';

const CALLERS = [
  {
    // Hop -2, not hop -1: APIM does not append to X-Forwarded-For, so the last hop is the one Azure's
    // Functions front end added for APIM itself, and everybody would geolocate to APIM.
    name: 'a browser behind the cluster is the hop before the Azure one',
    headers: {
      'x-forwarded-for': `24.108.0.1, ${APIM_HOP}`,
      'x-client-ip': CLUSTER
    },
    expected: { ip: '24.108.0.1', trusted: false }
  },
  {
    // Everything left of what the OpenShift router appended was written by the caller.
    name: 'hops a caller put in front of its own are ignored',
    headers: {
      'x-forwarded-for': `8.8.8.8, 1.1.1.1, 24.108.0.1, ${APIM_HOP}`,
      'x-client-ip': CLUSTER
    },
    expected: { ip: '24.108.0.1', trusted: false }
  },
  {
    name: 'a server producer calling APIM itself is the cluster address, and is trusted',
    headers: {
      'x-forwarded-for': APIM_HOP,
      'x-client-ip': CLUSTER
    },
    expected: { ip: CLUSTER, trusted: true }
  },
  {
    // A second entry from the egress pool is still the cluster, not somebody behind it.
    name: 'a repeated cluster hop is not mistaken for a visitor',
    headers: {
      'x-forwarded-for': `142.34.194.122, ${APIM_HOP}`,
      'x-client-ip': CLUSTER
    },
    expected: { ip: CLUSTER, trusted: true }
  },
  {
    name: 'a caller reaching APIM straight off the internet is its own address, and is capped',
    headers: {
      'x-forwarded-for': APIM_HOP,
      'x-client-ip': '8.8.8.8'
    },
    expected: { ip: '8.8.8.8', trusted: false }
  },
  {
    // X-Client-Ip is APIM's, set with `override`, and every route carrying this code carries
    // apimGuard — so a request that reached here without it did not come through APIM at all.
    name: 'with no X-Client-Ip the last hop of X-Forwarded-For is the client',
    headers: { 'x-forwarded-for': '10.0.0.5, 10.0.0.6, 24.108.0.1' },
    expected: { ip: '24.108.0.1', trusted: false }
  },
  {
    name: 'a port appended to an IPv4 hop is dropped',
    headers: { 'x-forwarded-for': '24.108.0.1:52344' },
    expected: { ip: '24.108.0.1', trusted: false }
  },
  {
    name: 'a port appended to the visitor hop behind the cluster is dropped',
    headers: {
      'x-forwarded-for': `24.108.0.1:52344, ${APIM_HOP}`,
      'x-client-ip': CLUSTER
    },
    expected: { ip: '24.108.0.1', trusted: false }
  },
  {
    name: 'a bracketed IPv6 hop is unwrapped',
    headers: { 'x-forwarded-for': '[2606:4700:4700::1111]:52344' },
    expected: { ip: '2606:4700:4700::1111', trusted: false }
  },
  {
    name: 'a bracketed IPv6 visitor behind the cluster is unwrapped',
    headers: {
      'x-forwarded-for': `[2606:4700:4700::1111]:52344, ${APIM_HOP}`,
      'x-client-ip': CLUSTER
    },
    expected: { ip: '2606:4700:4700::1111', trusted: false }
  },
  {
    name: 'a bracketed X-Client-Ip is unwrapped',
    headers: { 'x-client-ip': '[2606:4700:4700::1111]:52344' },
    expected: { ip: '2606:4700:4700::1111', trusted: false }
  },
  {
    name: 'an unbracketed IPv6 hop keeps all of its colons',
    headers: { 'x-forwarded-for': '2606:4700:4700::1111' },
    expected: { ip: '2606:4700:4700::1111', trusted: false }
  },
  {
    // Front Door is not in the path yet, but when it is, its own view of the socket beats everything
    // below it.
    name: 'the socket address wins when the request really came through our Front Door',
    headers: {
      'x-azure-fdid': 'front-door-id-for-tests',
      'x-azure-socketip': '24.108.0.1',
      'x-forwarded-for': `8.8.8.8, ${APIM_HOP}`,
      'x-client-ip': CLUSTER
    },
    expected: { ip: '24.108.0.1', trusted: false }
  },
  {
    name: 'a forged Front Door id falls back to the forwarding chain',
    headers: {
      'x-azure-fdid': 'not-our-front-door',
      'x-azure-socketip': '8.8.8.8',
      'x-forwarded-for': `24.108.0.1, ${APIM_HOP}`,
      'x-client-ip': CLUSTER
    },
    expected: { ip: '24.108.0.1', trusted: false }
  },
  {
    name: 'X-Azure-ClientIP is ignored, because the caller controls what Front Door derives it from',
    headers: {
      'x-azure-fdid': 'front-door-id-for-tests',
      'x-azure-clientip': '24.108.0.1'
    },
    expected: { ip: '', trusted: false }
  },
  {
    name: 'a request with no forwarding headers has no client address',
    headers: {},
    expected: { ip: '', trusted: false }
  }
];

for (const caller of CALLERS) {
  test(caller.name, () => {
    assert.deepStrictEqual(geo.resolveCaller(request(caller.headers)), caller.expected);
  });
}

test('clientIp is the resolved address on its own', () => {
  const headers = { 'x-forwarded-for': `24.108.0.1, ${APIM_HOP}`, 'x-client-ip': CLUSTER };

  assert.strictEqual(geo.clientIp(request(headers)), '24.108.0.1');
});

// An instance with nothing trusted cannot tell our cluster from any other caller, so it stops at the
// address APIM saw and nobody is exempt from the cap. Fail-closed: an unset setting narrows what is
// trusted, it never widens it.
test('with no trusted proxy the caller is the address APIM saw, and is not trusted', () => {
  const untrusting = loadModule('ingest/enrich-geo', { TRUSTED_PROXY_IPS: '' });
  const headers = { 'x-forwarded-for': `24.108.0.1, ${APIM_HOP}`, 'x-client-ip': CLUSTER };

  assert.deepStrictEqual(untrusting.resolveCaller(request(headers)), {
    ip: CLUSTER,
    trusted: false
  });
});

test('a known address yields country, region and city, and nothing else', async (t) => {
  geo._setReader(READER);
  t.after(() => geo._reset());

  assert.deepStrictEqual(await geo.geoFields('24.108.0.1'), {
    Country: 'CA',
    Region: 'BC',
    City: 'Victoria'
  });
});

test('an address the database only knows the country of yields only the country', async (t) => {
  geo._setReader(READER);
  t.after(() => geo._reset());

  assert.deepStrictEqual(await geo.geoFields('2606:4700:4700::1111'), { Country: 'US' });
});

test('an address the database does not know yields nothing', async (t) => {
  geo._setReader(READER);
  t.after(() => geo._reset());

  assert.deepStrictEqual(await geo.geoFields('8.8.8.8'), {});
});

test('a private address is not looked up', async (t) => {
  geo._setReader({ get: () => { throw new Error('the database was consulted'); } });
  t.after(() => geo._reset());

  assert.deepStrictEqual(await geo.geoFields('10.1.2.3'), {});
});

test('with no database, enrichment is a no-op rather than an error', async (t) => {
  geo._setReader(null);
  t.after(() => geo._reset());

  assert.deepStrictEqual(await geo.geoFields('24.108.0.1'), {});
});

test('a database that throws on lookup costs the fields, not the event', async (t) => {
  geo._setReader({ get: () => { throw new Error('corrupt node') } });
  t.after(() => geo._reset());

  assert.deepStrictEqual(await geo.geoFields('24.108.0.1'), {});
});
