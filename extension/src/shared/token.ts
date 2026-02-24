export function mergeToken(current: string | undefined, token: string): string {
  return `${current ?? ''}${token}`;
}
