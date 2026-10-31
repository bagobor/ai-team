const ALLOWED = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM'];

export function workerEnv(parent: NodeJS.ProcessEnv, extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ALLOWED) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...extra };
}
