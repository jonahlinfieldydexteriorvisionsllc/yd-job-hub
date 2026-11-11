"""Which website pages Google and Bing need to read again, for the daily indexing routine.

Plain code, no Claude: the routine (scheduled task indexing-requests-daily) runs this, then only
opens Search Console when something is due.

  python .claude/indexqueue.py due          pages to ask Google about, in order, one per line
  python .claude/indexqueue.py mark PATH requested|ongoogle
                                            record that Google was asked (or already has this version)
  python .claude/indexqueue.py indexnow     send every page whose date moved to IndexNow (Bing etc.)
  python .claude/indexqueue.py status       counts

A page is due when its sitemap date has moved since Google was last asked about it, or Google was
never asked. The website's checks/dates.mjs moves a page's date whenever its words change, so a
change on the site makes its page due the next morning. Changed pages go first (newest first), then
pages never asked about: home, services, towns, projects, Yard Talk, the rest.

State: reports/indexing-state.json (git-ignored). The first run copies what the old list
(reports/Indexing requests.md) already ticked off, against the dates live at that moment.
"""
import json, os, re, sys, urllib.error, urllib.request
from datetime import date

SITE = 'https://ydexteriorvisions.com'
HOST = 'ydexteriorvisions.com'
INDEXNOW_KEY = '940a611d9fd0737655fe3893ff21b8c4'   # public by design: served at SITE/<key>.txt
HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(HERE, '..', 'reports', 'indexing-state.json')
OLD_LIST = os.path.join(HERE, '..', 'reports', 'Indexing requests.md')
UA = {'User-Agent': 'Mozilla/5.0 (compatible; site-indexing-helper)'}

TOWN = re.compile(r'-wi-landscaping-and-hardscaping$|^/bishops-bay|^/snow-removal-verona|-middleton-wi$|-middleton$')
INFO = {'/about-yd-exterior-visions', '/areas-we-serve', '/faqs', '/warranty', '/ydexteriorvisions-contact',
        '/nominate', '/yd-gives-back', '/landscaping-ideas', '/landscaping-cost-madison-wi'}


def today():
    return date.today().isoformat()          # this PC runs on Chicago time


def fetch(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
        return r.read().decode('utf-8', 'replace')


def sitemap():
    """{path: 'YYYY-MM-DD' or ''} in the sitemap's own order."""
    index = fetch(SITE + '/sitemap-index.xml')
    maps = re.findall(r'<loc>([^<]+)</loc>', index) or [SITE + '/sitemap-0.xml']
    pages = {}
    for m in maps:
        for block in re.findall(r'<url>(.*?)</url>', fetch(m), re.S):
            loc = re.search(r'<loc>([^<]+)</loc>', block).group(1)
            lm = re.search(r'<lastmod>([^<]+)</lastmod>', block)
            path = loc[len(SITE):] or '/'
            pages[path.rstrip('/') or '/'] = lm.group(1)[:10] if lm else ''
    return pages


def load():
    if os.path.exists(STATE):
        with open(STATE, encoding='utf-8') as f:
            return json.load(f)
    return {'pages': {}}


def save(st):
    tmp = STATE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(st, f, indent=1, sort_keys=True)
    os.replace(tmp, STATE)


def seed(st, live):
    """First run: what the old list ticked off counts as asked, against today's live dates."""
    if st.get('seeded') or not os.path.exists(OLD_LIST):
        st['seeded'] = True
        return
    with open(OLD_LIST, encoding='utf-8') as f:
        for line in f:
            m = re.match(r'\s*- \[x\]\s+(\S+)(.*)', line, re.I)
            if not m:
                continue
            path = m.group(1).rstrip('/') or '/'
            how = 'ongoogle' if 'already on google' in m.group(2).lower() else 'requested'
            st['pages'].setdefault(path, {})['google'] = {'at': 'before ' + today(), 'forDate': live.get(path, ''), 'how': how}
    st['seeded'] = True


def group(path):
    if path == '/':
        return 0
    if path.startswith('/yard-talk'):
        return 4
    if path.startswith('/projects'):
        return 3
    if path in INFO:
        return 5
    if TOWN.search(path):
        return 2
    return 1


def due_list(st, live):
    changed, never = [], []
    for i, (path, d) in enumerate(live.items()):
        g = st['pages'].get(path, {}).get('google')
        if not g:
            never.append((group(path), i, path, d))
        elif g.get('forDate', '') != d:
            changed.append((d, path, g))
    changed.sort(key=lambda x: x[0], reverse=True)
    never.sort()
    rows = [(p, d, 'changed %s, Google last asked %s' % (d, g.get('at', '?'))) for d, p, g in changed]
    rows += [(p, d, 'never asked') for _, _, p, d in never]
    return rows


def main(argv):
    if not argv:
        print(__doc__)
        return 1
    cmd = argv[0]
    st = load()
    live = sitemap()
    seed(st, live)
    st['snapshot'] = live
    st['snapshotAt'] = today()

    if cmd == 'due':
        rows = due_list(st, live)
        save(st)
        if not rows:
            print('Nothing due: Google has been asked about every page at its current date.')
            return 0
        print('%d pages due (address, page date, why):' % len(rows))
        for p, d, why in rows:
            print('%s  %s  %s' % (SITE + p if p != '/' else SITE + '/', d or '-', why))
        return 0

    if cmd == 'mark':
        if len(argv) < 3 or argv[2] not in ('requested', 'ongoogle'):
            print('usage: mark PATH requested|ongoogle')
            return 1
        path = argv[1]
        if path.startswith(SITE):
            path = path[len(SITE):]
        path = path.rstrip('/') or '/'
        if path not in live:
            print('Not in the sitemap: %s' % path)
            return 1
        st['pages'].setdefault(path, {})['google'] = {'at': today(), 'forDate': live[path], 'how': argv[2]}
        save(st)
        left = len(due_list(st, live))
        print('Marked %s %s. %d still due.' % (path, argv[2], left))
        return 0

    if cmd == 'indexnow':
        todo = [p for p, d in live.items() if st['pages'].get(p, {}).get('indexnow', {}).get('forDate') != d]
        if not todo:
            save(st)
            print('IndexNow: nothing new to send.')
            return 0
        body = json.dumps({'host': HOST, 'key': INDEXNOW_KEY, 'keyLocation': '%s/%s.txt' % (SITE, INDEXNOW_KEY),
                           'urlList': [SITE + (p if p != '/' else '/') for p in todo]}).encode()
        req = urllib.request.Request('https://api.indexnow.org/indexnow', data=body, method='POST',
                                     headers=dict(UA, **{'Content-Type': 'application/json; charset=utf-8'}))
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                code = r.status
        except urllib.error.HTTPError as e:
            code = e.code
        except Exception as e:                      # no signal: try again tomorrow
            save(st)
            print('IndexNow: could not reach it (%s); tomorrow will try again.' % e)
            return 0
        if code in (200, 202):
            for p in todo:
                st['pages'].setdefault(p, {})['indexnow'] = {'at': today(), 'forDate': live[p]}
            save(st)
            print('IndexNow: sent %d pages (answer %d).' % (len(todo), code))
        else:
            save(st)
            why = {403: "the key file isn't on the site yet", 422: 'an address it refused',
                   429: 'too many sends'}.get(code, 'answer %d' % code)
            print('IndexNow: not accepted (%s); %d pages wait for tomorrow.' % (why, len(todo)))
        return 0

    if cmd == 'status':
        rows = due_list(st, live)
        save(st)
        asked = sum(1 for p in live if st['pages'].get(p, {}).get('google'))
        print('%d pages in the sitemap, Google asked about %d, %d due now (%d changed since asked).'
              % (len(live), asked, len(rows), sum(1 for r in rows if r[2].startswith('changed'))))
        return 0

    print('unknown command %s' % cmd)
    return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
