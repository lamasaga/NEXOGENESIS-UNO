"""Explicit setup-only download; the recording worker always runs offline."""
import sys
from huggingface_hub import snapshot_download

snapshot_download(
    repo_id="Systran/faster-whisper-small",
    revision="536b0662742c02347bc0e980a01041f333bce120",
    local_dir=sys.argv[1],
    allow_patterns=["model.bin", "config.json", "tokenizer.json", "vocabulary.txt"],
)
