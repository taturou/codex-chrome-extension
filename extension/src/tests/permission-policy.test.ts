import { describe, expect, it } from 'vitest';
import {
  assertUrlAllowedByPermissionPolicy,
  extractPermissionPolicy,
  isUrlAllowedByPermissionPolicy,
  serializePermissionPolicy
} from '../shared/permissionPolicy';

function createManifestStub(): chrome.runtime.Manifest {
  return {
    manifest_version: 3,
    name: 'test',
    version: '0.0.1',
    host_permissions: ['ws://localhost/*', 'ws://127.0.0.1/*', 'https://localhost/*'],
    optional_host_permissions: ['http://*/*', 'https://*/*']
  } as chrome.runtime.Manifest;
}

describe('permissionPolicy', () => {
  it('manifestからpolicyを正規化抽出する', () => {
    const manifest = createManifestStub();
    const policy = extractPermissionPolicy(manifest);
    expect(policy.hostPermissions).toEqual(['https://localhost/*', 'ws://127.0.0.1/*', 'ws://localhost/*']);
    expect(policy.optionalHostPermissions).toEqual(['http://*/*', 'https://*/*']);
  });

  it('ws URLの許可判定を行う', () => {
    const policy = extractPermissionPolicy(createManifestStub());
    expect(isUrlAllowedByPermissionPolicy('ws://localhost:3000/chat', policy)).toBe(true);
    expect(isUrlAllowedByPermissionPolicy('wss://example.com/chat', policy)).toBe(false);
  });

  it('http optional_host_permissions を許可判定できる', () => {
    const policy = extractPermissionPolicy(createManifestStub());
    expect(isUrlAllowedByPermissionPolicy('https://example.com/path', policy)).toBe(true);
    expect(isUrlAllowedByPermissionPolicy('http://example.net/path', policy)).toBe(true);
  });

  it('不許可URLはエラーで拒否する', () => {
    const policy = extractPermissionPolicy(createManifestStub());
    expect(() => assertUrlAllowedByPermissionPolicy('wss://evil.example/path', policy, 'WebSocket URL')).toThrow(
      'not permitted'
    );
  });

  it('policyシリアライズの順序は安定している', () => {
    const policy = extractPermissionPolicy(createManifestStub());
    expect(serializePermissionPolicy(policy)).toBe(
      '{"hostPermissions":["https://localhost/*","ws://127.0.0.1/*","ws://localhost/*"],"optionalHostPermissions":["http://*/*","https://*/*"]}'
    );
  });
});
