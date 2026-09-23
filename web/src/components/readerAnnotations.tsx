import { Children, cloneElement, isValidElement, type ReactNode } from 'react';
import type { ReaderAnchor } from '../api/client';

export function anchorPosition(body:string, anchor:ReaderAnchor):number|null {
  const positions:number[]=[];
  for(let p=body.indexOf(anchor.block);p!==-1;p=body.indexOf(anchor.block,p+1)) positions.push(p);
  if(positions.length===1)return positions[0];
  const matches=positions.filter(p=>(!anchor.before||body.slice(Math.max(0,p-anchor.before.length),p)===anchor.before)&&(!anchor.after||body.slice(p+anchor.block.length,p+anchor.block.length+anchor.after.length)===anchor.after));
  return matches.length===1?matches[0]:null;
}
export function nodeText(children:ReactNode):string {
  return Children.toArray(children).map(child=>typeof child==='string'||typeof child==='number'?String(child):isValidElement<{children?:ReactNode}>(child)?nodeText(child.props.children):'').join('');
}
export function highlighted(children:ReactNode, ranges:Array<{start:number;end:number}>):ReactNode {
  let cursor=0;
  const walk=(items:ReactNode):ReactNode=>Children.map(items,child=>{
    if(typeof child==='string'||typeof child==='number') {
      const text=String(child),offset=cursor;cursor+=text.length;
      const boundaries=[...new Set([0,text.length,...ranges.flatMap(r=>[Math.max(0,Math.min(text.length,r.start-offset)),Math.max(0,Math.min(text.length,r.end-offset))])])].sort((a,b)=>a-b);
      return boundaries.slice(0,-1).map((start,i)=>ranges.some(r=>r.start<offset+boundaries[i+1]&&r.end>offset+start)?<mark key={start}>{text.slice(start,boundaries[i+1])}</mark>:text.slice(start,boundaries[i+1]));
    }
    return isValidElement<{children?:ReactNode}>(child)?cloneElement(child,{},walk(child.props.children)):child;
  });
  return walk(children);
}
