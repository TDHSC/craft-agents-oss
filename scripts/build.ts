/**
 * Unified desktop application build entrypoint (`bun run build`)
 *
 * Orchestrates `scripts/build/{common,darwin,linux,win32}.ts` to bundle:
 * - Bun runtime + Astral `uv` binary (checksum-verified)
 * - Claude Agent SDK + native per-arch `claude` binary + `@vscode/ripgrep`
 * - Pi Agent Server + native `koffi` addon + network interceptor
 * - WhatsApp worker subprocess (`worker.cjs`)
 * - Electron main, preload, renderer, and packaged installer + update manifest
 */

import { existsSync } from 'fs';
import { join } from 'path';
import {
  type Arch,
  type BuildConfig,
  type Platform,
  buildElectronApp,
  buildSubprocessServers,
  buildWhatsAppWorker,
  cleanBuildArtifacts,
  copyInterceptor,
  copyInterceptorBundle,
  copyPiAgentServer,
  copyRipgrep,
  copySDK,
  createManifest,
  downloadBun,
  downloadUv,
  installDependencies,
  verifySDKCopy,
  verifySubprocessServersExist,
} from './build/common';
import { packageDarwin } from './build/darwin';
import { packageLinux } from './build/linux';
import { buildElectronAppWindows, packageWindows } from './build/win32';

function parsePlatform(): Platform {
  const arg = process.argv.find((a) => a.startsWith('--platform='))?.split('=')[1];
  if (arg === 'darwin' || arg === 'linux' || arg === 'win32') return arg;
  if (process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32') {
    return process.platform;
  }
  throw new Error(`Unsupported platform: ${arg ?? process.platform}`);
}

function parseArch(): Arch {
  const arg = process.argv.find((a) => a.startsWith('--arch='))?.split('=')[1];
  if (arg === 'arm64' || arg === 'x64') return arg;
  if (process.argv.includes('arm64')) return 'arm64';
  if (process.argv.includes('x64')) return 'x64';
  return process.arch === 'arm64' ? 'arm64' : 'x64';
}

async function main() {
  const rootDir = join(import.meta.dir, '..');
  const electronDir = join(rootDir, 'apps', 'electron');
  const platform = parsePlatform();
  const arch = parseArch();

  const config: BuildConfig = {
    platform,
    arch,
    upload: false,
    uploadLatest: false,
    uploadScript: false,
    rootDir,
    electronDir,
  };

  console.log(`=== Building Craft Agents (${platform}-${arch}) ===`);

  cleanBuildArtifacts(config);

  if (process.argv.includes('--install') || !existsSync(join(rootDir, 'node_modules'))) {
    await installDependencies(config);
  }

  await downloadBun(config);
  await downloadUv(config);

  copySDK(config);
  verifySDKCopy(config);
  copyRipgrep(config);
  copyInterceptor(config);

  buildSubprocessServers(config);
  copyPiAgentServer(config);
  verifySubprocessServersExist(config);
  buildWhatsAppWorker(config);

  if (platform === 'win32') {
    await buildElectronAppWindows(config);
  } else {
    await buildElectronApp(config);
  }
  copyInterceptorBundle(config);

  if (platform === 'darwin') {
    await packageDarwin(config);
  } else if (platform === 'linux') {
    await packageLinux(config);
  } else {
    await packageWindows(config);
  }

  await createManifest(config);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
