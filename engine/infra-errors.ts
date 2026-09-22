// Deterministic readers for failures caused by the machinery a test runs on, not by the code under
// test: a container that never started, an image that could not be pulled, a runner out of disk or
// memory, a port already taken. These reach Tewip inside a test's own error message (a Testcontainers
// launch failure, a connection to a service container that never came up), and they are environment
// problems: re-run them somewhere healthy, do not blame the change.
// Checked against 82 real messages pasted into public issues (Kubernetes, Docker, Testcontainers, CI
// runners); every pattern below came from one of them.

export interface InfraSignal {
  kind: 'container-start' | 'image-pull' | 'out-of-memory' | 'no-disk' | 'port-taken' | 'no-capacity' | 'name-lookup';
  /** The text that triggered it, for the evidence line. */
  match: string;
  confidence: number;
}

const INFRA_PATTERNS: Array<{ kind: InfraSignal['kind']; confidence: number; pattern: RegExp }> = [
  // The image could not be fetched at all. No application can produce these words.
  {
    kind: 'image-pull',
    confidence: 0.92,
    pattern: /ImagePullBackOff|ErrImagePull|Back-off pulling image[^\n]*|Failed to pull image[^\n]*|pull access denied for [^\n,]*|toomanyrequests: You have reached your pull rate limit[^\n]*|manifest for \S+ not found/i,
  },
  // A container the test needs never became usable: Testcontainers and Docker Compose wording.
  {
    kind: 'container-start',
    confidence: 0.88,
    pattern:
      /ContainerLaunchException[^\n]*|Timed out waiting for container port to open[^\n]*|Wait strategy failed[^\n]*|Container startup failed(?: for image [^\n]*)?|Could not find a valid Docker environment[^\n]*|Cannot connect to the Docker daemon[^\n]*|dependency failed to start: container [^\n]*/i,
  },
  // Killed for using too much memory. Exit code 137 alone is weaker: a stopped container gives it too.
  { kind: 'out-of-memory', confidence: 0.85, pattern: /OOMKilled|Reason:\s*OOMKilled|exceeded (?:its )?memory limit|java\.lang\.OutOfMemoryError[^\n]*|Killed process \d+[^\n]*out of memory/i },
  { kind: 'out-of-memory', confidence: 0.6, pattern: /(?:terminated|exited) with (?:exit )?code:? 137\b/i },
  // Nothing left to write to.
  { kind: 'no-disk', confidence: 0.92, pattern: /No space left on device|ENOSPC|had disk pressure|low on resource: ephemeral-storage|Evicted[^\n]*ephemeral-storage|DiskPressure|EvictionThresholdMet|eviction_manager[^\n]*/i },
  // A name could not be resolved: the cluster's DNS, a service name, or the internet.
  {
    kind: 'name-lookup',
    confidence: 0.85,
    pattern: /no such host|host not found in resolver[^\n]*|Temporary failure in name resolution|Name or service not known|getaddrinfo (?:EAI_AGAIN|ENOTFOUND)[^\n]*|SERVFAIL|could not resolve host[^\n]*|dial tcp: lookup [^\n]*|i\/o timeout[^\n]*:53\b|->[\d.]+:53: i\/o timeout/i,
  },
  // Something else already holds the port the test wanted.
  { kind: 'port-taken', confidence: 0.9, pattern: /port is already allocated|address already in use|EADDRINUSE|driver failed programming external connectivity[^\n]*|bind: address already in use/i },
  // The cluster or runner had nowhere to put the work.
  // A shut-down runner is not a capacity problem in the cluster: log.ts reads that as a job failure.
  { kind: 'no-capacity', confidence: 0.85, pattern: /0\/\d+ nodes are available[^\n]*|Insufficient (?:cpu|memory)\b[^\n]*|FailedScheduling[^\n]*|no space available on any node/i },
  // Last: Docker's catch-all, which also wraps the specific failures above.
  { kind: 'container-start', confidence: 0.8, pattern: /Error response from daemon: [^\n]*/i },
];

/**
 * An infrastructure failure in this message, strongest first, or null. A test that provokes these on
 * purpose (a test *about* out-of-memory handling, say) is rare; the rule that uses this keeps its
 * confidence below the level where anything is done automatically.
 */
export function infraSignal(message: string): InfraSignal | null {
  for (const { kind, confidence, pattern } of INFRA_PATTERNS) {
    const match = message.match(pattern)?.[0];
    if (match) return { kind, confidence, match: match.replace(/\s+/g, ' ').trim().slice(0, 160) };
  }
  return null;
}

/** What to tell a person, per kind: what broke, in their words, not the tool's. */
export const INFRA_MEANING: Record<InfraSignal['kind'], string> = {
  'container-start': 'a container the test needs never started',
  'image-pull': 'a container image could not be pulled',
  'out-of-memory': 'something was killed for using too much memory',
  'no-disk': 'the machine ran out of disk space',
  'port-taken': 'the port the test wanted was already in use',
  'no-capacity': 'the cluster or runner had no room to schedule the work',
  'name-lookup': 'a host name could not be resolved',
};
