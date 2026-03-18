import './env.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
}

function parseOptionalArgValue(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const direct = args.find((arg) => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const baseUrl = requireEnv('OPERATOR_BASE_URL').replace(/\/+$/, '');
  const token = requireEnv('OPERATOR_ACTION_TOKEN');
  const reason = parseOptionalArgValue(args, 'reason') || 'fresh zkApp rollout reset';
  const response = await fetch(`${baseUrl}/api/operator/reset-fresh-zkapp-state`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-operator-token': token
    },
    body: JSON.stringify({ reason })
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`non-JSON response (status ${response.status}): ${text.slice(0, 200)}`);
  }
  if (!response.ok) {
    const message =
      parsed && typeof parsed === 'object' && parsed !== null && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `request failed with status ${response.status}`;
    throw new Error(message);
  }
  console.log(JSON.stringify(parsed, null, 2));
}

main().catch((error: unknown) => {
  console.error('[fresh-zkapp:reset-hosted-state] failed:', error);
  process.exit(1);
});
