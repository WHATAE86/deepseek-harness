/**
 * Build a portable web-profile runtime for one platform and architecture.
 *
 * The repository ships an executable builder for the Python SDK closure, but
 * that closure mounts the `sdk` profile and carries no Web frontend. The
 * portable build needs the `web` profile, so this script reuses the shipped
 * deploy mechanics with a different assembly:
 *
 *   install -> build:artifacts -> deploy the `dsh` CLI package with a hoisted,
 *   symlink-free node_modules -> restore the workspace packages that legacy
 *   deploy omits -> copy the Web frontend -> report the payload.
 *
 * Usage:
 *   node scripts/build-portable-runtime.mjs --out <dir> --platform <p> --arch <a>
 *
 * `platform` is one of win32, darwin, linux; `arch` is x64 or arm64. The build
 * must run on the target platform because the native modules (node-pty, koffi,
 * node-addon-system) compile there.
 */

import { cp, lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

/** Packages the CLI needs but legacy deploy omits, because workspace:* is not a semver range. */
const WORKSPACE_RESTORE = ['packages', 'vendor', 'apps']

function log(message) {
  process.stdout.write(`[portable] ${message}\n`)
}

function run(command, args, options = {}) {
  log(`$ ${command} ${args.join(' ')}`)
  return execFileSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  })
}

/**
 * Parse `--flag value` pairs into an object.
 * @param {string[]} argv - Raw arguments after the script name.
 * @returns {Record<string, string>} Parsed flags.
 */
function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`build-portable-runtime: expected --flag value pairs, got ${JSON.stringify(argv)}`)
    }
    parsed[key.slice(2)] = value
  }
  return parsed
}

/**
 * Index every workspace package by its manifest name.
 * @returns {Promise<Map<string, { dir: string, name: string }>>} Package lookup.
 */
async function indexWorkspacePackages() {
  const index = new Map()
  for (const group of WORKSPACE_RESTORE) {
    const groupDir = join(root, group)
    if (!existsSync(groupDir)) continue
    for (const entry of await readdir(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidates = [join(groupDir, entry.name)]
      // packages/<group>/<pkg> is one level deeper than vendor/<pkg>.
      if (group === 'packages') {
        for (const inner of await readdir(candidates[0], { withFileTypes: true })) {
          if (inner.isDirectory()) candidates.push(join(candidates[0], inner.name))
        }
      }
      for (const candidate of candidates) {
        const manifest = join(candidate, 'package.json')
        if (!existsSync(manifest)) continue
        try {
          const { name } = JSON.parse(await readFile(manifest, 'utf8'))
          if (typeof name === 'string') index.set(name, { dir: candidate, name })
        } catch {
          // A malformed manifest is not a workspace package worth indexing.
        }
      }
    }
  }
  return index
}

/**
 * Copy workspace packages that legacy deploy left out, so the deployed tree
 * resolves every bare specifier the loaded plugins import.
 * @param {string} out - Deployed payload root.
 * @returns {Promise<number>} Number of packages restored.
 */
async function restoreWorkspacePackages(out) {
  const index = await indexWorkspacePackages()
  const scopeDir = join(out, 'node_modules', '@deepseek-ai')
  let restored = 0
  for (const { dir, name } of index.values()) {
    const shortName = name.startsWith('@deepseek-ai/') ? name.slice('@deepseek-ai/'.length) : name
    const target = join(scopeDir, shortName)
    if (existsSync(join(target, 'lib', 'index.js')) || existsSync(join(target, 'package.json'))) continue
    if (!existsSync(join(dir, 'lib'))) continue
    await mkdir(target, { recursive: true })
    await cp(join(dir, 'lib'), join(target, 'lib'), { recursive: true })
    await cp(join(dir, 'package.json'), join(target, 'package.json'))
    restored += 1
  }
  return restored
}

/**
 * Report the deployed payload size and entry points.
 * @param {string} out - Deployed payload root.
 */
async function reportPayload(out) {
  const entry = join(out, 'lib', 'bin.js')
  if (!existsSync(entry)) throw new Error(`build-portable-runtime: CLI entry missing at ${entry}`)
  const frontend = join(out, 'apps', 'web', 'dist', 'index.html')
  if (!existsSync(frontend)) throw new Error(`build-portable-runtime: Web frontend missing at ${frontend}`)
  const packages = await readdir(join(out, 'node_modules', '@deepseek-ai'))
  log(`deployed ${packages.length} scoped packages`)
  log(`CLI entry    : ${entry}`)
  log(`Web frontend : ${frontend}`)
}

const args = parseArgs(process.argv.slice(2))
const out = resolve(args.out ?? join(root, 'dist-portable'))
const platform = args.platform ?? process.platform
const arch = args.arch ?? process.arch

log(`target ${platform}-${arch}`)
log(`output ${out}`)

if (platform !== process.platform || arch !== process.arch) {
  throw new Error(
    `build-portable-runtime: build on the target host; target ${platform}-${arch} `
    + `does not match host ${process.platform}-${process.arch}. Native modules compile only for the host.`,
  )
}

await rm(out, { recursive: true, force: true })
// Create the output directory itself; its parent must already exist, because
// creating an arbitrary ancestor is never this script's job.
await mkdir(out, { recursive: true })

if (!existsSync(join(root, 'node_modules'))) {
  run('pnpm', ['install', '--frozen-lockfile'])
}

log('building artifacts')
run('pnpm', ['run', 'build:artifacts'])

log('deploying a hoisted, symlink-free payload')
run('pnpm', [
  '--filter', '@deepseek-ai/dsh', 'deploy',
  '--legacy', '--prod',
  '--config.allow-unused-patches=true',
  '--config.node-linker=hoisted',
  '--config.auto-install-peers=false',
  '--config.link-workspace-packages=true',
  '--config.hoist-workspace-packages=false',
  out,
])

log('restoring workspace packages legacy deploy omits')
const restored = await restoreWorkspacePackages(out)
log(`restored ${restored} packages`)

log('copying the Web frontend')
await cp(join(root, 'apps', 'web', 'dist'), join(out, 'apps', 'web', 'dist'), { recursive: true })

/**
 * List every symlink below `dir`, without following any of them.
 * @param {string} dir - Root to walk.
 * @returns {Promise<string[]>} Absolute paths of symlinks.
 */
async function findSymlinks(dir) {
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    const info = await lstat(path)
    if (info.isSymbolicLink()) {
      found.push(path)
      continue
    }
    if (info.isDirectory()) found.push(...await findSymlinks(path))
  }
  return found
}

/**
 * Replace every symlink below `dir` with the bytes it points at. exFAT cannot
 * store symlinks, and a payload destined for a USB drive must not contain any.
 * Junctioned workspace packages are the ones legacy deploy leaves behind, and
 * they always point at another directory inside the same tree.
 *
 * Copying a link target can introduce new symlinks of its own (a junctioned
 * package carries its own nested node_modules), so this repeats until a full
 * pass finds nothing left to replace.
 * @param {string} dir - Root whose subtree is materialized in place.
 * @returns {Promise<string[]>} Paths that were replaced.
 */
async function materializeSymlinks(dir) {
  const replaced = []
  for (let pass = 0; pass < 32; pass++) {
    const found = await findSymlinks(dir)
    if (found.length === 0) return replaced
    for (const path of found) {
      let target
      try {
        target = await realpath(path)
      } catch {
        // A dangling link names nothing copyable; drop it rather than fail the
        // build, because the deploy never resolves through it.
        await rm(path, { recursive: true, force: true })
        replaced.push(path)
        continue
      }
      await rm(path, { recursive: true, force: true })
      // `dereference` matters: without it, cp copies nested links as links,
      // which is the whole thing this function exists to prevent.
      await cp(target, path, { recursive: true, dereference: true })
      replaced.push(path)
    }
  }
  throw new Error(`build-portable-runtime: symlinks still present after 32 passes in ${dir}`)
}

log('materializing symlinks so the payload survives exFAT')
const replaced = await materializeSymlinks(out)
for (const path of replaced) log(`  materialized ${path.slice(out.length + 1)}`)

// Prove the payload is symlink-free after materialization.
const offenders = await findSymlinks(out)
if (offenders.length > 0) {
  const list = offenders.slice(0, 10).join('\n')
  throw new Error(
    `build-portable-runtime: payload still contains ${offenders.length} symlinks:\n${list}`,
  )
}

await writeFile(
  join(out, 'PORTABLE-BUILD.json'),
  `${JSON.stringify({ platform, arch, builtAt: new Date().toISOString() }, null, 2)}\n`,
)

const total = await stat(out)
log(`done: ${out} (${total.size} bytes at root)`)
await reportPayload(out)
