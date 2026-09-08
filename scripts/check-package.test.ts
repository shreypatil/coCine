import { describe, it, expect } from 'vitest'
// @ts-expect-error -- a build script, deliberately plain JavaScript
import { binaryFormat } from './check-package.mjs'

/**
 * The check that stands between a broken installer and somebody's computer.
 *
 * It exists because a Windows build made on Linux shipped with no WebRTC binary
 * and died on launch. Nothing in the source tree was wrong, so no test of the
 * source could have caught it; the only place the bug lived was the artifact.
 */
describe('recognising what a native addon was built for', () => {
  const head = (...bytes: number[]): Buffer => Buffer.from([...bytes, 0, 0, 0, 0]).subarray(0, 4)

  it('knows a Windows addon from a Linux one', () => {
    expect(binaryFormat(head(0x4d, 0x5a, 0x90, 0x00))).toBe('PE')
    expect(binaryFormat(head(0x7f, 0x45, 0x4c, 0x46))).toBe('ELF')
  })

  it('knows a macOS addon, whichever way round it is stored', () => {
    expect(binaryFormat(Buffer.from([0xcf, 0xfa, 0xed, 0xfe]))).toBe('Mach-O')
    expect(binaryFormat(Buffer.from([0xca, 0xfe, 0xba, 0xbe]))).toBe('Mach-O')
  })

  it('says so rather than guessing when it cannot tell', () => {
    expect(binaryFormat(head(0x00, 0x01, 0x02, 0x03))).toBe('unknown')
    expect(binaryFormat(Buffer.from([0x4d]))).toBe('unknown')
  })
})

// @ts-expect-error -- a build script, deliberately plain JavaScript
import { classify, HANDLED, unhandled } from './audit-native.mjs'

/**
 * How a dependency finds its native binary decides whether a build for another
 * platform can succeed at all. Getting this classification wrong is how a
 * Windows installer shipped twice without a working WebRTC binary.
 */
describe('classifying how a package finds its addon', () => {
  it('calls a package with prebuilds for every platform portable', () => {
    expect(classify({ addons: ['prebuilds/win32-x64/thing.node', 'prebuilds/linux-x64/thing.node'] })).toBe('portable')
  })

  it('calls per-platform sibling packages what they are, whatever else is inside', () => {
    // These are the dangerous ones: npm installs only the host's.
    expect(classify({ siblings: ['@x/win32-x64-msvc'], addons: ['prebuilds/linux-x64/a.node'] })).toBe('siblings')
  })

  it('spots a binary built into the package itself', () => {
    // The nested node-datachannel: requires build/Release by relative path.
    expect(classify({ addons: ['build/Release/node_datachannel.node'] })).toBe('local-build')
  })

  it('is not fooled by a path that merely mentions prebuilds', () => {
    expect(classify({ addons: ['lib/prebuildsomething.node'] })).toBe('none')
  })

  it('keeps a list of what the build already supplies', () => {
    // If this set stops matching scripts/fetch-native.mjs, dist.mjs will refuse
    // to build rather than ship a package that cannot start.
    expect(HANDLED.has('node-datachannel')).toBe(true)
    expect(typeof unhandled).toBe('function')
  })
})
