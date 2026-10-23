/// <reference lib="webworker" />
import './workerShim';
import configs from 'parser';
import { setAccessToken } from 'common/wclV2/auth';

import { Profile } from '../profile/types';
import { setProfile } from '../profile/registry';
import { LogRef, parseLogSnapshot } from './parseLog';

export interface ParseRequest {
  id: number;
  specId: number;
  /** The analyzed log's profile, so benchmarks are scored the same way. */
  profile: Profile;
  ref: LogRef;
  /** The page's WCL v2 token: workers can't read the page's localStorage. */
  wclToken: string | null;
}

export type ParseResponse =
  | { id: number; snapshot: Awaited<ReturnType<typeof parseLogSnapshot>> }
  | { id: number; error: string };

/** Parses benchmark logs off the main thread; see `parseBenchmarkLog`. */
self.onmessage = async ({ data }: MessageEvent<ParseRequest>) => {
  try {
    const config = configs.find((c) => c.spec.id === data.specId);
    if (!config) {
      throw new Error(`No parser registered for spec ${data.specId}`);
    }
    setAccessToken(data.wclToken);
    setProfile(data.specId, data.profile);
    const snapshot = await parseLogSnapshot(config, data.ref);
    self.postMessage({ id: data.id, snapshot } satisfies ParseResponse);
  } catch (err) {
    self.postMessage({ id: data.id, error: (err as Error).message } satisfies ParseResponse);
  }
};
