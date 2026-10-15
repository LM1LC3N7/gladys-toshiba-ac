// -----------------------------------------------------------------------------
// A fake Azure IoT Hub on the loopback: a minimal MQTT 3.1.1 server (built on
// mqtt-packet, the packet codec of the `mqtt` client) that behaves like the
// hub for a device: it checks the CONNECT fields, refuses a SAS token with
// CONNACK 5, records the subscriptions and the device-to-cloud messages,
// records the direct method answers and calls direct methods on the device.
// Plain TCP on the loopback for the tests; TLS (`tls: { key, cert }`) for the
// smoke run of the Docker image, where the app connects to mqtts://<hub>:8883.
// -----------------------------------------------------------------------------

import net from 'node:net';
import tls from 'node:tls';
import mqttPacket from 'mqtt-packet';

export async function startFakeIotHub({
  accept = () => true,
  tls: tlsOptions,
  host = '127.0.0.1',
  port = 0,
} = {}) {
  const sockets = new Set();
  const hub = {
    connects: [],
    /** The TLS server names (SNI) the clients asked for. */
    servernames: [],
    subscriptions: [],
    events: [],
    methodResponses: [],
    clients: new Set(),
    /** (connect packet) => true to accept, a CONNACK return code to refuse. */
    accept,
    /** Set to true to leave the PUBACKs of the device messages unanswered. */
    holdPubacks: false,
  };

  const onSocket = (socket) => {
    sockets.add(socket);
    if (tlsOptions) {
      hub.servernames.push(socket.servername ?? null);
    }
    const parser = mqttPacket.parser({ protocolVersion: 4 });
    const send = (packet) => {
      if (!socket.destroyed) {
        socket.write(mqttPacket.generate(packet));
      }
    };
    const client = { socket, send, clientId: null };
    parser.on('packet', (packet) => {
      switch (packet.cmd) {
        case 'connect': {
          const record = {
            clientId: packet.clientId,
            username: packet.username,
            password: packet.password ? packet.password.toString('utf8') : null,
            clean: packet.clean,
            keepalive: packet.keepalive,
            protocolVersion: packet.protocolVersion,
          };
          hub.connects.push(record);
          const verdict = hub.accept(record);
          if (verdict !== true) {
            send({ cmd: 'connack', returnCode: typeof verdict === 'number' ? verdict : 5 });
            socket.end();
            return;
          }
          client.clientId = packet.clientId;
          hub.clients.add(client);
          send({ cmd: 'connack', returnCode: 0, sessionPresent: false });
          return;
        }
        case 'subscribe':
          for (const s of packet.subscriptions) {
            hub.subscriptions.push({ clientId: client.clientId, topic: s.topic, qos: s.qos });
          }
          send({
            cmd: 'suback',
            messageId: packet.messageId,
            granted: packet.subscriptions.map((s) => s.qos),
          });
          return;
        case 'publish': {
          const entry = {
            clientId: client.clientId,
            topic: packet.topic,
            payload: packet.payload.toString('utf8'),
            qos: packet.qos,
          };
          if (packet.topic.startsWith('$iothub/methods/res/')) {
            hub.methodResponses.push(entry);
          } else {
            hub.events.push(entry);
          }
          if (packet.qos === 1 && !hub.holdPubacks) {
            send({ cmd: 'puback', messageId: packet.messageId });
          }
          return;
        }
        case 'pingreq':
          send({ cmd: 'pingresp' });
          return;
        case 'disconnect':
          socket.end();
          return;
        default:
      }
    });
    socket.on('data', (data) => parser.parse(data));
    socket.on('close', () => {
      hub.clients.delete(client);
      sockets.delete(socket);
    });
    socket.on('error', () => {});
  };
  const server = tlsOptions ? tls.createServer(tlsOptions, onSocket) : net.createServer(onSocket);

  await new Promise((resolve) => server.listen(port, host, resolve));
  hub.url = `${tlsOptions ? 'mqtts' : 'mqtt'}://${host}:${server.address().port}`;

  /** Calls a direct method on every connected device. */
  hub.callMethod = (name, body, rid = '1') => {
    for (const client of hub.clients) {
      client.send({
        cmd: 'publish',
        topic: `$iothub/methods/POST/${name}/?$rid=${rid}`,
        payload: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
        qos: 0,
        retain: false,
        dup: false,
      });
    }
  };

  /** Drops every connection, like the hub does on a network cut or a SAS expiry. */
  hub.dropClients = () => {
    for (const socket of sockets) {
      socket.destroy();
    }
  };

  hub.close = () =>
    new Promise((resolve) => {
      hub.dropClients();
      server.close(() => resolve());
    });

  return hub;
}

/** Waits until `check()` is truthy (polling every 5 ms, 2 s at most). */
export async function until(check, what = 'condition', timeout = 2000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = check();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
