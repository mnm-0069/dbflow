import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const metadataHostnames = new Set([
  'metadata.google.internal', 'metadata.goog', 'metadata.azure.internal', 'metadata.azure.com',
]);

const blockedAddresses = new BlockList();
blockedAddresses.addSubnet('169.254.0.0', 16, 'ipv4');
blockedAddresses.addAddress('100.100.100.200', 'ipv4');
blockedAddresses.addSubnet('fe80::', 10, 'ipv6');
blockedAddresses.addAddress('fd00:ec2::254', 'ipv6');
blockedAddresses.addAddress('0.0.0.0', 'ipv4');
blockedAddresses.addSubnet('224.0.0.0', 4, 'ipv4');
blockedAddresses.addSubnet('240.0.0.0', 4, 'ipv4');

export class DatabaseHostValidationError extends Error {}
export type DatabaseHostLookup = (hostname: string, options: { all: true; verbatim: true }) => Promise<Array<{ address: string; family: number }>>;

function mappedIpv4(address: string) {
  const normalized = address.toLowerCase();
  if (!normalized.includes(':')) return undefined;
  const dotted = normalized.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  const dottedParts = dotted?.[2].split('.').map(Number);
  const dottedTail = dottedParts ? `${((dottedParts[0]! << 8) | dottedParts[1]!).toString(16)}:${((dottedParts[2]! << 8) | dottedParts[3]!).toString(16)}` : '';
  const expandedInput = dotted ? `${dotted[1]}${dottedTail}` : normalized;
  const groups = expandedInput.split('::');
  if (groups.length > 2) return undefined;
  const left = groups[0] ? groups[0]!.split(':').filter(Boolean) : [];
  const right = groups.length === 2 && groups[1] ? groups[1]!.split(':').filter(Boolean) : [];
  const zeros = new Array(Math.max(0, 8 - left.length - right.length)).fill('0');
  const parts = [...left, ...zeros, ...right].map((part) => part.padStart(4, '0'));
  if (parts.length !== 8 || parts.slice(0, 5).some((part) => part !== '0000') || parts[5] !== 'ffff') return undefined;
  const high = Number.parseInt(parts[6]!, 16);
  const low = Number.parseInt(parts[7]!, 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

function isBlockedAddress(address: string, family: number) {
  const mapped = family === 6 ? mappedIpv4(address) : undefined;
  if (mapped) return blockedAddresses.check(mapped, 'ipv4');
  return blockedAddresses.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** Resolve once and connect to that address so DNS cannot change between validation and TCP connect. */
export async function resolveDatabaseHost(hostInput: string, lookup: DatabaseHostLookup = dnsLookup) {
  const hostname = hostInput.trim().replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!hostname || /[\u0000-\u0020\u007f]/.test(hostname)) throw new DatabaseHostValidationError('Enter a valid database host.');
  if (metadataHostnames.has(hostname)) throw new DatabaseHostValidationError('Cloud metadata endpoints cannot be used as database hosts.');
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length) throw new DatabaseHostValidationError('The database host did not resolve to an address.');
  if (addresses.some(({ address, family }) => isBlockedAddress(address, family))) {
    throw new DatabaseHostValidationError('Database hosts resolving to cloud metadata or link-local endpoints are blocked.');
  }
  return {
    address: addresses[0]!.address,
    family: addresses[0]!.family,
    tlsServername: literalFamily ? undefined : hostname,
  };
}
