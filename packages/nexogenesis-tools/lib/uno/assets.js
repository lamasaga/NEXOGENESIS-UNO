import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import { isIP } from 'node:net';
import { sha } from '../harness/uno-storage.js';

export function publicAddress(address){
  if(isIP(address)===4){const [a,b]=address.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===100&&b>=64&&b<=127)||(a===198&&(b===18||b===19)));}
  // Global unicast only; exclude mapped IPv4 and documentation space.
  return isIP(address)===6&&/^[23]/i.test(address)&&!address.toLowerCase().startsWith('2001:db8:');
}
export async function downloadImage(url,signal){
  const deadline=Date.now()+15000;
  async function read(value,redirects=0){
    const target=new URL(value);if(!['http:','https:'].includes(target.protocol)||target.username||target.password||redirects>3)throw Error('图片地址无效');
    const hostname=target.hostname.replace(/^\[|\]$/g,'');if(isIP(hostname)&&!publicAddress(hostname))throw Error('图片地址不是公开网络地址');
    return new Promise((resolve,reject)=>{
      const request=(target.protocol==='https:'?https:http).get(target,{signal,lookup:(host,options,callback)=>dns.lookup(host,{all:true},(error,addresses)=>{
        if(error)return callback(error);if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))return callback(Error('图片地址不是公开网络地址'));
        options.all?callback(null,addresses):callback(null,addresses[0].address,addresses[0].family);
      }),headers:{'User-Agent':'UNO-Archive/3','Accept':'image/*'}},response=>{
        if([301,302,303,307,308].includes(response.statusCode)&&response.headers.location){response.destroy();clearTimeout(timer);read(new URL(response.headers.location,target).href,redirects+1).then(resolve,reject);return;}
        const mime=String(response.headers['content-type']??'').split(';')[0];const extension={'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp'}[mime];
        if(response.statusCode!==200||!extension){response.destroy();reject(Error('未返回可归档的位图'));return;}
        let size=0;const chunks=[];response.on('data',bytes=>{size+=bytes.length;if(size>20*1024*1024)request.destroy(Error('单图超过20MiB'));else chunks.push(bytes);});
        response.on('error',reject);response.on('end',()=>{clearTimeout(timer);const bytes=Buffer.concat(chunks);resolve({data:bytes.toString('base64'),name:sha(bytes)+'.'+extension,mime,locator:target.href});});
      });
      const timer=setTimeout(()=>request.destroy(Error('图片下载超过15秒')),Math.max(1,deadline-Date.now()));request.on('error',error=>{clearTimeout(timer);reject(error);});request.on('close',()=>clearTimeout(timer));
    });
  }return read(url);
}
export async function archiveExternalImages(prepared,enabled,signal){
  if(!enabled)return prepared;
  const pending=[...(prepared.external_images??[])].slice(0,64);let cursor=0,totalBytes=0;
  await Promise.all([0,1].map(async()=>{while(cursor<pending.length){const entry=pending[cursor++];signal?.throwIfAborted();try{const image=await downloadImage(entry.url,signal);const bytes=Buffer.byteLength(image.data,'base64');if(totalBytes+bytes>64*1024*1024){prepared.warnings.push('外链图片累计超过64MiB，剩余保留外链');cursor=pending.length;}else{totalBytes+=bytes;prepared.assets.push({...image,caption:entry.caption});}}catch(e){if(signal?.aborted)throw e;prepared.warnings.push('图片保留外链：'+entry.url+' · '+e.message);}}}));
  return prepared;
}
