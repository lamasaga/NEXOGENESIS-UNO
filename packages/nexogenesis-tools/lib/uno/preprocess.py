"""Read-only source preparation. JSON on stdin/stdout; no knowledge writes."""
import sys, json, re, hashlib, zipfile, base64, mimetypes, posixpath
from pathlib import Path
from collections import Counter
from html.parser import HTMLParser
from xml.etree import ElementTree
from urllib.parse import unquote, urlsplit

class VisibleHTML(HTMLParser):
    def __init__(self):
        super().__init__(); self.parts=[]; self.hidden=0
    def handle_starttag(self, tag, attrs):
        if tag in ('script','style'): self.hidden+=1
        if tag in ('p','br','div','h1','h2','h3','li'): self.parts.append('\n')
        if tag in ('h1','h2','h3') and not self.hidden: self.parts.append('#'*int(tag[1])+' ')
    def handle_endtag(self, tag):
        if tag in ('script','style'): self.hidden=max(0,self.hidden-1)
        if tag in ('p','div','h1','h2','h3','li'): self.parts.append('\n')
    def handle_data(self, data):
        if not self.hidden: self.parts.append(data)

class EpubHTML(VisibleHTML):
    """Read visible XHTML body only, while retaining a useful document title."""
    def __init__(self):
        super().__init__(); self.in_body=False; self.has_body=False; self.in_title=False; self.title_parts=[]; self.link_parts=None; self.body_images=[]; self.cover_marker=False
    def handle_starttag(self, tag, attrs):
        tag=tag.rsplit(':',1)[-1]
        attributes=dict(attrs)
        if tag=='meta' and attributes.get('name','').lower()=='calibre:cover' and attributes.get('content','').lower() in ('true','cover','yes','1'):
            self.cover_marker=True
        if tag=='body': self.in_body=True; self.has_body=True
        if tag=='title': self.in_title=True
        if self.in_body and tag in ('img','image'):
            reference=attributes.get('src') or attributes.get('href') or attributes.get('xlink:href')
            if reference: self.body_images.append(reference)
        if self.in_body and tag=='a' and '#' in attributes.get('href',''):
            self.link_parts=[]
        if self.in_body: super().handle_starttag(tag,attrs)
    def handle_endtag(self, tag):
        tag=tag.rsplit(':',1)[-1]
        if tag=='a' and self.link_parts is not None:
            self.parts.append('\ue000'+re.sub(r'\s+',' ',''.join(self.link_parts)).strip()+'\ue001')
            self.link_parts=None
        if self.in_body: super().handle_endtag(tag)
        if tag=='body': self.in_body=False
        if tag=='title': self.in_title=False
    def handle_data(self, data):
        if self.in_title: self.title_parts.append(data)
        if self.in_body:
            if self.link_parts is not None: self.link_parts.append(data)
            else: super().handle_data(data)

def remove_epub_navigation(text, changes):
    """Only remove contiguous internal-link TOCs, never repeated prose or footnotes."""
    lines=text.splitlines(); run=[]
    def flush():
        labels=[re.fullmatch(r'\s*\ue000([^\ue001]+)\ue001\s*',lines[i]) for i in run]
        labels=[m[1] for m in labels if m]
        if len(labels)>=6 and sum(bool(CHAPTER.match(label)) for label in labels)>=3:
            linked=[i for i in run if '\ue000' in lines[i]]
            for i in run:
                if linked[0]<=i<=linked[-1]: lines[i]=''
            changes['移除重复导航目录行']+=len(labels)
        run.clear()
    for i,line in enumerate(lines):
        if not line.strip() or re.fullmatch(r'\s*\ue000[^\ue001]+\ue001\s*',line) or (len(line.strip())<160 and CHAPTER.match(line.strip())): run.append(i)
        else: flush()
    flush()
    return '\n'.join(lines).replace('\ue000','').replace('\ue001','')

def epub_member(base, href):
    """Resolve a package URI inside the ZIP, never a network or host path."""
    uri=urlsplit(href)
    if uri.scheme or uri.netloc: raise ValueError('EPUB 资源不是内部路径')
    path=unquote(uri.path)
    if not path or '\\' in path or '\x00' in path or path.startswith('/'): raise ValueError('EPUB 资源路径无效')
    normalized=posixpath.normpath(posixpath.join(base,path))
    if normalized in ('.','..') or normalized.startswith('../'): raise ValueError('EPUB 资源路径越界')
    return normalized

CHAPTER=re.compile(r'^(?:#{1,2}\s+\S|第[零一二三四五六七八九十百千\d]+[章节篇部]\s*\S*|Chapter\s+\d+\b)',re.I)
PAGE=re.compile(r'^\s*(?:第\s*\d+\s*页(?:\s*[共/].*页)?|[-—]\s*\d+\s*[-—])\s*$')
# Explicit source locators in Markdown exports; ordinary comments are content.
SOURCE_PAGE=re.compile(r'^<!--\s*(?:PDF\s*)?物理页\s*(\d+)(?:\s*[;；]\s*书页\s*(\d+))?\s*-->$')

def prepare(path, modern=False, root=None, material_kind=None, unit_char_limit=60000):
    unit_char_limit=int(unit_char_limit)
    if unit_char_limit < 12000 or unit_char_limit > 90000: raise ValueError('原文单元字符上限须为 12000–90000')
    path=Path(path)
    if path.stat().st_size>50*1024*1024: raise ValueError('单文件超过 50 MiB')
    raw=path.read_bytes()
    warnings=[]; changes=Counter(); pages=[]; toc=[]; assets=[]; asset_size=0; image_hashes=set(); external_images=[]; source_metadata=''; incomplete=False; epub_documents={}; book_title=''
    def asset(data,name,locator,caption=''):
        nonlocal asset_size
        digest=hashlib.sha256(data).hexdigest()
        if digest in image_hashes:
            for a in assets:
                if hashlib.sha256(base64.b64decode(a['data'])).hexdigest()==digest: a['locator']+='；'+locator
            return
        if len(data)>20*1024*1024 or asset_size+len(data)>20*1024*1024 or len(assets)>=64:
            warnings.append('部分图片未单独提取，可从保全的原件查看。'); return
        image_hashes.add(digest); asset_size+=len(data)
        assets.append({'data':base64.b64encode(data).decode('ascii'),'name':name,'mime':mimetypes.guess_type(name)[0] or 'application/octet-stream','locator':locator,'caption':caption})
    suffix=path.suffix.lower()
    if suffix=='.pdf':
        import fitz
        with fitz.open(path) as doc:
            toc=[(title,max(1,p)) for level,title,p in doc.get_toc() if level==1]
            for i,page in enumerate(doc):
                text=page.get_text()
                pages.append((i+1,text))
                if not text.strip(): warnings.append(f'物理页 {i+1} 无可提取文字，需检查扫描图像。')
                if modern:
                    for image in page.get_images(full=True):
                        try:
                            value=doc.extract_image(image[0]); asset(value['image'],f"image-{image[0]}.{value['ext']}",f'物理页 {i+1}')
                        except Exception: warnings.append(f'物理页 {i+1} 图片提取失败，可查看 PDF 原件。')
        warnings.append('PDF 图像、OCR 与复杂表格未自动核验；保留原件。')
    elif suffix=='.epub':
        with zipfile.ZipFile(path) as z:
            infos=z.infolist()
            if len(infos)>20000 or sum(i.file_size for i in infos)>200*1024*1024: raise ValueError('EPUB 解压清单过大')
            names=[i.filename for i in infos]
            if len(set(names))!=len(names): raise ValueError('EPUB 包含重复 ZIP 路径')
            def read_member(name, maximum=30*1024*1024):
                info=z.getinfo(name)
                if info.file_size>maximum: raise ValueError('EPUB 资源解压后过大：'+name)
                return z.read(info)
            container=ElementTree.fromstring(read_member('META-INF/container.xml',1024*1024))
            rootfile=next((node for node in container.iter() if node.tag.rsplit('}',1)[-1]=='rootfile' and node.get('full-path')),None)
            if rootfile is None: raise ValueError('EPUB container 缺少 package 路径')
            package_path=epub_member('',rootfile.get('full-path'))
            package=ElementTree.fromstring(read_member(package_path,4*1024*1024))
            package_base=posixpath.dirname(package_path)
            manifest_items=[node for node in package.iter() if node.tag.rsplit('}',1)[-1]=='item' and node.get('id')]
            manifest={node.get('id'):node for node in manifest_items}
            if len(manifest)!=len(manifest_items): raise ValueError('EPUB manifest 含重复 ID')
            spine=[node for node in package.iter() if node.tag.rsplit('}',1)[-1]=='itemref']
            if not spine or len(spine)>10000: raise ValueError('EPUB 缺少有效 spine 或章节过多')
            book_title=next((''.join(node.itertext()).strip() for node in package.iter() if node.tag.rsplit('}',1)[-1]=='title'),'')
            authors=[''.join(node.itertext()).strip() for node in package.iter() if node.tag.rsplit('}',1)[-1]=='creator']
            source_metadata=json.dumps({'title':book_title,'authors':authors,'package':package_path},ensure_ascii=False)
            total_chars=0
            for order,itemref in enumerate(spine,1):
                ident=itemref.get('idref',''); item=manifest.get(ident)
                try:
                    if item is None: raise ValueError('manifest 中没有 '+ident)
                    if item.get('media-type') not in ('application/xhtml+xml','text/html','application/xml','text/xml'):
                        raise ValueError('正文类型不支持：'+str(item.get('media-type')))
                    member=epub_member(package_base,item.get('href',''))
                    encoded=read_member(member)
                    declaration=re.match(br'\s*<\?xml[^>]*encoding=[\"\x27]([^\"\x27]+)',encoded)
                    encoding='utf-16' if encoded.startswith((b'\xff\xfe',b'\xfe\xff')) else declaration[1].decode('ascii') if declaration else 'utf-8-sig'
                    html=encoded.decode(encoding)
                    parser=EpubHTML(); parser.feed(html); parser.close()
                    if not parser.has_body:
                        fallback=VisibleHTML(); fallback.feed(html); fallback.close(); parser.parts=fallback.parts
                    text=''.join(parser.parts)
                    if not text.strip():
                        title=''.join(parser.title_parts).strip()
                        cover_named=parser.cover_marker or any(re.search(r'(?:^|[-_])(cover|titlepage|coverpage)(?:$|[-_.])',value,re.I)
                            for value in (ident,posixpath.basename(member),title))
                        image_members=[]
                        for reference in parser.body_images:
                            try: image_members.append(epub_member(posixpath.dirname(member),reference))
                            except ValueError: pass
                        if cover_named and image_members and all(image in names for image in image_members):
                            warnings.append(f'EPUB spine {order} ({ident}) 是仅含图像的封面页；图像已在原件中保留，不计作正文缺口。')
                            changes['识别仅含图像的封面页']+=1
                            continue
                        raise ValueError('无可提取正文')
                    total_chars+=len(text)
                    if total_chars>5_000_000: raise ValueError('EPUB 提取正文超过 500 万字符')
                    title=''.join(parser.title_parts).strip() or next((line.strip() for line in text.splitlines() if line.strip()),ident)
                    pages.append((order,text)); toc.append((title,order)); epub_documents[order]=member
                except (KeyError,ValueError,LookupError,UnicodeError,ElementTree.ParseError) as error:
                    incomplete=True; warnings.append(f'EPUB spine {order} ({ident}) 未能提取：{error}')
            if modern:
                for item in manifest.values():
                    if not item.get('media-type','').startswith('image/'): continue
                    try:
                        member=epub_member(package_base,item.get('href','')); asset(read_member(member,20*1024*1024),posixpath.basename(member),'EPUB '+member)
                    except (KeyError,ValueError) as error: warnings.append('EPUB 图片未单独提取：'+str(error))
            changes['按 EPUB spine 顺序保留正文（含 linear=no 附属材料）']=1
            warnings.append('EPUB 图像与公式版式未自动核验；保留原件和可提取图片。')
    elif suffix=='.docx':
        with zipfile.ZipFile(path) as z:
            member=z.getinfo('word/document.xml')
            if member.file_size>30*1024*1024: raise ValueError('DOCX 正文解压后超过 30 MiB')
            tree=ElementTree.fromstring(z.read(member))
            if modern:
                for info in z.infolist():
                    if info.filename.startswith('word/media/') and info.file_size<=20*1024*1024:
                        asset(z.read(info),Path(info.filename).name,info.filename)
        ns='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
        paragraphs=[]
        for p in tree.iter(ns+'p'):
            content=''.join(t.text or '' for t in p.iter(ns+'t'))
            style=p.find(ns+'pPr/'+ns+'pStyle')
            name=style.get(ns+'val','') if style is not None else ''
            heading=re.fullmatch(r'(?:heading|标题)\s*([1-3])',name,re.I)
            paragraphs.append(('#'*int(heading[1])+' ' if heading else '')+content)
        text='\n\n'.join(paragraphs)
        pages=[(0,text)]; warnings.append('DOCX 当前提取正文，图片及表格版式需回查原件。')
    else:
        text=raw.decode('utf-8-sig')
        if modern and suffix in ('.md','.markdown'):
            header=re.match(r'\A---\r?\n([\s\S]{1,32000}?)\r?\n---(?:\r?\n|$)',text)
            if header and re.search(r'(?m)^(?:title|author|account|date|url|digest|source):',header[1]):
                source_metadata=header[1]
                # Preserve original line locations and all metadata in the source catalog.
                text='\n'*header[0].count('\n')+text[header.end():]
                changes['来源元数据独立保全，不生成消化单元']=1
        if modern and suffix in ('.md','.markdown','.html','.htm'):
            matches=re.findall(r'!\[([^\]]*)\]\(([^)]+)\)',text) if suffix in ('.md','.markdown') else [('',s) for s in re.findall(r'<img[^>]+src=[\"\x27]([^\"\x27]+)',text,re.I)]
            for caption,url in matches:
                if re.match(r'https?://',url):
                    external_images.append({'url':url,'caption':caption}); continue
                if re.match(r'\w+:',url): continue
                candidate=(path.parent/url.split(' ')[0]).resolve()
                boundary=Path(root).resolve() if root else path.parent.resolve()
                if not candidate.is_relative_to(boundary):
                    warnings.append('图片路径超出目标知识库，未读取。'); continue
                if candidate.is_file() and candidate.stat().st_size<=20*1024*1024:
                    asset(candidate.read_bytes(),candidate.name,'引用位置：'+url,caption)
                else: warnings.append('本地图片缺失或超限：'+url)
        if suffix in ('.html','.htm'):
            parser=VisibleHTML(); parser.feed(text); text=''.join(parser.parts); changes['移除 HTML 标记及脚本样式']=1
        elif suffix not in ('.md','.txt','.markdown','.csv','.log',''):
            raise ValueError('当前预处理不支持此格式，请先转换为 Markdown、文本、HTML、DOCX、EPUB 或 PDF')
        pages=[(0,text)]
    if suffix=='.epub': pages=[(n,remove_epub_navigation(t,changes)) for n,t in pages]
    if sum(len(t) for _,t in pages)>5_000_000: raise ValueError('提取文本超过 500 万 Unicode 字符')
    # Only exact lines at page edges are candidates, never repeated arguments in body.
    edges=Counter()
    if len(pages)>=3:
        for _,t in pages:
            lines=[s.strip() for s in t.splitlines() if s.strip()]
            edges.update(set(s for s in lines[:2]+lines[-2:] if len(s)<=100))
    if material_kind not in (None, 'auto', 'book', 'article'): raise ValueError('材料类型无效')
    total_text=sum(len(t) for _,t in pages)
    material_kind=material_kind if material_kind in ('book','article') else ('book' if suffix=='.epub' or suffix=='.pdf' and (len(pages)>30 or len(toc)>=3) or total_text>120000 else 'article')
    book=material_kind=='book'
    def is_heading(line):
        # Printed contents entries are evidence, not chapter boundaries. Keep
        # their full text but do not rename/split the preface under a TOC row.
        if book and re.search(r'(?:\.{3,}|…+|．{3,}|·{3,})\s*\d+(?:\s*[-–—]\s*\d+)?\s*$', line):
            return False
        return len(line)<160 and (bool(CHAPTER.match(line)) or (book and re.sub(r'\s+','',line) in ('后记','出版后记','前言','序言','自序','导论')))
    repeated={s for s,n in edges.items() if n>=3 and n>=len(pages)*0.6 and not is_heading(s)}
    # A declared source title may be a running header after an explicit locator.
    # Frequency alone cannot distinguish a header from a repeated qualification.
    page_headers=set()
    if book:
        for value in re.findall(r'(?m)^(?:title|source_work):\s*([^\n]+)',source_metadata):
            value=value.strip()
            if value.startswith('"'):
                try: value=json.loads(value)
                except ValueError: continue
            elif len(value)>=2 and value.startswith("'") and value.endswith("'"):
                value=value[1:-1].replace("''", "'")
            if isinstance(value,str) and value.strip(): page_headers.add(value.strip())
        for _,text in pages:
            heading=re.search(r'(?m)^#\s+([^\n]+)',text)
            if heading: page_headers.add(heading[1].strip()); break
    page_headers={s for s in page_headers if not s.isdecimal() and not is_heading(s)}
    chunks=[]; buf=[]; buf_chars=0; has_content=False; title=path.stem; start=None; end=None
    page_prefix=[]; page_numbers=set()
    def flush():
        nonlocal buf,start,end,buf_chars,has_content
        body='\n'.join(buf).strip()
        if body:
            locator=f'原始物理页 {start}–{end}' if suffix=='.pdf' else f'提取文本行 {start}–{end}'
            if suffix=='.epub': locator=f'EPUB spine {start}；{epub_documents.get(start,"")}'
            chunk={'title':title,'text':body,'locator':locator}
            if suffix=='.epub': chunk.update(spine_index=start,href=epub_documents.get(start,''))
            chunks.append(chunk)
        buf=[]; buf_chars=0; has_content=False; start=None; end=None
    def append_line(line,location,structural=False):
        nonlocal start,end,buf_chars,has_content
        if start is None: start=location
        end=location
        # Join a PDF broken English word only, retaining citations and numeric content.
        if suffix=='.pdf' and buf and re.search(r'[a-z]-$',buf[-1]) and re.match(r'^[a-z]',line):
            buf[-1]=buf[-1][:-1]+line; changes['修复 PDF 英文断词']+=1
        elif not line.strip() and buf and not buf[-1].strip():
            changes['合并连续空行']+=1
        else: buf.append(line)
        buf_chars+=len(line)
        if line.strip() and not structural: has_content=True
    def append_page_prefix():
        for line,location in page_prefix: append_line(line,location,structural=True)
        page_prefix.clear()
    toc_map={p:t for t,p in toc}
    has_headings=bool(toc) or any(is_heading(line.strip()) for _,text in pages for line in text.splitlines())
    line_number=0
    for page_num,text in pages:
        if page_num in toc_map:
            flush(); title=toc_map[page_num]
        lines=text.replace('\r\n','\n').replace('\r','\n').split('\n')
        nonempty=[i for i,s in enumerate(lines) if s.strip()]
        edge_indices=set(nonempty[:2]+nonempty[-2:])
        for i,line in enumerate(lines):
            line_number+=1; location=page_num or line_number
            cleaned=re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\u200b\ufeff]','',line)
            if cleaned!=line: changes['清理控制及零宽字符']+=1
            line=cleaned.rstrip()
            if suffix=='.pdf' and (PAGE.match(line) or (i in edge_indices and line.strip() in repeated)):
                changes['移除重复页眉页脚或页码行']+=1; continue
            stripped=line.strip()
            marker=SOURCE_PAGE.fullmatch(stripped) if book else None
            if marker:
                page_prefix.append((line,location)); page_numbers={n for n in marker.groups() if n}
                continue
            if page_prefix and (not stripped or stripped in page_numbers or stripped in page_headers):
                page_prefix.append((line,location)); continue
            heading=(not toc or suffix=='.epub') and is_heading(stripped)
            if heading:
                # A document H1 followed by a printed chapter heading is one unit.
                # Substantive short chapters still split, regardless of their length.
                if not book or has_content: flush()
                elif any(s.strip() for s in buf): changes['保留连续标题于正文单元']=1
                title=re.sub(r'^#+\s*','',stripped)
            append_page_prefix()
            append_line(line,location,structural=bool(heading))
            if not has_headings and buf_chars>=int(unit_char_limit*11/12) and not line.strip():
                flush(); title=path.stem+f' · 段落组 {len(chunks)+1}'
    append_page_prefix()
    flush()
    if not chunks: raise ValueError('没有可靠可读的文本')
    # A short article's headings are internal structure, not separate work items.
    if modern and not book and sum(len(c['text']) for c in chunks)<=unit_char_limit and len(chunks)>1:
        chunks=[{'title':path.stem,'text':'\n\n'.join(c['text'] for c in chunks),'locator':chunks[0]['locator']+'；至 '+chunks[-1]['locator']}]
        changes['短文保留为完整工作单元']=1
    # Stable Markdown units, even for giant paragraphs or heading-free articles.
    bounded=[]
    for chunk in chunks:
        text=chunk['text']; start=0; part=0
        while start<len(text):
            end=min(start+unit_char_limit,len(text))
            if end<len(text):
                boundary=text.rfind('\n\n', start+unit_char_limit//2, end)
                if boundary>=0: end=boundary+2
            part+=1
            bounded.append({**chunk,'text':text[start:end], 'continuation':{'from_previous':start>0,'to_next':end<len(text)}, 'original_start':start,'original_end':end})
            start=end
    chunks=bounded
    result={'fingerprint':hashlib.sha256(raw).hexdigest(),'format':suffix.lstrip('.'),'chapters':chunks,'warnings':warnings,'changes':dict(changes),'source_metadata':source_metadata,'segmentation':'章节' if has_headings else '无可靠目录，按段落/文本整理'}
    if book_title: result['title']=book_title
    if modern:
        result.update(assets=assets,external_images=external_images,material_kind=material_kind or ('book' if suffix=='.epub' or has_headings and len(chunks)>2 else 'article'),incomplete=incomplete or any('无可提取文字' in w for w in warnings))
    return result

if __name__=='__main__':
    try:
        req=json.loads(sys.stdin.buffer.read().decode('utf-8'))
        sys.stdout.buffer.write(json.dumps(prepare(req['path'],req.get('modern',False),req.get('root'),req.get('material_kind'),req.get('unit_char_limit',60000)),ensure_ascii=False).encode('utf-8'))
    except Exception as e:
        sys.stderr.buffer.write(str(e).encode('utf-8')); sys.exit(1)
