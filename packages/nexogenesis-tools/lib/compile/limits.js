export const COMPILE_RESOURCE_LIMITS = Object.freeze({
	maxArchiveEntries: 4096,
	maxArchiveEntryBytes: 32 * 1024 * 1024,
	maxArchiveExpandedBytes: 256 * 1024 * 1024,
	maxCompressionRatio: 200,
	processTimeoutMs: 60_000,
	figureProcessTimeoutMs: 45_000,
	maxProcessOutputBytes: 64 * 1024 * 1024
});
