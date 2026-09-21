/**
 * Graph event bus: the SSE fan-out between the chat bridge and /api/events.
 *
 * The chat bridge translates the agent's cognitive activity (retrieve /
 * read_card / turn lifecycle) into SimEvent frames and broadcasts them per
 * conversation; /api/events subscribers (the frontend EventSource) receive
 * them so the ActivationEngine can animate the graph in real time.
 */
const subscribers = new Map(); // conversationId -> Set<ServerResponse>
const histories = new Map(); // conversationId -> SimEvent[]; short reconnect buffer only
const sequences = new Map(); // conversationId -> monotonic sequence
const HISTORY_LIMIT = 96;

/** Register an SSE response for one conversation. */
export function subscribeGraphEvents(conversationId, res, { after = null } = {}) {
	let set = subscribers.get(conversationId);
	if (set === void 0) {
		set = new Set();
		subscribers.set(conversationId, set);
	}
	set.add(res);
	if (Number.isFinite(after)) {
		for (const frame of histories.get(conversationId) ?? []) {
			if ((frame.seq ?? 0) > after) writeFrame(res, frame);
		}
	}
	return () => unsubscribeGraphEvents(conversationId, res);
}

/** Remove an SSE response for one conversation. */
export function unsubscribeGraphEvents(conversationId, res) {
	const set = subscribers.get(conversationId);
	if (set === void 0) return;
	set.delete(res);
	if (set.size === 0) subscribers.delete(conversationId);
}

/** Push one SimEvent to every subscriber of a conversation. */
export function broadcastGraphEvent(conversationId, event) {
	const seq = (sequences.get(conversationId) ?? 0) + 1;
	sequences.set(conversationId, seq);
	const frame = { type: event.type, ts: Date.now(), seq, payload: { ...(event.payload ?? {}), seq } };
	const history = histories.get(conversationId) ?? [];
	history.push(frame);
	if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
	histories.set(conversationId, history);
	const set = subscribers.get(conversationId);
	if (set === void 0 || set.size === 0) return;
	for (const res of [...set]) {
		if (res.writableEnded) {
			set.delete(res);
			continue;
		}
		writeFrame(res, frame);
	}
	if (set.size === 0) subscribers.delete(conversationId);
}

export function broadcastCognitiveEvent(conversationId, event) {
	broadcastGraphEvent(conversationId, { type: "cognitive.event", payload: event });
}

function writeFrame(res, frame) {
	res.write(`data: ${JSON.stringify(frame)}\n\n`);
}
