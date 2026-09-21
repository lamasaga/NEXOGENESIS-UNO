/**
 * Loopback classification shared by the compatibility-layer trust fence —
 * mirrors the stock `dsh-client-connection` predicate so both fences agree.
 * @param hostname - normalized URL hostname (IPv6 literals keep brackets).
 * @returns true for localhost, IPv6 loopback, or any IPv4 address in 127/8.
 */
export function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	const parts = hostname.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
