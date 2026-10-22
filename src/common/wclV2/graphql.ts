import { getAccessToken } from './auth';

const USER_ENDPOINT = 'https://www.warcraftlogs.com/api/v2/user';

export class WclV2AuthRequiredError extends Error {}

export class WclV2GraphqlError extends Error {
  constructor(readonly messages: string[]) {
    super(messages.join('; '));
  }
}

/**
 * Runs a GraphQL query against Warcraft Logs v2. Logged-in users call WCL directly with their
 * own token (their own rate limit). Anonymous users go through VITE_WCL_PROXY_URL if configured.
 */
export async function wclQuery<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  if (import.meta.env.MODE === 'test') {
    throw new Error('Unable to query WCL during test');
  }
  const token = getAccessToken();
  const proxy: string | undefined = import.meta.env.VITE_WCL_PROXY_URL || undefined;
  if (!token && !proxy) {
    throw new WclV2AuthRequiredError();
  }

  const response = await fetch(token ? USER_ENDPOINT : proxy!, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  if (response.status === 401) {
    throw new WclV2AuthRequiredError();
  }
  const json = (await response.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) {
    throw new WclV2GraphqlError(json.errors.map((e) => e.message));
  }
  if (!response.ok || !json.data) {
    throw new Error(`Warcraft Logs API error (${response.status})`);
  }
  return json.data;
}
