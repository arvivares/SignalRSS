export function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

export function booleanEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export function categoryNumberEnv(prefix, slug, fallback) {
  const envName = `${prefix}_${slug.replace(/-/g, '_').toUpperCase()}`;
  return numberEnv(envName, fallback);
}

export function listEnv(name, fallback = []) {
  const value = process.env[name];
  if (!value) return fallback;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function keyValueEnv(name) {
  const value = process.env[name];
  if (!value) return {};
  return Object.fromEntries(value
    .split(',')
    .map((entry) => {
      const separatorIndex = entry.includes('=') ? entry.indexOf('=') : entry.indexOf(':');
      if (separatorIndex < 1) return null;
      const key = entry.slice(0, separatorIndex).trim();
      const mappedValue = entry.slice(separatorIndex + 1).trim();
      return key && mappedValue ? [key, mappedValue] : null;
    })
    .filter(Boolean));
}
