import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseHostValidationError, resolveDatabaseHost, type DatabaseHostLookup } from './database-host.js';

test('blocks metadata hostnames and metadata/link-local addresses', async () => {
  await assert.rejects(resolveDatabaseHost('metadata.google.internal'), DatabaseHostValidationError);
  await assert.rejects(resolveDatabaseHost('169.254.44.10'), DatabaseHostValidationError);
  await assert.rejects(resolveDatabaseHost('100.100.100.200'), DatabaseHostValidationError);
  await assert.rejects(resolveDatabaseHost('[::ffff:169.254.169.254]'), DatabaseHostValidationError);
  await assert.rejects(resolveDatabaseHost('db.example', async () => [
    { address: '192.0.2.20', family: 4 },
    { address: '169.254.169.254', family: 4 },
  ]), DatabaseHostValidationError);
});

test('pins the first validated DNS address and retains the hostname for TLS', async () => {
  const lookup: DatabaseHostLookup = async (hostname) => {
    assert.equal(hostname, 'db.example');
    return [{ address: '10.12.0.8', family: 4 }, { address: '10.12.0.9', family: 4 }];
  };
  assert.deepEqual(await resolveDatabaseHost('DB.EXAMPLE.', lookup), {
    address: '10.12.0.8', family: 4, tlsServername: 'db.example',
  });
});

test('allows loopback and private database addresses while preserving IPv6 TLS behavior', async () => {
  assert.deepEqual(await resolveDatabaseHost('127.0.0.1'), { address: '127.0.0.1', family: 4, tlsServername: undefined });
  assert.deepEqual(await resolveDatabaseHost('::1'), { address: '::1', family: 6, tlsServername: undefined });
  assert.deepEqual(await resolveDatabaseHost('db.internal', async () => [{ address: 'fd12:3456::4', family: 6 }]), {
    address: 'fd12:3456::4', family: 6, tlsServername: 'db.internal',
  });
});
