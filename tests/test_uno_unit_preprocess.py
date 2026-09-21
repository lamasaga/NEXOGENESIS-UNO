import importlib.util, tempfile, unittest
from pathlib import Path
from collections import Counter
spec=importlib.util.spec_from_file_location('pre',Path(__file__).resolve().parents[1]/'packages/nexogenesis-tools/lib/uno/preprocess.py');pre=importlib.util.module_from_spec(spec);spec.loader.exec_module(pre)
class UnitTests(unittest.TestCase):
 def prepare(self,text,kind='auto',suffix='.md'):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/('test'+suffix);p.write_text(text,encoding='utf-8');return pre.prepare(p,True,d,kind)
 def test_short_article_keeps_internal_sections(self):
  r=self.prepare('# 主标题\n\n正文\n\n## 小节\n\n反证');self.assertEqual(r['material_kind'],'article');self.assertEqual(len(r['chapters']),1);self.assertIn('反证',r['chapters'][0]['text'])
 def test_long_article_bounds_preserving_all_characters(self):
  text='甲😀乙。'*40000;r=self.prepare(text,'article');self.assertTrue(all(len(c['text'])<=60000 for c in r['chapters']));self.assertEqual(''.join(c['text'] for c in r['chapters']),text);self.assertTrue(r['chapters'][1]['continuation']['from_previous'])
 def test_book_internal_chapters_survive(self):
  r=self.prepare('# 第一章\n\n机制。\n\n# 第二章\n\n条件。','book');self.assertEqual(len(r['chapters']),2)
 def test_only_link_navigation_removed_not_repeated_prose(self):
  toc='\n'.join('\ue000'+t+'\ue001' for t in ['第一章','小节一','第二章','小节二','第三章','小节三'])
  text=toc+'\n第一章\n重复论证不是页眉\n重复论证不是页眉';c=Counter();r=pre.remove_epub_navigation(text,c);self.assertIn('第一章\n重复论证',r);self.assertEqual(r.count('重复论证不是页眉'),2);self.assertEqual(c['移除重复导航目录行'],6)
 def test_footnote_links_preserved(self):
  r=pre.remove_epub_navigation('原文\ue000注1\ue001\n说明\n\ue000注2\ue001',Counter());self.assertIn('注1',r);self.assertIn('注2',r)
 def test_html_script_noise_removed(self):
  r=self.prepare('<h1>标题</h1><script>bad()</script><p>论证</p><style>badcss</style><h2>边界</h2><p>不能外推</p>',suffix='.html');text=r['chapters'][0]['text'];self.assertNotIn('bad',text);self.assertIn('不能外推',text)
if __name__=='__main__': unittest.main()
