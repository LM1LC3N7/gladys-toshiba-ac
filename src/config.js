// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized.
// -----------------------------------------------------------------------------

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULTS = {
  username: '',
  password: '',
  language: 'fr',
};

export const LANGUAGES = ['en', 'fr'];

/**
 * @returns {{ username: string, password: string, language: 'en' | 'fr',
 *   missing: string[] }} `missing` lists the fields still to fill in
 */
export function normalizeConfig(raw = {}) {
  const given = Object.fromEntries(
    Object.entries(raw ?? {}).filter(([, v]) => v !== null && v !== undefined),
  );
  const c = { ...DEFAULTS, ...given };
  const username = String(c.username ?? '').trim();
  const password = String(c.password ?? '');
  const language = LANGUAGES.includes(c.language) ? c.language : DEFAULTS.language;
  const missing = [];
  if (username === '') {
    missing.push('username');
  }
  if (password === '') {
    missing.push('password');
  }
  return { username, password, language, missing };
}
