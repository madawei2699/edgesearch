import re
from collections import defaultdict
from json import dumps
from operator import itemgetter
from os.path import dirname, realpath
from pathlib import Path
from sys import argv

# Use this script with monthly article page views data from https://dumps.wikimedia.org/other/pagecounts-ez/.

OUT_DIR = dirname(realpath(argv[0]))
Path(OUT_DIR + '/build').mkdir(exist_ok=True)

if len(argv) < 2:
    print('Pass the path to the dataset as the first argument')
    exit(1)

titles = defaultdict(int)
for line in open(argv[1], 'r'):
    # Split only by ASCII space, as some titles contain other types of whitespace.
    code, title, c = line.strip().split(' ')
    lang, proj = code.split('.', 1)
    if proj.startswith('m.'):
        proj = proj[2:]
    count = int(c, 10)
    if lang != 'en' or proj != 'z':
        continue
    titles[title] += count

sorted_titles = sorted(((title, count) for title, count in titles.items()), key=itemgetter(1), reverse=True)

f_documents = open(OUT_DIR + '/build/docs.txt', 'w')
f_terms = open(OUT_DIR + '/build/terms.txt', 'w')

terms_regex = re.compile('[^a-zA-Z0-9]+')
for (title, _) in sorted_titles:
    terms = {t.lower() for t in terms_regex.split(title) if t}
    if not terms:
        continue
    f_documents.write(dumps(title))
    f_documents.write('\0')
    for term in terms:
        f_terms.write(term)
        f_terms.write('\0')
    f_terms.write('\0')

with open(OUT_DIR + '/build/default.json', 'w') as f:
    f.write('[]')