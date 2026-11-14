// A preload that makes any outbound call fail loudly, for the tests that hold the "nothing leaves
// the machine" claim to the commands that make it.
//
// Not a mock that records calls and lets them through: a command that reaches the network under a
// recording mock still reached the network, and the point is to prove it never tries. Every door
// out is replaced with one that throws a recognisable message, so a command that opens one fails
// the test rather than quietly succeeding on a cached answer or an empty response.
//
// Loaded with `node --import ./engine/test/no-network.ts <command>`, which runs before the entry
// point, so a module that captures `fetch` at import time captures this one.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

/** The marker a test greps for. Distinctive enough that it cannot be confused with a real error. */
export const REACHED_OUT = 'TEWIP-TEST-REACHED-THE-NETWORK';

/**
 * Every door this file actually replaced, recorded as it is replaced, and published on the global
 * so a test can check the list rather than infer it from behaviour.
 *
 * Behaviour alone is not enough, and finding that out is why this exists: deleting the `tls.connect`
 * patch changed nothing observable, because `tls.connect` goes through `net.connect` underneath and
 * that one was still patched. The door was shut, but not by the line claiming to shut it - so a test
 * that only watches for a thrown error would keep passing as the patches were removed one by one,
 * until the last one went and the whole thing came open at once.
 */
export const SHUT: string[] = [];
(globalThis as { __tewipShut?: string[] }).__tewipShut = SHUT;

const refuse = (what: string): never => {
  throw new Error(`${REACHED_OUT}: ${what}`);
};

/** Replace one door, and record that this file is the thing that replaced it. */
function shut(host: object, key: string, label: string): void {
  Object.defineProperty(host, key, { configurable: true, writable: true, value: () => refuse(label) });
  SHUT.push(label);
}

// `fetch` first, because it is the one a modern module reaches for.
shut(globalThis, 'fetch', 'fetch');

for (const [name, mod] of [
  ['http', http],
  ['https', https],
] as const) {
  for (const fn of ['request', 'get'] as const) shut(mod, fn, `${name}.${fn}`);
}

// The layer under both of those. A module using a socket directly, or an agent this file has not
// thought of, still has to come through here.
shut(net, 'connect', 'net.connect');
shut(net, 'createConnection', 'net.createConnection');
shut(tls, 'connect', 'tls.connect');

// A name looked up is an intention to connect, and worth failing on its own: it reaches a resolver
// off this machine even when the connection that follows never happens.
for (const fn of ['lookup', 'resolve'] as const) shut(dns, fn, `dns.${fn}`);
shut(dns.promises, 'lookup', 'dns.promises.lookup');
