// -----------------------------------------------------------------------------
// Texts shown in Gladys (connection status, button, transport badges, feature
// names, option labels), in English and French.
// -----------------------------------------------------------------------------

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const list = (names) => names.map((n) => `"${n}"`).join(', ');
const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));
const seconds = (ms) => Math.max(1, Math.round(ms / 1000));

export const T = {
  notConfigured: {
    en: 'Type the user name and the password of your Toshiba Home AC Control account.',
    fr: 'Saisissez le nom d’utilisateur et le mot de passe de votre compte Toshiba Home AC Control.',
  },
  connecting: {
    en: 'Connecting to Toshiba Home AC Control…',
    fr: 'Connexion à Toshiba Home AC Control…',
  },
  connected: (count) => ({
    en: `Connected to Toshiba Home AC Control: ${plural(count, 'air conditioner', 'air conditioners')}, live link up. Open Discovery to add them.`,
    fr: `Connecté à Toshiba Home AC Control : ${plural(count, 'climatiseur', 'climatiseurs')}, liaison temps réel active. Ouvrez Découverte pour les ajouter.`,
  }),
  noUnit: {
    en: 'Connected to Toshiba Home AC Control, but this account has no air conditioner. Is it the account of the Toshiba Home AC Control app?',
    fr: 'Connecté à Toshiba Home AC Control, mais ce compte n’a aucun climatiseur. Est-ce bien le compte de l’application Toshiba Home AC Control ?',
  },
  refused: {
    en: 'Toshiba refused the user name or the password: check them in the Toshiba Home AC Control app (the user name is often not the e-mail), then save the configuration. Not retried on its own: a few refused logins block the account for hours.',
    fr: 'Toshiba a refusé le nom d’utilisateur ou le mot de passe : vérifiez-les dans l’application Toshiba Home AC Control (le nom d’utilisateur n’est souvent pas l’e-mail), puis enregistrez la configuration. Pas de nouvel essai automatique : quelques refus bloquent le compte pendant des heures.',
  },
  rateLimited: (ms) => ({
    en: `Toshiba is slowing this connection down (too many requests). Next attempt in ${minutes(ms)} min.`,
    fr: `Toshiba ralentit cette connexion (trop de requêtes). Nouvel essai dans ${minutes(ms)} min.`,
  }),
  unreachable: (reason, ms) => ({
    en: `The Toshiba cloud is unreachable (${reason}). Next attempt in ${seconds(ms)} s.`,
    fr: `Le cloud Toshiba est injoignable (${reason}). Nouvel essai dans ${seconds(ms)} s.`,
  }),
  liveDown: (ms) => ({
    en: `The live link to Toshiba is down: commands are unavailable and the states are read every 5 minutes. Next attempt in ${seconds(ms)} s.`,
    fr: `La liaison temps réel avec Toshiba est coupée : les commandes sont indisponibles et les états sont lus toutes les 5 minutes. Nouvel essai dans ${seconds(ms)} s.`,
  }),
  liveRefused: (ms) => ({
    en: `Toshiba refused the live link even with a new token: another client using the same identity may hold it. Commands are unavailable, the states are read every 5 minutes. Next attempt in ${minutes(ms)} min.`,
    fr: `Toshiba a refusé la liaison temps réel, même avec un nouveau jeton : un autre client avec la même identité la garde peut-être. Commandes indisponibles, états lus toutes les 5 minutes. Nouvel essai dans ${minutes(ms)} min.`,
  }),
  badge: {
    liveDown: {
      en: 'Live link down: no commands, states every 5 min',
      fr: 'Liaison temps réel coupée : pas de commande, états toutes les 5 min',
    },
  },
  test: {
    ok: (names, live) => {
      const link = {
        en: live ? 'Live link up.' : 'The live link is not up (see the status above).',
        fr: live
          ? 'Liaison temps réel active.'
          : 'La liaison temps réel n’est pas active (voir l’état ci-dessus).',
      };
      return names.length === 0
        ? {
            en: `Login OK, but this account has no air conditioner. ${link.en}`,
            fr: `Connexion OK, mais ce compte n’a aucun climatiseur. ${link.fr}`,
          }
        : {
            en: `Login OK: ${plural(names.length, 'air conditioner', 'air conditioners')} (${list(names)}). ${link.en}`,
            fr: `Connexion OK : ${plural(names.length, 'climatiseur', 'climatiseurs')} (${list(names)}). ${link.fr}`,
          };
    },
    refused: {
      en: 'Toshiba refused the user name or the password: check them in the Toshiba Home AC Control app (the user name is often not the e-mail). Wait before trying again: a few refused logins block the account for hours.',
      fr: 'Toshiba a refusé le nom d’utilisateur ou le mot de passe : vérifiez-les dans l’application Toshiba Home AC Control (le nom d’utilisateur n’est souvent pas l’e-mail). Attendez avant de réessayer : quelques refus bloquent le compte pendant des heures.',
    },
    rateLimited: {
      en: 'Toshiba is slowing this connection down (too many requests): try again in a few minutes.',
      fr: 'Toshiba ralentit cette connexion (trop de requêtes) : réessayez dans quelques minutes.',
    },
    failed: (reason) => ({
      en: `The Toshiba cloud did not answer as expected (${reason}).`,
      fr: `Le cloud Toshiba n’a pas répondu comme prévu (${reason}).`,
    }),
  },
};

/** Device texts, in the language chosen in the configuration. */
const TEXTS = {
  en: {
    features: {
      binary: 'On/off',
      mode: 'Mode',
      'target-temperature': 'Setpoint',
      'fan-speed': 'Fan speed',
      'swing-vertical': 'Vertical swing',
      'swing-horizontal': 'Horizontal swing',
      'power-selection': 'Power selection',
      'special-mode': 'Special mode',
      fireplace: 'Fireplace mode',
      'air-purifier': 'Air purifier',
      'indoor-temperature': 'Indoor temperature',
      'outdoor-temperature': 'Outdoor temperature',
      energy: 'Energy this year',
    },
    options: {
      powerSelection: { POWER_50: '50 %', POWER_75: '75 %', POWER_100: '100 %' },
      meritA: {
        OFF: 'None',
        HIGH_POWER: 'Hi-POWER',
        ECO: 'ECO',
        CDU_SILENT_1: 'Silent 1 (outdoor unit)',
        CDU_SILENT_2: 'Silent 2 (outdoor unit)',
        HEATING_8C: '8 °C heating',
        SLEEP_CARE: 'Sleep care',
        FLOOR: 'Floor',
        COMFORT: 'Comfort',
      },
      meritB: { OFF: 'Off', FIREPLACE_1: 'Fireplace 1', FIREPLACE_2: 'Fireplace 2' },
      mode: { AUTO: 'Auto', COOL: 'Cool', HEAT: 'Heat', DRY: 'Dry', FAN: 'Fan' },
      fanMode: {
        AUTO: 'Auto',
        QUIET: 'Quiet',
        LOW: 'Low',
        MEDIUM_LOW: 'Medium low',
        MEDIUM: 'Medium',
        MEDIUM_HIGH: 'Medium high',
        HIGH: 'High',
      },
      swing: {
        OFF: 'Off',
        SWING: 'Swing',
        FIXED_1: 'Position 1 (top)',
        FIXED_2: 'Position 2',
        FIXED_3: 'Position 3',
        FIXED_4: 'Position 4',
        FIXED_5: 'Position 5 (bottom)',
      },
    },
    unit: 'Air conditioner',
  },
  fr: {
    features: {
      binary: 'Marche/arrêt',
      mode: 'Mode',
      'target-temperature': 'Consigne',
      'fan-speed': 'Ventilation',
      'swing-vertical': 'Balayage vertical',
      'swing-horizontal': 'Balayage horizontal',
      'power-selection': 'Sélection de puissance',
      'special-mode': 'Mode spécial',
      fireplace: 'Mode cheminée',
      'air-purifier': 'Purificateur d’air',
      'indoor-temperature': 'Température intérieure',
      'outdoor-temperature': 'Température extérieure',
      energy: 'Énergie de l’année',
    },
    options: {
      powerSelection: { POWER_50: '50 %', POWER_75: '75 %', POWER_100: '100 %' },
      meritA: {
        OFF: 'Aucun',
        HIGH_POWER: 'Hi-POWER',
        ECO: 'ECO',
        CDU_SILENT_1: 'Silencieux 1 (unité extérieure)',
        CDU_SILENT_2: 'Silencieux 2 (unité extérieure)',
        HEATING_8C: 'Hors-gel 8 °C',
        SLEEP_CARE: 'Sommeil',
        FLOOR: 'Sol',
        COMFORT: 'Confort',
      },
      meritB: { OFF: 'Arrêt', FIREPLACE_1: 'Cheminée 1', FIREPLACE_2: 'Cheminée 2' },
      mode: {
        AUTO: 'Auto',
        COOL: 'Froid',
        HEAT: 'Chaud',
        DRY: 'Déshumidification',
        FAN: 'Ventilation',
      },
      fanMode: {
        AUTO: 'Auto',
        QUIET: 'Silencieux',
        LOW: 'Faible',
        MEDIUM_LOW: 'Moyenne basse',
        MEDIUM: 'Moyenne',
        MEDIUM_HIGH: 'Moyenne haute',
        HIGH: 'Forte',
      },
      swing: {
        OFF: 'Arrêt',
        SWING: 'Balayage',
        FIXED_1: 'Position 1 (haut)',
        FIXED_2: 'Position 2',
        FIXED_3: 'Position 3',
        FIXED_4: 'Position 4',
        FIXED_5: 'Position 5 (bas)',
      },
    },
    unit: 'Climatiseur',
  },
};

export const texts = (language) => TEXTS[language] ?? TEXTS.en;
