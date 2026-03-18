function parseRawFeeInt(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function rawNanoToMinaString(value: number | bigint): string {
  const n = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isFinite(n) || n <= 0) return '0.1';
  const mina = n / 1_000_000_000;
  return mina.toFixed(9).replace(/\.?0+$/, '');
}

async function graphqlRequest(query: string, variables: Record<string, unknown>, graphqlUrl?: string | null): Promise<any> {
  const url = graphqlUrl || process.env.ZEKO_GRAPHQL || 'https://testnet.zeko.io';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  const text = await res.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`fee graphql returned non-JSON response (${res.status})`);
    }
  }
  if (!res.ok) {
    throw new Error(`fee graphql failed with status ${res.status}`);
  }
  if (data?.errors?.length) {
    throw new Error(String(data.errors[0]?.message || 'fee graphql error'));
  }
  return data?.data ?? null;
}

export async function getSuggestedSequencerFee(
  graphqlUrl?: string | null
): Promise<{ feeRaw: string; fee: string; source: string }> {
  const fallback = 100000000;
  try {
    const data = await graphqlRequest(
      `query {
        pooledZkappCommands { feePayer { fee } }
        pooledUserCommands { feePayer { fee } }
      }`,
      {},
      graphqlUrl
    );
    const pooled = [
      ...(Array.isArray(data?.pooledZkappCommands) ? data.pooledZkappCommands : []),
      ...(Array.isArray(data?.pooledUserCommands) ? data.pooledUserCommands : [])
    ];
    const fees = pooled
      .map((entry: any) => parseRawFeeInt(entry?.feePayer?.fee))
      .filter((value): value is number => value !== null && Number.isFinite(value) && value > 0)
      .sort((a, b) => a - b);
    if (!fees.length) {
      return {
        feeRaw: String(fallback),
        fee: rawNanoToMinaString(fallback),
        source: 'configured-fallback'
      };
    }
    const p75 = fees[Math.min(fees.length - 1, Math.floor(fees.length * 0.75))];
    const suggested = Math.max(fallback, p75);
    return {
      feeRaw: String(suggested),
      fee: rawNanoToMinaString(suggested),
      source: 'sequencer-mempool-p75'
    };
  } catch {
    return {
      feeRaw: String(fallback),
      fee: rawNanoToMinaString(fallback),
      source: 'configured-fallback'
    };
  }
}
