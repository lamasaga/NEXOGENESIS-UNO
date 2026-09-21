/**
 * /api/inbox compatibility handler: multipart upload into 00-Inbox/.
 * Parses the multipart body by boundary, guards the filename against
 * path traversal, and saves each part under 00-Inbox/.
 */
import { constants as fsConstants, createReadStream, createWriteStream, lstatSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { copyFile, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { extname, join, resolve } from "node:path";
import Busboy from 'busboy';
import { listInbox } from "../../nexogenesis-tools/lib/cards.js";
import { currentInstanceRegistry } from "../../nexogenesis-tools/lib/instances/registry.js";
import { HttpError, json } from "./rpc.js";

export const MAX_INBOX_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_INBOX_BYTES = MAX_INBOX_FILE_BYTES + 2 * 1024 * 1024;
const MAX_INBOX_FILES = 2000;
const MAX_CONCURRENT_UPLOADS = 2;
const activeUploads = new Map();
const SAFE_NAME = /[\\/:*?"<>|\x00-\x1f]/g;

function materialType(path) {
	const extension = extname(path).toLowerCase();
	if (extension === ".pdf") return "pdf";
	if (extension === ".epub") return "epub";
	if ([".md", ".markdown", ".txt", ".text", ".html", ".htm", ".csv", ".json", ".yaml", ".yml"].includes(extension)) return "text";
	return "other";
}

/** GET /api/inbox → files that can be selected as one compile scope. */
export async function handleInboxList(_ctx, _req, res, _trustedHosts, projectRoot) {
	const documents = listInbox(projectRoot).flatMap(({ path }) => {
		try {
			const stat = statSync(join(projectRoot, "00-Inbox", path));
			return [{ path, doc_type: materialType(path), size: stat.size, modified_at: stat.mtimeMs }];
		} catch {
			return [];
		}
	}).sort((left, right) => right.modified_at - left.modified_at || left.path.localeCompare(right.path, "zh"));
	json(res, 200, { documents });
}

/** Parse a multipart/form-data body into { filename, content } parts. */
export function parseMultipart(body, contentType) {
	const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? "");
	if (!match) throw new HttpError(400, "缺少 multipart boundary");
	const boundaryText = (match[1] ?? match[2]).trim();
	if (boundaryText.length === 0 || boundaryText.length > 200 || /[\r\n\x00-\x1f]/.test(boundaryText)) {
		throw new HttpError(400, "multipart boundary 非法");
	}
	const boundary = Buffer.from(`--${boundaryText}`, "ascii");
	const separator = Buffer.from(`\r\n--${boundaryText}`, "ascii");
	const headerSeparator = Buffer.from("\r\n\r\n", "ascii");
	const source = Buffer.isBuffer(body) ? body : Buffer.from(body);
	const parts = [];
	let cursor = source.indexOf(boundary);
	if (cursor !== 0) throw new HttpError(400, "multipart 正文起始边界非法");
	while (cursor >= 0) {
		cursor += boundary.length;
		if (source.subarray(cursor, cursor + 2).equals(Buffer.from("--"))) break;
		if (!source.subarray(cursor, cursor + 2).equals(Buffer.from("\r\n"))) throw new HttpError(400, "multipart 边界格式非法");
		const headersStart = cursor + 2;
		const headerEnd = source.indexOf(headerSeparator, headersStart);
		if (headerEnd < 0) throw new HttpError(400, "multipart 文件头不完整");
		const headers = source.subarray(headersStart, headerEnd).toString("latin1");
		const contentStart = headerEnd + headerSeparator.length;
		const nextBoundary = source.indexOf(separator, contentStart);
		if (nextBoundary < 0) throw new HttpError(400, "multipart 结束边界缺失");
		const filenameMatch = /filename="([^"]*)"/i.exec(headers);
		if (!filenameMatch) { cursor = nextBoundary + 2; continue; }
		// Browsers send filename in UTF-8; the latin1 pass must be reversed.
		const filename = Buffer.from(filenameMatch[1], "latin1").toString("utf8");
		if (filename !== "") parts.push({ filename, content: source.subarray(contentStart, nextBoundary) });
		cursor = nextBoundary + 2;
	}
	return parts;
}

function safeFilename(filename) {
	let safe = filename.replace(SAFE_NAME, "_").trim().replace(/[. ]+$/g, "");
	const extension = extname(safe).slice(0, 20);
	if (safe.length > 180) safe = safe.slice(0, 180 - extension.length) + extension;
	if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) safe = `_${safe}`;
	if (safe === "" || safe === "." || safe === "..") throw new HttpError(400, "没有可保存的文件名");
	return safe;
}

async function fileDigest(path){
	const hash=createHash('sha256');
	for await(const chunk of createReadStream(path))hash.update(chunk);
	return hash.digest('hex');
}

async function receiveMultipart(req,contentType,dir,declared){
	const parts=[],writes=[];
	let received=0,files=0,limited=false;
	const counter=new Transform({transform(chunk,_encoding,callback){
		received+=chunk.length;
		if(received>MAX_INBOX_BYTES)return callback(new HttpError(413,'单次上传超过 258 MiB；单个文件最多 256 MiB'));
		callback(null,chunk);
	}});
	let parser;
	try{parser=Busboy({headers:{...req.headers,'content-type':contentType},defParamCharset:'utf8',limits:{fileSize:MAX_INBOX_FILE_BYTES,files:MAX_INBOX_FILES,parts:MAX_INBOX_FILES+8,headerPairs:100}});}
	catch(error){throw new HttpError(400,error.message);}
	parser.on('file',(_field,file,info)=>{
		files++;
		const part={index:parts.length,filename:info.filename??'',temp:join(dir,`.upload-${randomUUID()}.tmp`),size:0,digest:'',error:null};
		parts.push(part);
		const hash=createHash('sha256');
		file.on('data',chunk=>{part.size+=chunk.length;hash.update(chunk);});
		file.on('limit',()=>{part.error='单个文件超过 256 MiB，请拆分后导入';});
		writes.push(pipeline(file,createWriteStream(part.temp,{flags:'wx'})).then(()=>{part.digest=hash.digest('hex');}).catch(error=>{part.error??=error.message;}));
	});
	parser.on('filesLimit',()=>{limited=true;});
	parser.on('partsLimit',()=>{limited=true;});
	try{
		await pipeline(req,counter,parser);await Promise.all(writes);
		if(declared!==null&&received!==declared)throw new HttpError(400,'上传正文长度与 Content-Length 不一致');
		if(limited||files>MAX_INBOX_FILES)throw new HttpError(413,`单次最多上传 ${MAX_INBOX_FILES} 个文件`);
		if(!parts.length)throw new HttpError(400,'没有可保存的文件');
		return parts;
	}catch(error){
		await Promise.all(parts.map(part=>unlink(part.temp).catch(()=>{})));
		throw error;
	}
}

/** POST /api/inbox: independent file receipts; a failed file never rolls back its neighbours. */
export async function handleInboxUpload(ctx, req, res, _trustedHosts, projectRoot) {
	const expectedInstance = req.headers["x-nexogenesis-instance"];
	if (expectedInstance && expectedInstance !== currentInstanceRegistry(projectRoot).active_instance_id) {
		throw new HttpError(409, "当前知识库已变化，未导入本批文件；请切回原知识库后重试");
	}
	const contentType = req.headers["content-type"];
	if (typeof contentType !== "string" || !contentType.includes("multipart/form-data")) {
		throw new HttpError(415, "需要 multipart/form-data");
	}
	const declaredHeader=req.headers["content-length"];
	const declared=declaredHeader===undefined?null:Number(declaredHeader);
	if(declared!==null&&(!Number.isSafeInteger(declared)||declared<0))throw new HttpError(400,"Content-Length 非法");
	if(declared!==null&&declared>MAX_INBOX_BYTES)throw new HttpError(413,"单次上传超过 258 MiB；单个文件最多 256 MiB");
	const dir = join(projectRoot, "00-Inbox");
	mkdirSync(dir, { recursive: true });
	const key=resolve(projectRoot),count=activeUploads.get(key)??0;
	if(count>=MAX_CONCURRENT_UPLOADS)throw new HttpError(429,'当前知识库已有两批文件正在导入，请稍后重试');
	activeUploads.set(key,count+1);
	try{
		const parts=await receiveMultipart(req,contentType,dir,declared);
		const existing=new Map(readdirSync(dir).filter(name=>!name.startsWith('.upload-')).map(name=>[name.toLocaleLowerCase('zh-CN'),name]));
		const saved=[],items=[];
		for(const part of parts){
			try{
				if(part.error)throw new Error(part.error);
				const safe=safeFilename(part.filename),previous=existing.get(safe.toLocaleLowerCase('zh-CN'));
				if(previous){
					const previousPath=join(dir,previous),stat=lstatSync(previousPath);
					if(stat.isFile()&&!stat.isSymbolicLink()&&stat.size===part.size&&(await fileDigest(previousPath))===part.digest){items.push({index:part.index,name:part.filename,status:'existing',path:previous});continue;}
					throw new Error(`同名文件内容不同，未覆盖原文件：${previous}；请改名后导入`);
				}
				await copyFile(part.temp,join(dir,safe),fsConstants.COPYFILE_EXCL);
				existing.set(safe.toLocaleLowerCase('zh-CN'),safe);saved.push(safe);items.push({index:part.index,name:part.filename,status:'saved',path:safe});
			}catch(error){items.push({index:part.index,name:part.filename,status:'failed',detail:error?.code==='EEXIST'?'目标文件刚刚被占用，请重试核对':String(error?.message??error)});}
			finally{await unlink(part.temp).catch(()=>{});}
		}
		json(res,200,{saved,items});
	}finally{
		const next=(activeUploads.get(key)??1)-1;if(next>0)activeUploads.set(key,next);else activeUploads.delete(key);
	}
}

export { HttpError };
