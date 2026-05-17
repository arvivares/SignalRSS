const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-or-v1-[A-Za-z0-9_-]{16,}\b/g,
  /\bgsk_[A-Za-z0-9_-]{16,}\b/g,
  /\bnvapi-[A-Za-z0-9_-]{16,}\b/g,
  /\bAIza[A-Za-z0-9_-]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bcsk-[A-Za-z0-9_-]{16,}\b/g,
  /\btgp_v1_[A-Za-z0-9_-]{16,}\b/g,
  /\brl_live_[A-Za-z0-9_-]{16,}\b/g,
  /\bapf_[A-Za-z0-9_-]{16,}\b/g,
  /\b(Bearer|token)\s+[A-Za-z0-9._-]{16,}\b/gi,
  /\b(api[_-]?key|secret|token|password)=([^&\s]+)/gi,
];

export function redactSecrets(value) {
  let output = typeof value === 'string' ? value : String(value ?? '');
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (match, key) => (key ? `${key}=[REDACTED]` : '[REDACTED]'));
  }
  return output;
}

export function safeErrorMessage(error, maxLength = 500) {
  return redactSecrets(error?.message || error).slice(0, maxLength);
}

export function safeErrorStack(error, maxLength = 4000) {
  return redactSecrets(error?.stack || error?.message || error).slice(0, maxLength);
}
