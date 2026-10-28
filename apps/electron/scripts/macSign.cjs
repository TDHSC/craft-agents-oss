/**
 * Custom macOS signing hook for electron-builder (`mac.sign`).
 *
 * Priority order:
 * 1. Dedicated passwordless signing keychain (`CRAFT_CODESIGN_KEYCHAIN` in CI or
 *    `~/.craft-agent/codesign/craft-codesign.keychain-db` locally), which already has
 *    `set-key-partition-list` configured so `codesign` never hangs on interactive
 *    `login.keychain-db` GUI prompts.
 *    Also sets `timestamp: "none"` for self-signed certificates so `codesign` does not
 *    make hundreds of sequential HTTP requests to `timestamp.apple.com` (cuts signing
 *    time from ~4 minutes down to ~5 seconds).
 * 2. Standard Apple Developer ID identity already resolved by electron-builder (`opts.identity`).
 * 3. `opts.keychain` created by electron-builder from `CSC_LINK`.
 * 4. Ad-hoc fallback (`-`) when no signing certificate is configured.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { sign } = require('app-builder-lib/out/codeSign/macCodeSign');

function findCodeSigningIdentityHash(keychainPath) {
  const args = ['find-identity', '-p', 'codesigning'];
  if (keychainPath) {
    args.push(keychainPath);
  }
  const output = execFileSync('/usr/bin/security', args, { encoding: 'utf8' });
  const match = output.match(/([0-9A-F]{40})\s+"([^"]+)"/);
  if (!match) {
    return null;
  }
  return { hash: match[1], name: match[2] };
}

function resolveDedicatedKeychain() {
  if (process.env.CRAFT_CODESIGN_KEYCHAIN && fs.existsSync(process.env.CRAFT_CODESIGN_KEYCHAIN)) {
    return {
      keychain: process.env.CRAFT_CODESIGN_KEYCHAIN,
      password:
        process.env.CRAFT_CODESIGN_PASS ||
        (process.env.CRAFT_CODESIGN_PASS_FILE && fs.existsSync(process.env.CRAFT_CODESIGN_PASS_FILE)
          ? fs.readFileSync(process.env.CRAFT_CODESIGN_PASS_FILE, 'utf8').trim()
          : null),
    };
  }

  const localDir = path.join(os.homedir(), '.craft-agent', 'codesign');
  const localKeychain = path.join(localDir, 'craft-codesign.keychain-db');
  const localPassFile = path.join(localDir, 'craft-codesign.pass');
  if (fs.existsSync(localKeychain)) {
    return {
      keychain: localKeychain,
      password: fs.existsSync(localPassFile) ? fs.readFileSync(localPassFile, 'utf8').trim() : null,
    };
  }

  return null;
}

function withNoRemoteTimestamp(opts) {
  const origOptionsForFile = opts.optionsForFile;
  return {
    ...opts,
    optionsForFile: (filePath) => {
      const base = origOptionsForFile ? origOptionsForFile(filePath) : {};
      return {
        ...base,
        timestamp: 'none',
      };
    },
  };
}

module.exports = async function customMacSign(opts) {
  // 1. Prefer dedicated signing keychain first (has partition-list preconfigured -> zero GUI prompts)
  const dedicatedKc = resolveDedicatedKeychain();
  if (dedicatedKc && fs.existsSync(dedicatedKc.keychain)) {
    if (dedicatedKc.password) {
      execFileSync('/usr/bin/security', ['unlock-keychain', '-p', dedicatedKc.password, dedicatedKc.keychain]);
    }
    const found = findCodeSigningIdentityHash(dedicatedKc.keychain);
    if (found && (!process.env.APPLE_SIGNING_IDENTITY || found.name.includes(process.env.APPLE_SIGNING_IDENTITY))) {
      const isAppleCert =
        found.name.startsWith('Developer ID Application:') ||
        found.name.startsWith('3rd Party Mac Developer Application:');
      console.log(
        `macSign: signing with "${found.name}" (${found.hash}) using dedicated keychain` +
          (isAppleCert ? '' : ' [timestamp=none]')
      );
      const nextOpts = {
        ...opts,
        identity: found.hash,
        keychain: dedicatedKc.keychain,
        identityValidation: false,
      };
      return sign(isAppleCert ? nextOpts : withNoRemoteTimestamp(nextOpts));
    }
  }

  // 2. Apple Developer ID or trusted identity already discovered by electron-builder
  if (opts.identity && opts.identity !== '-') {
    console.log(`macSign: signing with discovered identity "${opts.identity}"`);
    return sign(opts);
  }

  // 3. Temp keychain created by electron-builder from CSC_LINK
  if (opts.keychain && fs.existsSync(opts.keychain)) {
    const found = findCodeSigningIdentityHash(opts.keychain);
    if (found) {
      console.log(`macSign: signing with "${found.name}" (${found.hash}) from ${opts.keychain} [timestamp=none]`);
      return sign(
        withNoRemoteTimestamp({
          ...opts,
          identity: found.hash,
          keychain: opts.keychain,
          identityValidation: false,
        })
      );
    }
  }

  // 4. Fallback to ad-hoc signing (required on Apple Silicon when no cert is configured)
  console.log('macSign: no signing certificate found; falling back to ad-hoc signature (-)');
  return sign(
    withNoRemoteTimestamp({
      ...opts,
      identity: '-',
      keychain: undefined,
      identityValidation: false,
    })
  );
};
