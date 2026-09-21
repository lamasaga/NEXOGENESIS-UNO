const finitePositive = value => Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;

/** New jobs freeze these values; historical jobs retain their original constants. */
export function workflowCharLimit(job, key, fallback) {
  return finitePositive(job?.workflow_limits?.[key]) ?? fallback;
}

export function workflowOutputLimit(job, phase, fallback) {
  return finitePositive(job?.workflow_limits?.output_tokens?.[phase]) ?? fallback;
}

/** provider-default means that the adapter must omit the reasoning selector. */
export function workflowReasoning(job, phase, fallback) {
  const configured = job?.workflow_reasoning && Object.hasOwn(job.workflow_reasoning, phase)
    ? job.workflow_reasoning[phase] : fallback;
  return configured === 'provider-default' ? undefined : configured;
}
