"""Local token counting only. No model calls or implicit downloads."""
import sys,json
from pathlib import Path

request=json.loads(sys.stdin.buffer.read().decode('utf-8'))
model=request.get('model','')
directory=Path(request['tokenizer_dir'])
manifest=directory/'models.json'
if manifest.exists():
    entry=json.loads(manifest.read_text('utf-8')).get(model)
    if entry:
        from tokenizers import Tokenizer
        file=(directory/entry['file']).resolve()
        if not file.is_relative_to(directory.resolve()): raise ValueError('Tokenizer path outside directory')
        tokenizer=Tokenizer.from_file(str(file))
        result={'tokens':len(tokenizer.encode(request['text'],add_special_tokens=False).ids),'exact':entry.get('exact',False),'method':entry.get('name',model)}
        print(json.dumps(result)); sys.exit(0)
# Unknown models must not be presented as exactly counted with another model's vocabulary.
raise ValueError('No locally configured tokenizer for this model')
