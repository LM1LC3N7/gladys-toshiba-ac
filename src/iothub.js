// -----------------------------------------------------------------------------
// The live link: MQTT over TLS to the Azure IoT Hub of Toshiba, with the SAS
// token RegisterMobileDevice returned, as an IoT Hub *device*.
//
// - The units report their state through a direct method named `smmobile`
//   (topic $iothub/methods/POST/smmobile/?$rid=<id>): { cmd: CMD_FCU_FROM_AC
//   | CMD_HEARTBEAT, sourceId: <unit unique id>, payload, … }. Every method
//   call is answered (status 0, like the library), else the hub keeps
//   waiting for it.
// - Commands are device-to-cloud messages (devices/<id>/messages/events/)
//   with the property type=mob and a JSON content type (the body itself is
//   the Python literal the library sends, see protocol.js pythonRepr).
//
// The Python library does the same through Microsoft's azure-iot-device SDK
// (toshiba_ac/utils/amqp_api.py, MQTT transport by default): the api-version,
// the QoS and the property bag below are the ones that SDK sends, as the
// @jonaskpb/homebridge-toshiba-ac port (Apache-2.0) also does with `mqtt`.
// The SAS token is a password: never logged nor put in a message.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import mqtt from 'mqtt';
import { TIMINGS } from './constants.js';

const API_VERSION = '2019-10-01';
const METHOD_TOPIC = '$iothub/methods/POST/';
/** The property bag of a command: content type + encoding, then type=mob. */
const EVENT_PROPERTIES = '%24.ct=application%2Fjson&%24.ce=utf-8&type=mob';

export class IotHubError extends Error {}
/** The hub refused the SAS token (CONNACK 4 or 5): bad, expired, or another client holds the device. */
export class IotHubRefused extends IotHubError {}

/**
 * The host, device id and expiry of a SAS token
 * ("SharedAccessSignature sr=<host>%2Fdevices%2F<device>&sig=…&se=<epoch s>").
 * @returns {{ host: string, deviceId: string, expiresAt: number | null } | null}
 */
export function parseSasToken(token) {
  const text = String(token ?? '').trim();
  const match = /^SharedAccessSignature\s+(.+)$/i.exec(text);
  if (!match) {
    return null;
  }
  const fields = {};
  for (const part of match[1].split('&')) {
    const at = part.indexOf('=');
    if (at > 0) {
      fields[part.slice(0, at)] = part.slice(at + 1);
    }
  }
  if (!fields.sr || !fields.sig) {
    return null;
  }
  let resource;
  try {
    resource = decodeURIComponent(fields.sr);
  } catch {
    return null;
  }
  const [host, devices, deviceId] = resource.split('/');
  if (!host || devices !== 'devices' || !deviceId || !/^[a-z0-9.-]+$/i.test(host)) {
    return null;
  }
  const se = Number(fields.se);
  return { host, deviceId, expiresAt: Number.isFinite(se) && se > 0 ? se * 1000 : null };
}

/**
 * A direct method call of the hub: the method name and the request id.
 * @returns {{ name: string, rid: string } | null}
 */
export function parseMethodTopic(topic) {
  if (!topic.startsWith(METHOD_TOPIC)) {
    return null;
  }
  const rest = topic.slice(METHOD_TOPIC.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) {
    return null;
  }
  const rid = new URLSearchParams(rest.slice(slash + 1).replace(/^\?/, '')).get('$rid');
  return rid ? { name: rest.slice(0, slash), rid } : null;
}

/**
 * The `smmobile` call of a unit, checked like the library does.
 * @returns {{ cmd: string, sourceId: string, payload: object } | null}
 */
export function parseUnitMessage(data) {
  if (!data || typeof data !== 'object') {
    return null;
  }
  const { cmd, sourceId, messageId, targetId, payload, timeStamp } = data;
  if (
    typeof cmd !== 'string' ||
    typeof sourceId !== 'string' ||
    typeof messageId !== 'string' ||
    !Array.isArray(targetId) ||
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    typeof timeStamp !== 'string'
  ) {
    return null;
  }
  return { cmd, sourceId, payload };
}

/**
 * One connection to the hub. Events: 'unit' ({ cmd, sourceId, payload }),
 * 'close' (the connection ended after it was up). No automatic reconnection:
 * the app decides when to try again (and with which token).
 */
export class IotHubLink extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.sasToken
   * @param {object} [options.logger]
   * @param {Function} [options.connect] mqtt.connect (tests)
   * @param {string} [options.url] broker URL instead of mqtts://<host>:8883 (tests)
   */
  constructor({ sasToken, logger, connect = mqtt.connect, url }) {
    super();
    const sas = parseSasToken(sasToken);
    if (!sas) {
      throw new IotHubError('the SAS token is not readable');
    }
    this.sas = sas;
    this.sasToken = sasToken;
    this.logger = logger;
    this.connectFn = connect;
    this.url = url ?? `mqtts://${sas.host}:8883`;
    this.client = null;
    this.up = false;
  }

  get deviceId() {
    return this.sas.deviceId;
  }

  /** Connects and subscribes to the direct methods; rejects on a refusal or a timeout. */
  connect() {
    const { host, deviceId } = this.sas;
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (err) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (err) {
          this.close();
          reject(err);
        } else {
          resolve();
        }
      };
      const timer = setTimeout(
        () => settle(new IotHubError('the IoT Hub did not answer in time')),
        TIMINGS.mqttConnectTimeout,
      );
      const client = this.connectFn(this.url, {
        clientId: deviceId,
        username: `${host}/${deviceId}/?api-version=${API_VERSION}`,
        password: this.sasToken,
        protocolVersion: 4,
        clean: false,
        keepalive: TIMINGS.mqttKeepalive,
        reconnectPeriod: 0,
        connectTimeout: TIMINGS.mqttConnectTimeout,
        servername: host,
      });
      this.client = client;
      client.on('connect', () => {
        client.subscribe(`${METHOD_TOPIC}#`, { qos: 1 }, (err) => {
          if (err) {
            settle(new IotHubError(`subscription refused (${err.message})`));
            return;
          }
          this.up = true;
          settle();
        });
      });
      client.on('message', (topic, message) => this.onMessage(topic, message));
      client.on('error', (err) => {
        // mqtt.js: CONNACK refusals carry their return code.
        if (err?.code === 4 || err?.code === 5) {
          settle(new IotHubRefused(`connection refused by the IoT Hub (code ${err.code})`));
        } else {
          const reason = err?.code ?? err?.message ?? 'error';
          if (!settled) {
            settle(new IotHubError(`IoT Hub: ${String(reason).slice(0, 80)}`));
          } else {
            this.logger?.warn?.(`IoT Hub link: ${String(reason).slice(0, 80)}`);
          }
        }
      });
      client.on('close', () => {
        if (!settled) {
          settle(new IotHubError('the IoT Hub closed the connection'));
          return;
        }
        if (this.up) {
          this.up = false;
          this.emit('close');
        }
      });
    });
  }

  onMessage(topic, message) {
    const method = parseMethodTopic(topic);
    if (!method) {
      this.logger?.debug?.(`IoT Hub: ignored topic ${topic.slice(0, 80)}`);
      return;
    }
    // Answer first: the hub waits for every call, whatever its content.
    this.client?.publish(
      `$iothub/methods/res/0/?$rid=${encodeURIComponent(method.rid)}`,
      'null',
      { qos: 1 },
      (err) => err && this.logger?.debug?.(`IoT Hub: method answer not sent (${err.message})`),
    );
    if (method.name !== 'smmobile') {
      this.logger?.info?.(`IoT Hub: unknown method ${method.name.slice(0, 40)}`);
      return;
    }
    let data;
    try {
      data = JSON.parse(message.toString('utf8'));
    } catch {
      this.logger?.warn?.('IoT Hub: a unit message is not JSON');
      return;
    }
    const unit = parseUnitMessage(data);
    if (!unit) {
      this.logger?.warn?.('IoT Hub: malformed unit message');
      return;
    }
    this.emit('unit', unit);
  }

  /** Sends the text of a command; resolves once the hub acknowledged it (QoS 1). */
  send(body) {
    const client = this.client;
    if (!client || !this.up) {
      return Promise.reject(new IotHubError('the live link is down'));
    }
    const topic = `devices/${this.sas.deviceId}/messages/events/${EVENT_PROPERTIES}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new IotHubError('the IoT Hub did not acknowledge the command')),
        TIMINGS.mqttPublishTimeout,
      );
      client.publish(topic, body, { qos: 1 }, (err) => {
        clearTimeout(timer);
        if (err) {
          reject(new IotHubError(`command not sent (${String(err.message).slice(0, 80)})`));
        } else {
          resolve();
        }
      });
    });
  }

  close() {
    this.up = false;
    const client = this.client;
    this.client = null;
    if (client) {
      client.removeAllListeners('close');
      client.on('error', () => {});
      client.end(true);
    }
  }
}
