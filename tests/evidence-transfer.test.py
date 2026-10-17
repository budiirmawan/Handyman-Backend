"""Run: python3 tests/evidence-transfer.test.py"""
import csv
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/evidence-transfer.py'
KEY = 'evidence/11111111-1111-1111-1111-111111111111'


class Transfer(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'source'
        (self.root / 'evidence').mkdir(parents=True)
        (self.root / KEY).write_bytes(b'persisted evidence')
        self.manifest = self.base / 'manifest.json'
        self.run_tool('inventory', self.root, self.manifest)

    def run_tool(self, *args, success=True):
        result = subprocess.run([sys.executable, str(SCRIPT), *map(str, args)], capture_output=True, text=True)
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        return result

    def test_roundtrip_and_metadata(self):
        destination = self.base / 'import'
        destination.mkdir()
        self.run_tool('copy', self.root, self.manifest, '--destination', destination)
        reference = self.base / 'references.csv'
        data = json.loads(self.manifest.read_text())['files'][KEY]
        with reference.open('w') as stream:
            writer = csv.writer(stream)
            writer.writerow(['key', 'sha256', 'size'])
            writer.writerow([KEY, data['sha256'], data['size']])
        self.run_tool('verify', destination, self.manifest, '--references', reference)
        self.assertEqual((destination / KEY).read_bytes(), b'persisted evidence')
        self.run_tool('copy', self.root, self.manifest, '--destination', destination, success=False)

    def test_missing_corrupt_extra(self):
        (self.root / KEY).write_bytes(b'corrupt')
        self.run_tool('verify', self.root, self.manifest, success=False)
        (self.root / KEY).unlink()
        self.run_tool('verify', self.root, self.manifest, success=False)
        (self.root / 'unsafe.txt').write_text('extra')
        self.run_tool('verify', self.root, self.manifest, success=False)

    def test_traversal_and_symlink(self):
        self.manifest.write_text(json.dumps({'version': 1, 'files': {'../../unsafe': {'size': 0, 'sha256': 'a' * 64}}}))
        self.run_tool('verify', self.root, self.manifest, success=False)
        (self.root / KEY).unlink()
        (self.root / KEY).symlink_to('/etc/passwd')
        self.run_tool('inventory', self.root, self.base / 'bad.json', success=False)

    def test_missing_reference_and_wrong_hash(self):
        ref = self.base / 'ref.csv'
        ref.write_text(f'key,sha256,size\n{KEY},{"0" * 64},18\n')
        self.run_tool('verify', self.root, self.manifest, '--references', ref, success=False)
        ref.write_text('key,sha256,size\nreports/22222222-2222-2222-2222-222222222222,,\n')
        self.run_tool('verify', self.root, self.manifest, '--references', ref, success=False)

if __name__ == "__main__":
    unittest.main()
