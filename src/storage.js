// -----------------------------------------------------------------------------
// What this installation keeps in /data (the only writable place of the
// container), in toshiba-ac.json:
// - `install_id`: 16 hex characters generated at the first start. The
//   installation registers with Toshiba as the mobile device
//   `<user>_<install_id>`, like a phone running the app, and sends it as the
//   Device-ID header. A new id at every start would register a new "phone"
//   every time.
// - `session`: the access token (it lives about three years) and the
//   consumer id, so a restart does not log in again: Toshiba locks an account
//   for hours after a few logins. Tied to the credentials by an HMAC (keyed
//   by the install id) of the user name and password: another account or
//   another password logs in again.
// - `sas`: the SAS token of the live link, for the same reason, tied to the
//   user name. Dropped when it expires and when the IoT Hub refuses it.
// When /data cannot be written, the values live for this run only.
// -----------------------------------------------------------------------------

import { createHmac, randomBytes as nodeRandomBytes } from 'node:crypto';
import { promises as nodeFs } from 'node:fs';
import { join } from 'node:path';

const FILE = 'toshiba-ac.json';
const INSTALL_ID = /^[0-9a-f]{16}$/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export class Storage {
  constructor({ dir = '/data', fs = nodeFs, randomBytes = nodeRandomBytes, logger } = {}) {
    this.path = join(dir, FILE);
    this.dir = dir;
    this.fs = fs;
    this.randomBytes = randomBytes;
    this.logger = logger;
    this.data = null;
    this.writing = Promise.resolve();
  }

  async load() {
    if (this.data) {
      return this.data;
    }
    let saved = {};
    try {
      saved = JSON.parse(await this.fs.readFile(this.path, 'utf8'));
    } catch {
      // First start, or an unreadable file: a new install id is generated.
    }
    if (!isObject(saved)) {
      saved = {};
    }
    this.data = {
      install_id: INSTALL_ID.test(saved.install_id ?? '')
        ? saved.install_id
        : this.randomBytes(8).toString('hex'),
      session: isObject(saved.session) ? saved.session : null,
      sas: isObject(saved.sas) ? saved.sas : null,
    };
    if (this.data.install_id !== saved.install_id) {
      await this.save();
    }
    return this.data;
  }

  async installId() {
    return (await this.load()).install_id;
  }

  /** The key a session is kept under: never the password itself. */
  credentialsKey(username, password) {
    return createHmac('sha256', this.data.install_id)
      .update(`${username}\u0000${password}`)
      .digest('hex');
  }

  /** The session kept for these credentials, or null. */
  async session(username, password) {
    const data = await this.load();
    const s = data.session;
    if (!s || s.key !== this.credentialsKey(username, password) || typeof s.token !== 'string') {
      return null;
    }
    return {
      type: typeof s.type === 'string' && s.type ? s.type : 'Bearer',
      token: s.token,
      consumerId: typeof s.consumerId === 'string' ? s.consumerId : null,
      expiresAt: Number.isFinite(s.expiresAt) ? s.expiresAt : null,
    };
  }

  async setSession(username, password, session) {
    const data = await this.load();
    data.session = session ? { key: this.credentialsKey(username, password), ...session } : null;
    await this.save();
  }

  /** The SAS token kept for this user, or null. */
  async sasToken(username) {
    const data = await this.load();
    return data.sas?.user === username && typeof data.sas.token === 'string'
      ? data.sas.token
      : null;
  }

  async setSasToken(username, token) {
    const data = await this.load();
    const next = token ? { user: username, token } : null;
    if (JSON.stringify(next) === JSON.stringify(data.sas)) {
      return;
    }
    data.sas = next;
    await this.save();
  }

  /** Writes one after the other, so the last state wins. */
  save() {
    const text = `${JSON.stringify(this.data)}\n`;
    this.writing = this.writing.then(() =>
      this.fs.writeFile(this.path, text, { encoding: 'utf8', mode: 0o600 }).catch((err) => {
        this.logger?.warn?.(
          `Cannot keep the installation data in ${this.dir} (${err.code ?? err.message})`,
        );
      }),
    );
    return this.writing;
  }
}
