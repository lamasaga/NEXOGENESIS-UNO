/** Shared by the canvas and layout: entity radius only, excluding glow and hit targets. */
export function sizeFactorOf(degree) {
	const weight = Math.min(1, Math.max(0, (degree - 1) / 19));
	return 1 + 2 * weight;
}

export function nodeWorldRadius(degree) {
	return 3 * sizeFactorOf(degree);
}
