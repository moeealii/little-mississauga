"""Render docs/how-it-works.md into site/how.html (no dependencies)."""
import html
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
md = (ROOT / 'docs/how-it-works.md').read_text(encoding='utf-8')


def inline(text):
    text = html.escape(text, quote=False)
    text = re.sub(r'`([^`]+)`', r'<code>\1</code>', text)
    text = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', text)
    text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', lambda m: f'<a href="{m.group(2).replace("../", "https://github.com/moeealii/little-mississauga/blob/main/")}">{m.group(1)}</a>', text)
    return text


out, para, lines, i = [], [], md.splitlines(), 0
def flush():
    if para:
        out.append('<p>' + inline(' '.join(para)) + '</p>'); para.clear()
while i < len(lines):
    line = lines[i]
    if line.startswith('#'):
        flush(); level = len(line) - len(line.lstrip('#'))
        out.append(f'<h{level}>{inline(line[level:].strip())}</h{level}>')
    elif line.startswith('|'):
        flush(); rows = []
        while i < len(lines) and lines[i].startswith('|'):
            if not re.fullmatch(r'\|[\s\-|:]+\|', lines[i]):
                rows.append([c.strip() for c in lines[i].strip('|').split('|')])
            i += 1
        out.append('<table><thead><tr>' + ''.join(f'<th>{inline(c)}</th>' for c in rows[0]) + '</tr></thead><tbody>' +
                   ''.join('<tr>' + ''.join(f'<td>{inline(c)}</td>' for c in r) + '</tr>' for r in rows[1:]) + '</tbody></table>')
        continue
    elif re.match(r'^(\d+\.|-) ', line):
        flush(); ordered = line[0].isdigit(); items = []
        while i < len(lines) and re.match(r'^(\d+\.|-) ', lines[i]):
            items.append(re.sub(r'^(\d+\.|-) ', '', lines[i])); i += 1
        tag = 'ol' if ordered else 'ul'
        out.append(f'<{tag}>' + ''.join(f'<li>{inline(t)}</li>' for t in items) + f'</{tag}>')
        continue
    elif not line.strip():
        flush()
    else:
        para.append(line.strip())
    i += 1
flush()

page = f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>How it was made · Little Mississauga</title>
<meta name="description" content="How an RCT3-style map of all of Mississauga was built from real open data and a fine-tuned image model.">
<link rel="icon" href="favicon.svg">
<style>
:root{{--ink:#21382f;--muted:#5c6c62;--line:#d4ddcf;--accent:#244d3c;--bg:#f3f5ee}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--ink);font:16px/1.65 system-ui,-apple-system,Segoe UI,sans-serif}}
header{{background:#14261f url(art/social-preview.jpg) center/cover;color:#fff;padding:72px 20px 56px;text-align:center}}
header h1{{margin:0;font-size:clamp(28px,5vw,46px);letter-spacing:-.02em}}header p{{margin:10px auto 22px;max-width:620px;opacity:.88}}
header a{{display:inline-block;background:#fff;color:var(--accent);padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:600}}
main{{max-width:780px;margin:0 auto;padding:36px 20px 80px}}main>h1:first-child{{display:none}}
h2{{margin-top:44px;padding-top:10px;border-top:1px solid var(--line);font-size:24px}}h3{{font-size:18px;margin-top:28px}}
a{{color:var(--accent)}}code{{background:#e4eadf;padding:1px 5px;border-radius:5px;font-size:.9em}}
table{{width:100%;border-collapse:collapse;margin:18px 0;font-size:15px;background:#fcfcfb;border-radius:10px;overflow:hidden}}
th,td{{padding:9px 12px;border-bottom:1px solid var(--line);text-align:left}}th{{background:#e9eee4}}
li{{margin:5px 0}}footer{{text-align:center;color:var(--muted);font-size:14px;padding:0 20px 50px}}
</style></head><body>
<header><h1>How Little Mississauga was made</h1><p>An RCT3-style miniature of the whole city, painted by a fine-tuned image model over real municipal and provincial geography.</p><a href="./">Open the map →</a></header>
<main>{''.join(out)}</main>
<footer>Code on <a href="https://github.com/moeealii/little-mississauga">GitHub</a> · Independent project, not affiliated with the City of Mississauga.</footer>
</body></html>
'''
(ROOT / 'site/how.html').write_text(page, encoding='utf-8')
print('wrote site/how.html', len(page))
