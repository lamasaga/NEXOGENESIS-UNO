/** Read-only projection of saved selection records. No legacy task can execute here. */
export function selectionSummary(job){
 if(job.orchestration_profile==='bounded-workflow-v1'){
  const refs=(job.selected_sources??[]).flatMap(source=>['exclude','restored'].includes(job.selection?.[source]?.status)?[source]:job.chapter_catalogs?.[source]?.items.map(item=>item.ref)??[source]);
  const counts={total:refs.length,unseen:0,digest:0,exclude:0,defer:0,admitted:0,restored:0};
  for(const ref of refs)counts[job.selection?.[ref]?.status??'unseen']++;
  return {...counts,scope:'chapters',source_total:job.selected_sources?.length??0,unselected:counts.unseen+counts.digest+counts.defer+counts.restored};
 }
 const counts={total:job.selected_sources?.length??0,unseen:0,digest:0,exclude:0,defer:0,admitted:0,restored:0};
 for(const ref of job.selected_sources??[])counts[job.selection?.[ref]?.status??'unseen']++;
 return counts;
}
