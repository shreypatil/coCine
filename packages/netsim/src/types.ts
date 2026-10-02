/**
 * A network to pretend to be.
 *
 * The vocabulary is deliberately the product's rather than the kernel's: a
 * scenario names *sites* -- someone's machine and whatever sits between it and
 * the internet -- because that is the unit coCine's connectivity is a property
 * of. Namespaces, veth pairs, bridges and qdiscs are how it is built, and
 * nothing outside `plan.ts` has to know that.
 */

/**
 * How a NAT allocates its external port.
 *
 * `cone` is endpoint-independent mapping: the same internal socket appears on
 * the same external port whoever it is talking to, which is what makes hole
 * punching work and what most home broadband does.
 *
 * `symmetric` allocates per destination, so the address a STUN server reports
 * is not the address a peer would reach -- the case that no amount of ICE can
 * rescue, and the one that costs coCine a film transfer.
 */
export type NatKind = 'cone' | 'symmetric'

/** What a link does to the packets crossing it. All optional; all per-direction. */
export interface Shaping {
  /** One-way delay in milliseconds. */
  delayMs?: number
  /** Uniform jitter around `delayMs`. Requires `delayMs`. */
  jitterMs?: number
  /** Percentage of packets dropped, 0-100. */
  lossPct?: number
  /**
   * Percentage of packets sent immediately rather than delayed, which is how
   * netem reorders. Requires `delayMs`, because reordering is expressed as
   * some packets skipping the delay.
   */
  reorderPct?: number
  /** Bandwidth ceiling in megabits per second. */
  rateMbit?: number
}

/**
 * One participant's network position.
 *
 * `nat` is listed innermost first -- `['cone']` is an ordinary home router,
 * `['cone', 'symmetric']` is that router behind a carrier's symmetric NAT,
 * which is the mobile-network case. An empty list puts the machine directly on
 * the simulated internet, which is what a server is.
 */
export interface SiteSpec {
  /** Also the network namespace's name. Must not be `net`. */
  name: string
  /** NAT layers between this machine and the internet, innermost first. */
  nat?: NatKind[]
  /**
   * Drop UDP at the outermost link, in both directions -- the corporate and
   * university case, where the only way out is TCP on a well-known port.
   */
  udpBlocked?: boolean
  /** Shaping applied in both directions on the access link. */
  link?: Shaping
  /** Shaping for this site's upload, overriding `link`. */
  up?: Shaping
  /** Shaping for this site's download, overriding `link`. */
  down?: Shaping
}

export interface ScenarioSpec {
  sites: SiteSpec[]
  /**
   * Shaping for any site that specifies none of its own.
   *
   * Deliberately not "the internet's shaping": there is no backbone qdisc here,
   * and folding a shared delay into each access link is both simpler and the
   * more faithful model -- the round trip between two people really is the sum
   * of what each of their own connections costs.
   */
  defaultLink?: Shaping
}

/**
 * One step of building the topology.
 *
 * Kept as argv rather than a shell string so nothing has to be quoted and
 * nothing can be injected by a scenario's site name.
 */
export interface Command {
  /** Network namespace to run in; absent means the simulator's own. */
  ns?: string
  argv: string[]
  /** Fed to the command's stdin -- `nft -f -` takes its ruleset this way. */
  stdin?: string
  /** What this step is for, quoted back when it fails. */
  label: string
  /** A step allowed to fail, such as a mount that is already private. */
  optional?: boolean
}

/** A process to run inside the built topology. */
export interface WorkloadSpec {
  /** Reported back with the result. */
  name: string
  /** The namespace to run in: a site's name, or `net` for the internet. */
  ns: string
  argv: string[]
  /** Wait this long after the topology is up before starting. */
  delayMs?: number
  /** Killed after this long. Defaults to the run's timeout. */
  timeoutMs?: number
}

export interface WorkloadResult {
  name: string
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface ScenarioResult {
  ok: boolean
  /** Set when a topology step failed, in which case no workload ran. */
  setupError?: string
  workloads: WorkloadResult[]
}
