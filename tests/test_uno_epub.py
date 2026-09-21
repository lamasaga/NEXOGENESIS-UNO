"""Deterministic EPUB fixtures only; no model or network calls."""
import importlib.util
import tempfile
import unittest
import zipfile
from pathlib import Path

MODULE = Path(__file__).resolve().parents[1] / 'packages/nexogenesis-tools/lib/uno/preprocess.py'
SPEC = importlib.util.spec_from_file_location('uno_book_preprocess', MODULE)
PREPROCESS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREPROCESS)


class EpubTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='uno-epub-test-')
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'synthetic.epub'

    def write_book(self, manifest, spine, files):
        items = ''.join(f'<item id="{ident}" href="{href}" media-type="{kind}"/>' for ident, href, kind in manifest)
        refs = ''.join(f'<itemref idref="{ident}" linear="{linear}"/>' for ident, linear in spine)
        package = f'''<?xml version="1.0" encoding="utf-8"?>
          <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
            <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>测试书</dc:title><dc:creator>作者甲</dc:creator></metadata>
            <manifest>{items}</manifest><spine>{refs}</spine></package>'''
        with zipfile.ZipFile(self.path, 'w') as archive:
            archive.writestr('mimetype', 'application/epub+zip')
            for name, value in files.items():
                archive.writestr(name, value)
            archive.writestr('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
            archive.writestr('OPS/package.opf', package)

    @staticmethod
    def document(title, body):
        return f'<html xmlns="http://www.w3.org/1999/xhtml"><head><title>{title}</title><style>HIDDEN_CSS</style></head><body>{body}</body></html>'

    def prepare(self):
        return PREPROCESS.prepare(self.path, modern=True, root=Path(self.temp.name), material_kind='book')

    def test_spine_order_and_body_preserved(self):
        self.write_book([('b', 'b.xhtml', 'application/xhtml+xml'), ('a', 'a.xhtml', 'application/xhtml+xml')], [('a', 'yes'), ('b', 'yes')], {
            'OPS/b.xhtml': self.document('第二章', '<h1>第二章</h1><p>后文限定：仅在抵押融资存在时成立。</p>'),
            'OPS/a.xhtml': self.document('第一章', '<h1>第一章</h1><p>反馈机制 &amp; 证据😀。</p><script>HIDDEN_SCRIPT</script>')})
        result = self.prepare()
        self.assertEqual([c['title'] for c in result['chapters']], ['第一章', '第二章'])
        self.assertEqual([c['href'] for c in result['chapters']], ['OPS/a.xhtml', 'OPS/b.xhtml'])
        self.assertIn('反馈机制 & 证据😀。', result['chapters'][0]['text'])
        self.assertNotIn('HIDDEN', ''.join(c['text'] for c in result['chapters']))
        self.assertFalse(result['incomplete'])
        self.assertEqual(result['title'], '测试书')
        self.assertIn('作者甲', result['source_metadata'])

    def test_missing_spine_item_and_file_set_real_incomplete(self):
        self.write_book([('good', 'good.xhtml', 'application/xhtml+xml'), ('lost', 'lost.xhtml', 'application/xhtml+xml')], [('good', 'yes'), ('unknown', 'yes'), ('lost', 'yes')], {'OPS/good.xhtml': self.document('保留章节', '<p>完整保留此处内容。</p>')})
        result = self.prepare()
        self.assertTrue(result['incomplete'])
        self.assertEqual(len(result['chapters']), 1)
        self.assertTrue(any('spine 2' in warning and 'unknown' in warning for warning in result['warnings']))
        self.assertTrue(any('spine 3' in warning and 'lost' in warning for warning in result['warnings']))

    def test_percent_encoded_paths_auxiliary_spine_and_images(self):
        self.write_book([('main', 'Text/chapter%201.xhtml', 'application/xhtml+xml'), ('notes', 'Text/notes.xhtml', 'application/xhtml+xml'), ('image', 'Images/chart.png', 'image/png')], [('main', 'yes'), ('notes', 'no')], {
            'OPS/Text/chapter 1.xhtml': self.document('正文', '<p>正文解释。</p>'),
            'OPS/Text/notes.xhtml': self.document('注释', '<p>不能省略的成立条件。</p>'), 'OPS/Images/chart.png': b'synthetic-png'})
        result = self.prepare()
        self.assertEqual(len(result['chapters']), 2)
        self.assertIn('不能省略', result['chapters'][1]['text'])
        self.assertEqual(len(result['assets']), 1)
        self.assertEqual(result['assets'][0]['locator'], 'EPUB OPS/Images/chart.png')
        self.assertFalse(result['incomplete'])

    def test_unsafe_spine_uri_is_deferred_without_host_or_network_read(self):
        self.write_book([('good', 'good.xhtml', 'application/xhtml+xml'), ('escape', '../../outside.xhtml', 'application/xhtml+xml'), ('remote', 'https://example.invalid/chapter', 'application/xhtml+xml')], [('good', 'yes'), ('escape', 'yes'), ('remote', 'yes')], {'OPS/good.xhtml': self.document('正文', '<p>仅保留包内正文。</p>')})
        result = self.prepare()
        self.assertTrue(result['incomplete'])
        self.assertEqual(len(result['chapters']), 1)
        self.assertTrue(any('路径越界' in warning for warning in result['warnings']))
        self.assertTrue(any('不是内部路径' in warning for warning in result['warnings']))

    def test_empty_spine_body_is_not_silently_counted_complete(self):
        self.write_book([('good', 'good.xhtml', 'application/xhtml+xml'), ('empty', 'empty.xhtml', 'application/xhtml+xml')], [('good', 'yes'), ('empty', 'yes')], {'OPS/good.xhtml': self.document('正文', '<p>可靠文本。</p>'), 'OPS/empty.xhtml': self.document('图像章节', '<img src="page.png"/>')})
        result = self.prepare()
        self.assertTrue(result['incomplete'])
        self.assertTrue(any('无可提取正文' in warning for warning in result['warnings']))

    def test_explicit_image_only_cover_is_preserved_without_creating_a_text_gap(self):
        cover = '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Cover</title><meta name="calibre:cover" content="true"/></head><body><svg><image href="cover.jpeg"/></svg></body></html>'
        self.write_book([('titlepage', 'titlepage.xhtml', 'application/xhtml+xml'), ('cover', 'cover.jpeg', 'image/jpeg'), ('good', 'good.xhtml', 'application/xhtml+xml')], [('titlepage', 'yes'), ('good', 'yes')], {
            'OPS/titlepage.xhtml': cover, 'OPS/cover.jpeg': b'synthetic-cover',
            'OPS/good.xhtml': self.document('正文', '<p>可靠文本。</p>')})
        result = self.prepare()
        self.assertFalse(result['incomplete'])
        self.assertEqual([chapter['title'] for chapter in result['chapters']], ['正文'])
        self.assertTrue(any('仅含图像的封面页' in warning for warning in result['warnings']))
        self.assertTrue(any(asset['name'] == 'cover.jpeg' for asset in result['assets']))

    def test_utf16_document_and_all_missing_failure(self):
        self.write_book([('a', 'a.xhtml', 'application/xhtml+xml')], [('a', 'yes')], {'OPS/a.xhtml': self.document('UTF16', '<p>中文文本😀完整。</p>').encode('utf-16')})
        self.assertIn('中文文本😀完整。', self.prepare()['chapters'][0]['text'])
        self.write_book([], [('missing', 'yes')], {})
        with self.assertRaisesRegex(ValueError, '没有可靠可读的文本'):
            self.prepare()


if __name__ == '__main__':
    unittest.main()
