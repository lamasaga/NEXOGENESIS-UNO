import { useEffect, useMemo, useRef, useState } from "react";
import { normalizeForce, type Positions } from "../../../packages/nexogenesis-tools/lib/graph-simulation.js";
import type { GraphData } from "./types";
import { DEFAULT_FORCES, forceStorageKey, isDefaultForces, loadForceSettings, type GraphForces } from "./forceSettings";
import { graphFingerprint, loadGraphLayout, sameForces, saveGraphLayout, type SavedGraphLayout } from "./layoutStorage";

export function useGraphForces(source: GraphData, viewKey: string) {
  const [forces, setForces] = useState(() => {
    try { return loadForceSettings(localStorage, viewKey); }
    catch { return { ...DEFAULT_FORCES }; }
  });
  const [saved] = useState(() => {
    try { return loadGraphLayout(localStorage, viewKey); } catch { return null; }
  });
  const latest = useRef<SavedGraphLayout | null>(saved);
  const [positions, setPositions] = useState<Positions>(saved?.positions ?? {});
  const positionsRef = useRef(positions);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const fingerprint = useMemo(() => graphFingerprint(source), [source]);
  const [status, setStatus] = useState<"ready" | "adjusting" | "error">("ready");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const graph = sourceRef.current;
    const existing = latest.current;
    if (existing?.settled && existing.fingerprint === fingerprint && sameForces(existing.forces, forces)
      && graph.nodes.every(node => existing.positions[node.id])) {
      setStatus("ready");
      return;
    }
    // Seed from what the user is seeing, including surviving nodes after graph changes.
    const seed = Object.fromEntries(graph.nodes.map(node => [node.id, positionsRef.current[node.id] ?? { x: node.x, y: node.y }]));
    latest.current = { fingerprint, forces, positions: seed, settled: false };
    if ((!existing && isDefaultForces(forces)) || !graph.nodes.length) {
      latest.current.settled = true;
      positionsRef.current = seed;
      setPositions(seed);
      saveGraphLayout(viewKey, latest.current);
      setStatus("ready");
      return;
    }
    let worker: Worker | undefined;
    let cancelled = false;
    let lastSave = performance.now();
    setStatus("adjusting");
    const timer = window.setTimeout(() => {
      try {
        worker = new Worker(new URL("./forces.worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (event: MessageEvent<{ positions: Positions; done: boolean }>) => {
          if (cancelled) return;
          const { positions: next, done } = event.data;
          positionsRef.current = next;
          latest.current = { fingerprint, forces, positions: next, settled: done };
          setPositions(next);
          if (done || performance.now() - lastSave >= 750) {
            saveGraphLayout(viewKey, latest.current);
            lastSave = performance.now();
          }
          if (done) { setStatus("ready"); worker?.terminate(); }
        };
        const fail = () => { if (!cancelled) setStatus("error"); worker?.terminate(); };
        worker.onerror = fail;
        worker.onmessageerror = fail;
        worker.postMessage({ data: { ...graph, nodes: graph.nodes.map(node => ({ ...node, ...seed[node.id] })) }, forces });
      } catch { if (!cancelled) setStatus("error"); worker?.terminate(); }
    }, 60);
    return () => { cancelled = true; clearTimeout(timer); worker?.terminate(); };
  }, [fingerprint, forces, attempt, viewKey]);

  useEffect(() => {
    const flush = () => { if (latest.current) saveGraphLayout(viewKey, latest.current); };
    const onVisibility = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => { flush(); window.removeEventListener("pagehide", flush); document.removeEventListener("visibilitychange", onVisibility); };
  }, [viewKey]);

  const data = useMemo(() => ({ ...source, nodes: source.nodes.map(node => ({ ...node, ...positions[node.id] })) }), [source, positions]);
  useEffect(() => {
    try { localStorage.setItem(forceStorageKey(viewKey), JSON.stringify(forces)); } catch { /* usable without storage */ }
  }, [forces, viewKey]);
  const changeForce = (key: keyof GraphForces, value: number) => {
    setForces(current => ({ ...current, [key]: Math.round(normalizeForce(value) * 10) / 10 }));
  };
  return { data, forces, changeForce, resetForces: () => setForces({ ...DEFAULT_FORCES }), status, retry: () => setAttempt(value => value + 1) };
}
