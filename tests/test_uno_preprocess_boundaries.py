"""Local, deterministic chapter-boundary regressions; no model or knowledge writes.

Run: python -B -X utf8 tests/test_uno_preprocess_boundaries.py
UNO_PREPROCESS_SCRIPT optionally selects a staged implementation.
UNO_PREPROCESS_CORPUS optionally points to an external source/manifest.json fixture.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import tempfile
import unittest


SCRIPT = Path(os.environ.get('UNO_PREPROCESS_SCRIPT',
    Path(__file__).resolve().parents[1] / 'packages/nexogenesis-tools/lib/uno/preprocess.py'))
spec = importlib.util.spec_from_file_location('uno_preprocess_boundaries', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
MARKER = re.compile(r'<!--\s*(?:PDF\s*)?物理页\s*(\d+)(?:\s*[;；]\s*书页\s*\d+)?\s*-->')


def compact(text):
    return re.sub(r'\s+', '', text)


def markers(text):
    return [int(n) for n in MARKER.findall(text)]


class ChapterBoundaries(unittest.TestCase):
    def prepare(self, text, kind='book', modern=True):
        with tempfile.TemporaryDirectory(prefix='uno-preprocess-boundary-') as directory:
            path = Path(directory) / 'source.md'
            path.write_text(text, encoding='utf-8')
            raw = path.read_bytes()
            value = module.prepare(path, modern=modern, root=directory, material_kind=kind)
            self.assertEqual(path.read_bytes(), raw, 'Input must stay unchanged')
        if value['source_metadata']:
            text = re.sub(r'\A---\n[\s\S]*?\n---(?:\n|$)', '', text, count=1)
        self.assertEqual(compact(text), compact(''.join(c['text'] for c in value['chapters'])))
        return value['chapters']

    def test_printed_contents_rows_do_not_rename_preface_as_last_chapter(self):
        units = self.prepare('# 一本书\n目录\n第一章 .......... 11\n第十章 ………… 60\n'
                             '这是一段序言，介绍作者与书的边界。\n第一章\n这里是本章正文甲。\n'
                             '第十章\n这里是末章正文乙。')
        self.assertEqual([c['title'] for c in units], ['一本书', '第一章', '第十章'])
        self.assertIn('第十章 ………… 60', units[0]['text'])
        self.assertIn('介绍作者', units[0]['text'])
        self.assertNotIn('介绍作者', units[2]['text'])

    def test_outer_title_and_printed_heading_share_body(self):
        units = self.prepare('# 一本书\n\n第一章\n内容甲。\n\n第二章\n内容乙。')
        self.assertEqual([c['title'] for c in units], ['第一章', '第二章'])
        self.assertIn('# 一本书', units[0]['text'])

    def test_consecutive_chapter_titles_do_not_create_empty_work(self):
        units = self.prepare('# 第一章 名称\n第一章\n短。\n第二章\n另一短章。')
        self.assertEqual(len(units), 2)
        self.assertIn('短。', units[0]['text'])

    def test_real_preface_is_not_merged_as_title_furniture(self):
        units = self.prepare('# 书名\n这里是有意义的导言。\n第一章\n正文。')
        self.assertEqual(len(units), 2)
        self.assertNotIn('导言', units[1]['text'])

    def test_page_marker_and_printed_number_follow_next_heading(self):
        units = self.prepare('# 书名\n<!-- PDF物理页 10；书页 2 -->\n2\n第一章\n甲。\n'
                             '<!-- PDF物理页 11；书页 3 -->\n3\n第二章\n乙。')
        self.assertEqual([markers(c['text']) for c in units], [[10], [11]])
        self.assertEqual([c['title'] for c in units], ['第一章', '第二章'])
        self.assertEqual(units[1]['locator'], '提取文本行 6–9')

    def test_declared_page_header_is_preserved_with_page_marker(self):
        units = self.prepare('---\ntitle: "A Book"\n---\n# 书名\n<!-- PDF物理页 1；书页 1 -->\nA Book\n1\n第一章\n甲。\n'
                             '<!-- PDF物理页 2；书页 2 -->\nA Book\n2\n续页。\n'
                             '<!-- PDF物理页 3；书页 3 -->\nA Book\n3\n第二章\n乙。')
        self.assertEqual([markers(c['text']) for c in units], [[1, 2], [3]])
        self.assertEqual(sum(c['text'].count('A Book') for c in units), 3)

    def test_repeated_qualifications_stay_with_original_chapter(self):
        sentence = '此结论仅在原条件下成立。'
        units = self.prepare('第一章\n首章正文。\n<!-- 物理页 2 -->\n' + sentence +
                             '\n第二章\n次章正文。\n<!-- 物理页 3 -->\n' + sentence +
                             '\n第三章\n本章正文。\n<!-- 物理页 4 -->\n' + sentence +
                             '\n第四章\n末章正文。')
        self.assertEqual(len(units), 4)
        self.assertEqual([c['text'].count(sentence) for c in units], [1, 1, 1, 0])

    def test_short_numeric_body_is_not_deleted_or_treated_as_footer(self):
        units = self.prepare('第一章\n42\n第二章\n1')
        self.assertEqual(len(units), 2)
        self.assertIn('42', units[0]['text'])

    def test_unknown_number_after_page_marker_remains_substantive(self):
        units = self.prepare('# 书名\n<!-- PDF物理页 1；书页 1 -->\n999\n第一章\n正文。')
        self.assertEqual(len(units), 2)
        self.assertIn('999', units[0]['text'])

    def test_blank_page_prefixes_stay_in_source_order(self):
        units = self.prepare('第一章\n甲。\n<!-- 物理页 2 -->\n\n'
                             '<!-- 物理页 3 -->\n3\n第二章\n乙。')
        self.assertEqual([markers(c['text']) for c in units], [[], [2, 3]])

    def test_page_prefix_inside_chapter_does_not_split(self):
        units = self.prepare('第一章\n甲。\n<!-- 物理页 2 -->\n2\n续文。')
        self.assertEqual(len(units), 1)
        self.assertEqual(markers(units[0]['text']), [2])

    def test_final_page_prefix_is_retained(self):
        units = self.prepare('第一章\n甲。\n<!-- 物理页 2 -->\n2\n')
        self.assertEqual(len(units), 1)
        self.assertEqual(markers(units[0]['text']), [2])

    def test_standalone_afterword_is_book_boundary(self):
        units = self.prepare('第十章\n主文。\n<!-- 物理页 71 -->\n71\n  后记  \n附文。')
        self.assertEqual([c['title'] for c in units], ['第十章', '后记'])
        self.assertEqual([markers(c['text']) for c in units], [[], [71]])

    def test_prose_mentions_and_quoted_afterword_do_not_split(self):
        units = self.prepare('第一章\n正文提及后记，但仍是一段。\n“后记”\n后记说明了背景。')
        self.assertEqual(len(units), 1)

    def test_standalone_afterword_is_not_article_boundary(self):
        units = self.prepare('第一章\n主文。\n后记\n附文。', kind='article', modern=False)
        self.assertEqual(len(units), 1)

    def test_unrecognized_comments_are_not_removed_as_wrappers(self):
        units = self.prepare('# 书名\n<!-- 译者解释：保留这个概念 -->\n第一章\n正文。')
        self.assertEqual(len(units), 2)
        self.assertIn('译者解释', units[0]['text'])

    def test_explicit_book_scope_leaves_legacy_headings_unchanged(self):
        units = self.prepare('# 书名\n第一章\n正文。', kind=None, modern=False)
        self.assertEqual(len(units), 2)

    def test_source_metadata_and_original_line_locations_survive(self):
        units = self.prepare('---\ntitle: 书名\nauthor: 作者\n---\n# 书名\n第一章\n正文。\n'
                             '<!-- PDF物理页 5；书页 3 -->\n3\n第二章\n后文。')
        self.assertEqual(len(units), 2)
        self.assertEqual(units[0]['locator'], '提取文本行 1–7')
        self.assertEqual(units[1]['locator'], '提取文本行 8–11')

    @unittest.skipUnless(os.environ.get('UNO_PREPROCESS_CORPUS'), 'external PDF-derived corpus is optional')
    def test_read_only_external_baseline_and_full_book(self):
        root = Path(os.environ['UNO_PREPROCESS_CORPUS'])
        manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
        chapter_ranges = {c['id']: c['physical_pages'] for c in manifest['chapters']}
        for item in [manifest['baseline']] + manifest['full_book_inputs']:
            with self.subTest(input=item['relative_path']):
                path = root / item['relative_path']
                raw = path.read_bytes()
                self.assertEqual(hashlib.sha256(raw).hexdigest(), item['sha256'])
                value = module.prepare(path, modern=True, root=root, material_kind='book')
                expected = [chapter_ranges[key] for key in item.get('chapters', ['ch03'])]
                self.assertEqual(len(value['chapters']), len(expected))
                self.assertEqual([markers(c['text']) for c in value['chapters']],
                                 [list(range(a, b + 1)) for a, b in expected])
                original = re.sub(r'\A---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)', '', raw.decode('utf-8'), count=1)
                self.assertEqual(compact(original), compact(''.join(c['text'] for c in value['chapters'])))
                self.assertEqual(path.read_bytes(), raw)


if __name__ == '__main__':
    unittest.main(verbosity=2)
