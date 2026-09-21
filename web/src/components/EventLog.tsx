import type { SimEvent } from "../graph/types";

const DOT_COLORS: Record<string, string> = {
  "skill.trigger": "bg-sky-400",
  "retrieve.query": "bg-amber-300",
  "graph.hit": "bg-sky-400",
  "lens.begin": "bg-amber-400",
  "card.read": "bg-blue-400",
  "write.applied": "bg-fuchsia-400",
  "session.idle": "bg-zinc-600",
};

export function EventLog({ events }: { events: SimEvent[] }) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-6">
        {events.length === 0 && (
          <p className="text-zinc-600">等待事件…</p>
        )}
        {events.slice(-60).map((ev, i) => (
          <div key={i} className="flex items-baseline gap-2 text-zinc-400">
            <span className={`inline-block h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full ${DOT_COLORS[ev.type] ?? "bg-zinc-500"}`} />
            <span className="text-zinc-500">{ev.type}</span>
            <span className="truncate text-zinc-600">{summarize(ev)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function summarize(ev: SimEvent): string {
  const p = ev.payload as Record<string, unknown>;
  if (ev.type === "graph.hit") return `${p.role} · ${(p.node_ids as string[]).length} 节点`;
  if (ev.type === "lens.begin") return `${p.name}`;
  if (ev.type === "skill.trigger") return `${p.skill}`;
  if (ev.type === "retrieve.query") return `mode=${p.mode}`;
  if (ev.type === "card.read") return `${p.card_id}`;
  return "";
}
