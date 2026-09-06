'use strict';

// Read once by src/config.js, so it is set before the module under test loads.
process.env.FRONT_DOOR_ID = 'front-door-id-for-tests';

const assert = require('node:assert');
const { test } = require('node:test');

const geo = require('../src/ingest/enrich-geo');

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

const CALLERS = [
  {
    // The last hop, not the first: everything to its left was written by whoever called us, so a
    // caller could otherwise name any address it liked and be located as that address.
    name: 'the last hop of X-Forwarded-For is the client',
    headers: { 'x-forwarded-for': '10.0.0.5, 10.0.0.6, 24.108.0.1' },
    expected: '24.108.0.1'
  },
  {
    name: 'an address the caller put at the front of X-Forwarded-For is ignored',
    headers: { 'x-forwarded-for': '8.8.8.8, 24.108.0.1' },
    expected: '24.108.0.1'
  },
  {
    name: 'a port appended to an IPv4 hop is dropped',
    headers: { 'x-forwarded-for': '24.108.0.1:52344' },
    expected: '24.108.0.1'
  },
  {
    name: 'a bracketed IPv6 hop is unwrapped',
    headers: { 'x-forwarded-for': '[2606:4700:4700::1111]:52344' },
    expected: '2606:4700:4700::1111'
  },
  {
    name: 'an unbracketed IPv6 hop keeps all of its colons',
    headers: { 'x-forwarded-for': '2606:4700:4700::1111' },
    expected: '2606:4700:4700::1111'
  },
  {
    name: 'the socket address wins when the request really came through our Front Door',
    headers: {
      'x-azure-fdid': 'front-door-id-for-tests',
      'x-azure-socketip': '24.108.0.1',
      'x-forwarded-for': '8.8.8.8'
    },
    expected: '24.108.0.1'
  },
  {
    name: 'a forged Front Door id falls back to the forwarding chain',
    headers: {
      'x-azure-fdid': 'not-our-front-door',
      'x-azure-socketip': '24.108.0.1',
      'x-forwarded-for': '8.8.8.8'
    },
    expected: '8.8.8.8'
  },
  {
    name: 'X-Azure-ClientIP is ignored, because the caller controls what Front Door derives it from',
    headers: {
      'x-azure-fdid': 'front-door-id-for-tests',
      'x-azure-clientip': '24.108.0.1'
    },
    expected: ''
  },
  {
    name: 'a request with no forwarding headers has no client address',
    headers: {},
    expected: ''
  }
];

for (const caller of CALLERS) {
  test(caller.name, () => {
    assert.strictEqual(geo.clientIp(request(caller.headers)), caller.expected);
  });
}

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
