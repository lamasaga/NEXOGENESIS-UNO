import importlib.util
import io
from pathlib import Path
from types import SimpleNamespace
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('resource_preprocess', Path(__file__).resolve().parents[1] / 'packages/nexogenesis-tools/lib/uno/preprocess.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class ZipResourceBudgetTests(unittest.TestCase):
    def test_manifest_limits_before_reading(self):
        for infos in ([SimpleNamespace(filename=str(i), file_size=0) for i in range(20001)],
                      [SimpleNamespace(filename='big', file_size=201*1024*1024)],
                      [SimpleNamespace(filename='same', file_size=1)]*2):
            with self.assertRaises(ValueError):
                module.ZipBudget(SimpleNamespace(infolist=lambda: infos))

    def test_read_limits_and_complete_bytes(self):
        data=io.BytesIO()
        with zipfile.ZipFile(data,'w') as archive:
            archive.writestr('document.xml',b'content')
        with zipfile.ZipFile(data) as archive:
            budget=module.ZipBudget(archive)
            with self.assertRaises(ValueError): budget.read('document.xml',maximum=6)
            self.assertEqual(budget.read('document.xml'),b'content')
            budget.read_bytes=200*1024*1024
            with self.assertRaises(ValueError): budget.read('document.xml')

if __name__ == '__main__': unittest.main()
