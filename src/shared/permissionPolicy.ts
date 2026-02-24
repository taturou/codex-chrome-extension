export interface PermissionPolicy {
  hostPermissions: string[];
  optionalHostPermissions: string[];
}

function normalizeOrigins(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const normalized = values
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return Array.from(new Set(normalized)).sort((a, b) => a.localeCompare(b));
}

export function extractPermissionPolicy(manifest: chrome.runtime.Manifest): PermissionPolicy {
  return {
    hostPermissions: normalizeOrigins(manifest.host_permissions),
    optionalHostPermissions: normalizeOrigins(manifest.optional_host_permissions)
  };
}

export function serializePermissionPolicy(policy: PermissionPolicy): string {
  return JSON.stringify({
    hostPermissions: policy.hostPermissions,
    optionalHostPermissions: policy.optionalHostPermissions
  });
}

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const view = new Uint8Array(digest);
  return Array.from(view)
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}

function splitMatchPattern(pattern: string): { scheme: string; host: string; path: string } | undefined {
  const matched = pattern.match(/^(\*|http|https|ws|wss):\/\/([^/]+)(\/.*)$/);
  if (!matched) {
    return undefined;
  }
  return {
    scheme: matched[1],
    host: matched[2].toLowerCase(),
    path: matched[3]
  };
}

function pathMatches(urlPath: string, patternPath: string): boolean {
  const escaped = patternPath.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`^${escaped.replace(/\*/g, '.*')}$`);
  return regex.test(urlPath);
}

function hostMatches(hostname: string, patternHost: string): boolean {
  if (patternHost === '*') {
    return true;
  }

  if (patternHost.startsWith('*.')) {
    const base = patternHost.slice(2);
    return hostname === base || hostname.endsWith(`.${base}`);
  }

  return hostname === patternHost;
}

function matchPattern(url: URL, pattern: string): boolean {
  const parsed = splitMatchPattern(pattern);
  if (!parsed) {
    return false;
  }

  const normalizedProtocol = url.protocol.slice(0, -1);
  if (parsed.scheme !== '*' && parsed.scheme !== normalizedProtocol) {
    return false;
  }

  if (!hostMatches(url.hostname.toLowerCase(), parsed.host)) {
    return false;
  }

  return pathMatches(url.pathname, parsed.path);
}

export function isUrlAllowedByPermissionPolicy(url: string, policy: PermissionPolicy): boolean {
  const parsed = new URL(url);
  const patterns = [...policy.hostPermissions, ...policy.optionalHostPermissions];
  return patterns.some((pattern) => matchPattern(parsed, pattern));
}

export function assertUrlAllowedByPermissionPolicy(url: string, policy: PermissionPolicy, label: string): string {
  const normalized = url.trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  if (!isUrlAllowedByPermissionPolicy(normalized, policy)) {
    throw new Error(`${label} is not permitted by manifest policy (${normalized})`);
  }
  return normalized;
}
