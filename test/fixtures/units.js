// -----------------------------------------------------------------------------
// Made-up units of a Toshiba Home AC Control account, in the shape of the
// GetConsumerACMapping answer (field names from the toshiba-ac library). The
// states are the hand-made ones of toshiba-ac/golden.json; nothing comes from
// a real account.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

export const golden = JSON.parse(
  readFileSync(new URL('./toshiba-ac/golden.json', import.meta.url), 'utf8'),
);

export const STATE = Object.fromEntries(
  Object.entries(golden.states).map(([name, { hex }]) => [name, hex]),
);

export const USERNAME = 'gladys-user';
export const PASSWORD = 'secret-password';

/** A SAS token as RegisterMobileDevice returns it (fake signature, expiry in 2100). */
export const sasToken = (deviceId = `${USERNAME}_0123456789abcdef`, se = 4102444800) =>
  `SharedAccessSignature sr=toshibahub.azure-devices.net%2Fdevices%2F${encodeURIComponent(
    deviceId,
  )}&sig=ZmFrZS1zaWduYXR1cmU%3D&se=${se}`;

/** The units, by role in the tests. */
export const UNITS = {
  // Everything: horizontal swing, louver positions, silent, ion, fireplace, 8 °C, energy.
  living: {
    Id: '11111111-aaaa-4aaa-8aaa-111111111111',
    DeviceUniqueId: 'A1B2C3D4E5F6-living',
    Name: 'Salon',
    ACStateData: STATE.cool_on,
    FirmwareVersion: '02.04.28',
    MeritFeature: 'fc03',
    ACModelId: '3',
  },
  // Hi-POWER and ECO, vertical swing only, no energy.
  bedroom: {
    Id: '22222222-bbbb-4bbb-8bbb-222222222222',
    DeviceUniqueId: 'B2C3D4E5F6A1-bedroom',
    Name: 'Chambre',
    ACStateData: STATE.heat_off,
    FirmwareVersion: '02.04.20',
    MeritFeature: '0000',
    ACModelId: '2',
  },
  // A cooling-only unit (merit bits 6/7 = 1/0).
  office: {
    Id: '33333333-cccc-4ccc-8ccc-333333333333',
    DeviceUniqueId: 'C3D4E5F6A1B2-office',
    Name: 'Bureau',
    ACStateData: STATE.fan_fixed,
    FirmwareVersion: '01.00.05',
    MeritFeature: '0200',
    ACModelId: '1',
  },
};

/** The GetConsumerACMapping groups of an account. */
export const mapping = (units = Object.values(UNITS)) => [
  { GroupName: 'Maison', ACList: units.map((u) => ({ ...u })) },
];
