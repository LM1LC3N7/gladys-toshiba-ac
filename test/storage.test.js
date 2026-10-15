// -----------------------------------------------------------------------------
// What the installation keeps in /data: install id, session, SAS token.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from '../src/storage.js';
import { createMemoryFs } from './helpers/fakeToshiba.js';

const PATH = '/data/toshiba-ac.json';
const random = () => Buffer.from('a1b2c3d4e5f60718', 'hex');
const SESSION = { type: 'Bearer', token: 't', consumerId: 'c', expiresAt: 1234 };

test('the install id is generated once and kept', async () => {
  const fs = createMemoryFs();
  const storage = new Storage({ fs, randomBytes: random });
  assert.equal(await storage.installId(), 'a1b2c3d4e5f60718');
  assert.deepEqual(JSON.parse(fs.files[PATH]), {
    install_id: 'a1b2c3d4e5f60718',
    session: null,
    sas: null,
  });
  const again = new Storage({ fs, randomBytes: () => Buffer.alloc(8) });
  assert.equal(await again.installId(), 'a1b2c3d4e5f60718');
});

test('a broken file gives a new install id', async () => {
  for (const content of ['not json', 'null', '[1]', '{"install_id":"XYZ"}']) {
    const fs = createMemoryFs({ [PATH]: content });
    const storage = new Storage({ fs, randomBytes: random });
    assert.equal(await storage.installId(), 'a1b2c3d4e5f60718', content);
  }
});

test('the session is tied to the credentials, never stored in clear', async () => {
  const fs = createMemoryFs();
  const storage = new Storage({ fs, randomBytes: random });
  await storage.setSession('jean', 'pass-word', SESSION);
  assert.deepEqual(await storage.session('jean', 'pass-word'), SESSION);
  assert.equal(await storage.session('jean', 'other'), null);
  assert.equal(await storage.session('paul', 'pass-word'), null);
  assert.ok(!fs.files[PATH].includes('pass-word'));
  const reloaded = new Storage({ fs, randomBytes: random });
  assert.deepEqual(await reloaded.session('jean', 'pass-word'), SESSION);
  await reloaded.setSession('jean', 'pass-word', null);
  assert.equal(await reloaded.session('jean', 'pass-word'), null);
});

test('the SAS token is kept per user', async () => {
  const fs = createMemoryFs();
  const storage = new Storage({ fs, randomBytes: random });
  await storage.setSasToken('jean', 'SharedAccessSignature sr=x');
  assert.equal(await storage.sasToken('jean'), 'SharedAccessSignature sr=x');
  assert.equal(await storage.sasToken('paul'), null);
  const writes = fs.writes;
  await storage.setSasToken('jean', 'SharedAccessSignature sr=x');
  assert.equal(fs.writes, writes, 'unchanged: not written again');
  await storage.setSasToken('jean', null);
  assert.equal(await storage.sasToken('jean'), null);
});

test('a read-only /data only costs a warning', async () => {
  const fs = createMemoryFs();
  fs.failWrites = true;
  const warnings = [];
  const storage = new Storage({
    fs,
    randomBytes: random,
    logger: { warn: (m) => warnings.push(m) },
  });
  assert.equal(await storage.installId(), 'a1b2c3d4e5f60718');
  await storage.setSession('jean', 'p', SESSION);
  assert.deepEqual(await storage.session('jean', 'p'), SESSION, 'kept for this run');
  assert.match(warnings[0], /Cannot keep the installation data in \/data \(EROFS\)/);
});
