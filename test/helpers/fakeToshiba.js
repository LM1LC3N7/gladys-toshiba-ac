// -----------------------------------------------------------------------------
// A fake Toshiba Home AC Control REST API, as a transport for ToshibaClient
// (the shape of httpTransport): the answers follow the toshiba-ac library
// ({ IsSuccess, StatusCode, Message, ResObj }), the firewall answers 429
// without the app User-Agent, and every request is recorded.
// -----------------------------------------------------------------------------

import { PASSWORD, USERNAME, mapping, sasToken } from '../fixtures/units.js';
import { USER_AGENT } from '../../src/toshiba.js';

export function createFakeToshiba({ username = USERNAME, password = PASSWORD } = {}) {
  let tokens = 0;
  const api = {
    requests: [],
    groups: mapping(),
    valid: new Set(),
    sasToken: sasToken(),
    energy: null,
    /** Statuses (or functions) answered instead of the next requests. */
    next: [],
    /** Set to an error to make every request fail like a network error. */
    down: null,
    /** path -> HTTP status answered to every request of that path. */
    failing: {},
    expiresIn: 94607999,
    counts: () => {
      const out = {};
      for (const r of api.requests) {
        out[r.path] = (out[r.path] ?? 0) + 1;
      }
      return out;
    },
  };

  const answer = (status, body, headers = {}) => ({
    status,
    headers,
    body: body === undefined ? '' : JSON.stringify(body),
  });
  const ok = (ResObj) => answer(200, { IsSuccess: true, StatusCode: 'Success', ResObj });

  api.transport = async ({ method, url, headers, body, timeout, limit }) => {
    const u = new URL(url);
    const request = {
      method,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      headers,
      body: body === undefined ? undefined : JSON.parse(body),
      timeout,
      limit,
    };
    api.requests.push(request);
    if (api.down) {
      throw api.down;
    }
    const forced = api.next.shift();
    if (typeof forced === 'function') {
      return forced(request);
    }
    if (typeof forced === 'number') {
      return answer(forced, { isSuccess: false, message: 'forced' });
    }
    if (api.failing[request.path]) {
      return answer(api.failing[request.path], { isSuccess: false, message: 'failing' });
    }
    if (headers['User-Agent'] !== USER_AGENT) {
      return answer(429, { isSuccess: false, message: 'Too many requests' });
    }
    if (request.path === '/api/Consumer/Login') {
      if (request.body.Username !== username || request.body.Password !== password) {
        return answer(200, {
          IsSuccess: false,
          StatusCode: 'InvalidUserNameorPassword',
          Message: 'Invalid Username or Password',
        });
      }
      tokens += 1;
      const token = `token-${tokens}`;
      api.valid.add(token);
      return ok({
        access_token: token,
        token_type: 'Bearer',
        expires_in: api.expiresIn,
        consumerId: 'consumer-42',
      });
    }
    const bearer = /^Bearer (.+)$/.exec(headers.Authorization ?? '');
    if (!bearer || !api.valid.has(bearer[1])) {
      return answer(401);
    }
    switch (request.path) {
      case '/api/Consumer/RegisterMobileDevice':
        return ok({ SasToken: api.sasToken, DeviceId: request.body.DeviceID });
      case '/api/AC/GetConsumerACMapping':
        if (request.query.consumerId !== 'consumer-42') {
          return answer(200, { IsSuccess: false, StatusCode: 'Error', Message: 'no consumer' });
        }
        return ok(api.groups);
      case '/api/AC/GetCurrentACState': {
        const ac = api.groups.flatMap((g) => g.ACList).find((a) => a.Id === request.query.ACId);
        if (!ac) {
          return answer(200, { IsSuccess: false, StatusCode: 'Error', Message: 'unknown AC' });
        }
        return ok({
          ACStateData: ac.ACStateData,
          Fcu: { model_name: 'RAS-B10N4KVRG-E' },
          Cdu: { model_name: 'RAS-10N4AVRG-E' },
        });
      }
      case '/api/AC/GetGroupACEnergyConsumption':
        return ok(
          api.energy ??
            request.body.ACDeviceUniqueIdList.map((id) => ({
              ACDeviceUniqueId: id,
              EnergyConsumption: [{ Energy: '125000' }, { Energy: '9500' }],
            })),
        );
      default:
        return answer(404);
    }
  };

  /** Invalidates every access token (as if they expired server side). */
  api.expireTokens = () => api.valid.clear();

  return api;
}

/** An in-memory fs for src/storage.js. */
export function createMemoryFs(files = {}) {
  const fs = {
    files: { ...files },
    writes: 0,
    failWrites: false,
    async readFile(path) {
      if (!(path in fs.files)) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return fs.files[path];
    },
    async writeFile(path, text) {
      if (fs.failWrites) {
        throw Object.assign(new Error('EROFS'), { code: 'EROFS' });
      }
      fs.writes += 1;
      fs.files[path] = text;
    },
  };
  return fs;
}

/** Timers run by hand: setTimeout/setInterval are recorded, fire() runs the due ones. */
export function createManualTimers() {
  let id = 0;
  const timers = {
    pending: new Map(),
    setTimeout(fn, delay) {
      id += 1;
      timers.pending.set(id, { fn, delay, repeat: false });
      return id;
    },
    clearTimeout(handle) {
      timers.pending.delete(handle);
    },
    setInterval(fn, delay) {
      id += 1;
      timers.pending.set(id, { fn, delay, repeat: true });
      return id;
    },
    clearInterval(handle) {
      timers.pending.delete(handle);
    },
    /** The delays of the pending one-shot timers. */
    delays() {
      return [...timers.pending.values()].filter((t) => !t.repeat).map((t) => t.delay);
    },
    /** Runs the one-shot timers whose delay matches (all of them by default). */
    async fire(match = () => true) {
      const due = [...timers.pending.entries()].filter(([, t]) => !t.repeat && match(t.delay));
      for (const [handle, t] of due) {
        timers.pending.delete(handle);
        t.fn();
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      return due.length;
    },
  };
  return timers;
}
