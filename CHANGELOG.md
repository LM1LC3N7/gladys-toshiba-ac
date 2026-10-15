# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Login to Toshiba Home AC Control with the user name and the password of the
  app; the session (about three years) is kept in `/data`, so a restart does
  not sign in again, and a refused login is never retried on its own (Toshiba
  locks the account after a few refusals).
- One Gladys air conditioner per unit of the account, with the features the
  unit supports: on/off, mode (auto, cool, heat, dry, fan), setpoint, the 7
  fan speeds, vertical swing and the 5 louver positions, horizontal swing,
  power selection 50/75/100 %, special mode (Hi-POWER, ECO, silent 1/2, 8 °C
  heating, sleep, floor, comfort), fireplace mode, air purifier, indoor and
  outdoor temperatures, energy of the year.
- Live states and commands through the Toshiba Azure IoT Hub (MQTT over TLS),
  with the SAS token kept, registered again when refused, and the link
  reconnected with a growing delay.
- States read over HTTP every 30 minutes, every 5 minutes while the live link
  is down, and right after it comes back.
- Connection status and cloud transport badges (degraded while the live link
  is down), the Toshiba rate limit honoured (Retry-After, up to one hour).
- "Test the connection" button.

[Unreleased]: https://github.com/LM1LC3N7/gladys-toshiba-ac/commits/main
