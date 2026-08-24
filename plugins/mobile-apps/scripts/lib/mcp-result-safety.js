'use strict';

const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
const NEWLINE_RE = /[\r\n]/;
const MAX_SCALAR_LENGTH = 512;

const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(all\s+|the\s+)?previous\s+(instructions?|prompts?)/i,
  /disregard[\s\S]{0,40}\b(above|prior|previous)\b/i,
  /\byou\s+are\s+now\b/i,
  /\bsystem\s*:/i,
  /\bforget\s+(all\s+|your\s+)?(previous\s+)?(instructions?|context|rules)\b/i,
  /\bnew\s+instructions?\s*:/i,
  /\boverride\s+(all\s+)?instructions\b/i,
  /\bpretend\s+you\s+are\b/i,
  /\bact\s+as\s+(if\s+you\s+are|a)\b/i,
  /\bfrom\s+now\s+on\b/i,
];

const SECRET_SHAPED_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bya29\.[0-9A-Za-z._-]+\b/,
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\b/,
];

const CREDENTIAL_BLOCK_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bya29\.[0-9A-Za-z._-]+\b/,
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\b/,
  /"type"\s*:\s*"service_account"/,
  /"private_key"\s*:/,
  /"private_key_id"\s*:/,
  /"client_email"\s*:/,
];

function finding(code, message, path = null) {
  return { code, message, path };
}

function firstUnsafeScalarText(value, { context = 'value', allowMultiline = false } = {}) {
  if (typeof value !== 'string') return null;
  if (value.length > MAX_SCALAR_LENGTH) {
    return finding('mcp-oversized-scalar', `${context} exceeds ${MAX_SCALAR_LENGTH} characters.`);
  }
  if (CONTROL_CHAR_RE.test(value)) {
    return finding('mcp-control-characters', `${context} contains control characters.`);
  }
  if (!allowMultiline && NEWLINE_RE.test(value)) {
    return finding('mcp-multiline-scalar', `${context} must stay on one line.`);
  }
  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    if (pattern.test(value)) {
      return finding(
        'mcp-prompt-injection-shaped',
        `${context} contains prompt-injection-shaped text.`,
      );
    }
  }
  for (const pattern of SECRET_SHAPED_PATTERNS) {
    if (pattern.test(value)) {
      return finding('mcp-secret-shaped', `${context} contains secret-shaped text.`);
    }
  }
  return null;
}

function firstUnsafeMcpValue(value, { context = 'value', allowMultiline = false } = {}) {
  const seen = new Set();

  function visit(current, currentContext) {
    if (typeof current === 'string') {
      return firstUnsafeScalarText(current, {
        context: currentContext,
        allowMultiline,
      });
    }
    if (!current || typeof current !== 'object') return null;
    if (seen.has(current)) {
      return finding('mcp-circular-value', `${currentContext} contains a circular value.`);
    }
    seen.add(current);
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        const unsafe = visit(current[index], `${currentContext}[${index}]`);
        if (unsafe) return unsafe;
      }
      return null;
    }
    for (const [key, nested] of Object.entries(current)) {
      const unsafe = visit(nested, `${currentContext}.${key}`);
      if (unsafe) return unsafe;
    }
    return null;
  }

  return visit(value, context);
}

function firstUnexpectedCredentialText(value, { context = 'content' } = {}) {
  if (typeof value !== 'string') return null;
  for (const pattern of CREDENTIAL_BLOCK_PATTERNS) {
    if (pattern.test(value)) {
      return finding(
        'mcp-secret-shaped-content',
        `${context} contains credential- or token-shaped content.`,
      );
    }
  }
  return null;
}

module.exports = {
  firstUnexpectedCredentialText,
  firstUnsafeMcpValue,
  firstUnsafeScalarText,
};
