# gladys-toshiba-ac

[Gladys Assistant](https://gladysassistant.com) external integration for the
**Toshiba air conditioners and air-to-air heat pumps of the Toshiba Home AC
Control app** (RB-N105S-G / RB-N106S-G Wi-Fi adapters, built-in Wi-Fi). It
signs in to the Toshiba cloud like the app, offers each unit of the account in
the Discovery tab, follows its state live through the Toshiba Azure IoT Hub and
sends the commands back through it. **Unofficial, not affiliated with
Toshiba** nor with Toshiba Carrier.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

> Work in progress (0.1, not published to the store yet): announced on the
> [Gladys forum](https://community.gladysassistant.com/t/integrations-home-assistant-les-plus-populaires-candidates-pour-des-integrations-externes-gladys/10385/178).

Not for the North American Toshiba units of the **Toshiba AC NA** app: they
are Midea units (Midea cloud), covered by the Midea integration of the store.

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (ToshibaApp)
                                  ├─ src/toshiba.js   REST API: login, device list, state, energy,
                                  │                   RegisterMobileDevice -> SAS token (node:https)
                                  ├─ src/iothub.js    MQTT over TLS to the Azure IoT Hub: unit reports
                                  │                   (direct method `smmobile`), commands (`mqtt`)
                                  ├─ src/protocol.js  the 19-byte unit state, the supported features,
                                  │                   the commands (pure port of toshiba-ac)
                                  ├─ src/devices.js   unit -> Gladys AIR_CONDITIONING device (pure)
                                  ├─ src/publisher.js states within 300/min
                                  └─ src/storage.js   install id, session, SAS token in /data
```

- **Login**: `POST /api/Consumer/Login` with the user name and password of
  the app, through bare `node:https` with an app User-Agent and a Device-ID
  header (the Toshiba firewall answers 429 to Node's `fetch` and to browser
  User-Agents). The access token (about three years) is kept in `/data`, tied
  to the credentials by an HMAC: restarts do not sign in again, and a refused
  login is never retried on its own (two refusals lock the account for hours).
- **Discovery**: `GET /api/AC/GetConsumerACMapping`; the `MeritFeature` and
  `ACModelId` of each unit say which modes, swing positions and special modes
  it has, like in the library.
- **Live link**: `POST /api/Consumer/RegisterMobileDevice` registers the
  installation as the mobile device `<user>_<install id>` and returns a SAS
  token for the IoT Hub; MQTT 3.1.1 over TLS (port 8883), as the
  azure-iot-device SDK of the library does. Units report `CMD_FCU_FROM_AC`
  (state) and `CMD_HEARTBEAT` (temperatures) through a direct method;
  commands are device-to-cloud messages `CMD_FCU_TO_AC`, with the body the
  library sends (a Python literal, the only format known to work).
- **Safety net**: the states are read over HTTP every 30 minutes (5 minutes
  while the live link is down, and right after it comes back); the energy of
  the year every 30 minutes for the units that report it.

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npm run audit
npx github:GladysAssistant/integration-store .  # store admission checks
```

The tests run against a fake Toshiba REST API, a fake IoT Hub on the loopback
(a real `mqtt` client, an MQTT server built on `mqtt-packet`) and the SDK's
fake Gladys. The protocol port is checked against the values the Python
library computes on the same inputs
([test/fixtures/toshiba-ac](test/fixtures/toshiba-ac/README.md)). The Docker
image itself was run against the same fakes over real TLS (HTTPS and MQTTS
with SNI, a test CA), read-only under 256 MB and 0.5 CPU.

## Credits

The unit protocol (state field map, supported features, command rules) is
ported from [toshiba-ac](https://github.com/KaSroka/Toshiba-AC-control) by
Kamil Sroka (Apache License 2.0), the library of the Home Assistant
integration [h4de5/home-assistant-toshiba_ac](https://github.com/h4de5/home-assistant-toshiba_ac)
(GPL-3.0, read as documentation only). The firewall and session behaviour
comes from the notes of that integration and of
[homebridge-toshiba-home-ac](https://www.npmjs.com/package/homebridge-toshiba-home-ac)
(Onur Yuksel, MIT); the raw MQTT approach was cross-checked with
[@jonaskpb/homebridge-toshiba-ac](https://github.com/jonaskpb/homebridge-toshiba-ac)
(Apache-2.0). See [NOTICE](NOTICE).

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release. The
`gladys-assistant-integration` topic is added at the first real release only.

## License

Apache-2.0.
