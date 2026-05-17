export const DEFAULT_CATEGORY = 'artificial-intelligence';

export function boundedIntParam(searchParams, name, defaultValue, maxValue, minValue = 1) {
  const value = Number(searchParams.get(name) || defaultValue);
  const normalized = Number.isFinite(value) ? value : defaultValue;
  return Math.min(Math.max(normalized, minValue), maxValue);
}
