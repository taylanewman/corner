#!/usr/bin/env python3
"""Refresh this site with the latest version of the app.

Run from the repository folder:
    python3 _tools/update_app.py path/to/latest-app.html "short note about what changed"

Only index.html and VERSION.txt change. private.js (the lock + sync), config.js,
the icons and the sync library stay as they are. No one's data is in any file here.
"""
import os, re, sys, datetime
src = sys.argv[1]; note = sys.argv[2] if len(sys.argv) > 2 else ''
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
html = open(src, encoding='utf-8').read()
html = re.sub(r'(<script type="application/json" id="pm-state">).*?(</script>)', r'\1null\2', html, count=1, flags=re.S)
assert 'id="pm-state">null</script>' in html, 'not the app file?'
old = open(os.path.join(root, 'index.html'), encoding='utf-8').read()
head_extra = re.search(r'<meta http-equiv="Content-Security-Policy".*?<link rel="apple-touch-icon"[^>]*>\n', old, re.S).group(0)
html = re.sub(r'<title>.*?</title>', '<title>Corner</title>', html, count=1)
html = html.replace('</title>\n', '</title>\n' + head_extra, 1)
loader = '<script src="config.js"></script>\n<script src="vendor/supabase.js"></script>\n<script src="private.js"></script>\n'
html = html.replace('<script type="application/json" id="pm-state">', loader + '<script type="application/json" id="pm-state">', 1)
open(os.path.join(root, 'index.html'), 'w', encoding='utf-8').write(html)
with open(os.path.join(root, 'VERSION.txt'), 'a') as f: f.write('%s  %s\n' % (datetime.date.today().isoformat(), note))
print('updated index.html')
