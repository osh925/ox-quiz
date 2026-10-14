#!/usr/bin/env python3
"""단답형(빈칸) 데이터 빌드·검증.

입력:  data/questions.json (정지문), data/cloze_source.jsonl (사람이 고른 빈칸 — 편집 대상)
출력:  data/cloze.json (앱이 읽는 파일), data/cloze_report.txt

cloze_source.jsonl 한 줄 = 정지문 1개:
  {"item_id": "...", "hash": "<정지문 hash>", "blanks": [{"answer": "소장", "accept": ["..."]}], "note": "..."}
  또는 {"item_id": "...", "hash": "...", "skip": "사유"}
  - answer 는 정지문에 그대로 들어 있는 부분 문자열이어야 함. 문장 안의 모든 등장 위치가 빈칸이 됨(정답 노출 방지).
  - accept 는 추가로 인정할 답(동의어 등). 띄어쓰기 변형은 적을 필요 없음: 저장·채점 모두 공백을 전부 제거해 비교.
  - hash 가 현재 정지문 hash 와 다르면 'stale' 로 표시하고 그 항목은 출력에서 빼므로, 문장을 확인하고 hash 를 갱신하세요.

  python3 tools/build_cloze.py            # 빌드 + 검증 (오류 있으면 종료코드 1)
  python3 tools/build_cloze.py --import-tsv data/cloze_src/*.tsv   # 작성용 TSV → jsonl (최초 작성 시)
"""
import hashlib, json, re, sys, unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
QJ, SRC, OUT, REP = ROOT / 'data/questions.json', ROOT / 'data/cloze_source.jsonl', ROOT / 'data/cloze.json', ROOT / 'data/cloze_report.txt'

PUNCT = str.maketrans({'ㆍ': '·', '‧': '·', '・': '·', '∙': '·', ',': '·', '，': '·', '/': '·', '.': '·'})
def norm(s):
    """채점용 정규화 (js/quiz-core.js normalizeAnswer 와 동일): NFC, 모든 공백 제거, 가운뎃점류·쉼표·마침표·빗금 통일"""
    s = unicodedata.normalize('NFC', s)
    s = re.sub(r'\s+', '', s)
    return s.translate(PUNCT)

# 기한·기간 숫자(허용): 2주, 14일, 1월, 6개월, 1년, 30일 등
DEADLINE = re.compile(r'^\d+(일|주|주일|월|개월|년|시간)$')
# 숫자가 들어 있지만 숫자 자체가 아니라 법률 개념어인 것 (허용)
DIGIT_CONCEPTS = {'제3채무자', '제3자'}

def items():
    d = json.loads(QJ.read_text('utf-8'))
    return {i['id']: i for s in d['subjects'] for i in s['items']}

def import_tsv(paths):
    its = items(); rows = []
    for p in paths:
        for ln in Path(p).read_text('utf-8').splitlines():
            if not ln.strip(): continue
            parts = ln.split('\t')
            iid = 'civpro1-mid-' + parts[0].strip(); spec = parts[1].strip(); note = parts[2].strip() if len(parts) > 2 else ''
            it = its[iid]
            r = {'item_id': iid, 'hash': it['hash']}
            if spec.startswith('!'):
                r['skip'] = spec[1:].strip()
            else:
                r['blanks'] = []
                for b in spec.split('||'):
                    alts = [a.strip() for a in b.split(';') if a.strip()]
                    r['blanks'].append({'answer': alts[0], 'accept': alts[1:]})
                if note: r['note'] = note
            rows.append(r)
    SRC.write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in rows), 'utf-8')
    print(f'{len(rows)} rows → {SRC}')

def occurrences(text, sub):
    out, i = [], text.find(sub)
    while i >= 0:
        out.append((i, i + len(sub))); i = text.find(sub, i + len(sub))
    return out

def build():
    its = items()
    src = [json.loads(l) for l in SRC.read_text('utf-8').splitlines() if l.strip()]
    errors, warns, stale, out, skipped = [], [], [], [], []
    seen = set()
    multi_occ, deadline, multi_blank = [], [], []
    for r in src:
        iid = r['item_id']
        if iid in seen: errors.append(f'{iid}: 중복 항목'); continue
        seen.add(iid)
        it = its.get(iid)
        if not it: errors.append(f'{iid}: questions.json 에 없는 정지문'); continue
        if r.get('hash') != it['hash']:
            stale.append(f'{iid}: 정지문이 바뀜 (source hash {r.get("hash")} ≠ 현재 {it["hash"]}) — 문장을 확인하고 hash 를 갱신하세요'); continue
        if 'skip' in r:
            skipped.append((iid, r['skip'])); continue
        text = it['answer']
        spans, answers = [], []
        for bi, b in enumerate(r['blanks']):
            a = b['answer']
            if not a or a != a.strip(): errors.append(f'{iid}: 빈 답/앞뒤 공백 "{a}"'); continue
            occ = occurrences(text, a)
            if not occ: errors.append(f'{iid}: 답 "{a}" 이(가) 정지문의 부분 문자열이 아님'); continue
            if re.search(r'\d', a) and norm(a) not in DIGIT_CONCEPTS:
                if DEADLINE.match(norm(a)): deadline.append(f'{iid}: {a}')
                else: errors.append(f'{iid}: 숫자 답 "{a}" (기한·기간 외 숫자는 금지)')
            if len(occ) > 1: multi_occ.append(f'{iid}: "{a}" ×{len(occ)} (모두 빈칸)')
            spans += [(s, e, bi) for s, e in occ]
            acc = []
            for x in [a] + b.get('accept', []):
                n = norm(x)
                if n and n not in acc: acc.append(n)
            answers.append({'canonical': a, 'accept': acc, 'len': len(re.sub(r'\s+', '', a))})
        if len(answers) != len(r['blanks']): continue
        spans.sort()
        for (s1, e1, _), (s2, e2, _) in zip(spans, spans[1:]):
            if s2 < e1: errors.append(f'{iid}: 빈칸이 서로 겹침'); break
        else:
            tpl, pos = [], 0
            for s, e, bi in spans:
                tpl.append(text[pos:s].replace('{', '｛')); tpl.append('{{%d}}' % bi); pos = e
            tpl.append(text[pos:])
            template = ''.join(tpl)
            visible = norm(re.sub(r'\{\{\d+\}\}', '', template))
            for a in answers:
                for x in a['accept']:
                    if x in visible: warns.append(f'{iid}: 빈칸을 뺀 문장에 답 "{x}" 이(가) 여전히 보임 (정답 노출 가능)')
            if len(answers) > 1: multi_blank.append(f'{iid}: ' + ' / '.join(a['canonical'] for a in answers))
            out.append({'id': f'{iid}-c1', 'item_id': iid, 'text': template, 'answers': answers,
                        **({'note': r['note']} if r.get('note') else {}),
                        'hash': hashlib.sha1(template.encode()).hexdigest()[:8]})
    missing = [i for i in its if i not in seen]
    data = {'schemaVersion': 1, 'source': 'data/cloze_source.jsonl', 'count': len(out), 'items': out}
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1) + '\n', 'utf-8')
    L = [f'단답형 빌드 리포트', f'정지문 {len(its)} · 소스 {len(src)} · 출제 가능 {len(out)} · 건너뜀 {len(skipped)} · stale {len(stale)} · 소스 없음 {len(missing)}',
         f'빈칸 2개 문항 {len(multi_blank)} · 기한·기간 숫자 답 {len(deadline)} · 같은 답이 여러 번 나와 모두 빈칸 {len(multi_occ)}', '']
    def sec(title, xs):
        L.append(f'## {title} ({len(xs)})'); L.extend('  ' + x for x in xs); L.append('')
    sec('오류', errors); sec('경고', warns); sec('stale (정지문 변경)', stale); sec('소스 없음', missing)
    reasons = {}
    for _, why in skipped: reasons[why] = reasons.get(why, 0) + 1
    sec('건너뜀 사유별', [f'{n}건 — {w}' for w, n in sorted(reasons.items(), key=lambda x: -x[1])])
    sec('건너뜀 목록', [f'{i}: {w}' for i, w in skipped])
    sec('기한·기간 숫자 답', deadline); sec('빈칸 2개', multi_blank); sec('여러 번 등장(모두 빈칸)', multi_occ)
    borderline = [f"{r['item_id']}: {r['note']}" for r in src if r.get('note') and 'skip' not in r]
    sec('경계 사례 (검토 메모)', borderline)
    REP.write_text('\n'.join(L), 'utf-8')
    print('\n'.join(L[:3]))
    for x in errors + warns + stale: print('!', x)
    return 1 if errors or stale else 0

if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--import-tsv':
        import_tsv(sys.argv[2:])
    else:
        sys.exit(build())
