import { debug } from "../utils/debug";

const GITHUB_REPO = 'TDHSC/craft-agents-oss';
const GITHUB_API_LATEST_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const VERSIONS_URL = `https://github.com/${GITHUB_REPO}/releases/download`;

export async function getLatestVersion(): Promise<string | null> {
    try {
      const response = await fetch(GITHUB_API_LATEST_URL, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!response.ok) {
        debug(`[manifest] GitHub latest release returned HTTP ${response.status}`);
        return null;
      }
      const data = await response.json() as { tag_name?: string; version?: string };
      const raw = data.tag_name ?? data.version;
      if (typeof raw !== 'string') {
        debug('[manifest] Latest version is not a valid string');
        return null;
      }
      const version = raw.replace(/^v/, '').trim();
      return version || null;
    } catch (error) {
      debug(`[manifest] Failed to get latest version: ${error}`);
    }
    return null;
}

export async function getManifest(version: string): Promise<VersionManifest | null> {
    try {
        const tag = version.startsWith('v') ? version : `v${version}`;
        const url = `${VERSIONS_URL}/${tag}/manifest.json`;
        debug(`[manifest] Getting manifest for version: ${url}`);
        const response = await fetch(url);
        if (!response.ok) return null;
        const data = await response.json();
        return data as VersionManifest;
    } catch (error) {
        debug(`[manifest] Failed to get manifest: ${error}`);
    }
    return null;
}


export interface BinaryInfo {
  url: string;
  sha256: string;
  size: number;
  filename?: string;
}

export interface VersionManifest {
  version: string;
  build_time: string;
  build_timestamp: number;
  binaries: Record<string, BinaryInfo>;
}
