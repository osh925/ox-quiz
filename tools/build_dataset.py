#!/usr/bin/env python3
"""docx(정지문/오지문) -> data/questions.json 변환기.

사용법 (프로젝트 루트에서):
    python3 tools/build_dataset.py            # data/subjects.config.json 기준으로 빌드
    python3 tools/build_dataset.py --strict   # 경고가 하나라도 있으면 exit 1

외부 의존성 없음 (zipfile + xml.etree). docx 서식 규칙은 README.md 참고.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
SCHEMA_VERSION = 1

# ---------------------------------------------------------------- 규칙(정규식)
# 제목(heading) 레벨. 위에서부터 순서대로 검사.
HEADING_RULES = [
    (1, re.compile(r"^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ]+\.\s*\S")),   # Ⅰ. 소제기
    (2, re.compile(r"^\d+\.\s*\S")),                    # 1. 주요 개념  (항목이 아닌 것으로 판정된 경우만)
    (3, re.compile(r"^[가-힣]\.\s*\S")),                # 가. 소장의 제출
    (4, re.compile(r"^\d+\)\s*\S")),                    # 1) 소장의 기재사항
    (4, re.compile(r"^[⚫●■◆▶]\s*\S")),               # ⚫ 박스 제목 (4단계와 같은 레벨로 취급)
    (5, re.compile(r"^\(\d+\)\s*\S")),                  # (1) ...
    (6, re.compile(r"^[가-힣]\)\s*\S")),                # 가) ...
]
TRUE_ITEM = re.compile(r"^(\d+)\.\s+(.+)$")
FALSE_ITEM = re.compile(r"^(\d+)-(\d+)\.\s+(.+)$")
POINT_ITEM = re.compile(r"^(\d+)-(\d+)\s*〔([^〕]*)〕\s*(.+)$")
POINTS_HEADER = re.compile(r"^정답\s*[·ㆍ]\s*변형\s*포인트")
NOTE = re.compile(r"^※")
SENTENCE_END = re.compile(r"[.。]$|[.。][\"'”’)\]]$")
MAX_GAP = 5          # 정지문 번호가 직전 번호보다 이만큼 이상 건너뛰면 항목으로 보지 않음(경고)
PREAMBLE_LINES = 2   # 문서 맨 앞 제목·부제 줄 수 (항목/제목 판정 전에 건너뜀)


# ---------------------------------------------------------------- docx 읽기
def read_paragraphs(path: Path) -> list[str]:
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read("word/document.xml"))
    out = []
    for p in root.iter(W + "p"):
        buf = []
        for el in p.iter():
            if el.tag == W + "t" and el.text:
                buf.append(el.text)
            elif el.tag in (W + "tab",):
                buf.append(" ")
            elif el.tag in (W + "br", W + "cr"):
                buf.append(" ")
        text = re.sub(r"\s+", " ", "".join(buf).replace("\u00a0", " ")).strip()
        out.append(text)
    return out


def heading_level(text: str) -> int | None:
    if len(text) > 80 or SENTENCE_END.search(text):
        return None
    for lvl, rx in HEADING_RULES:
        if rx.match(text):
            return lvl
    return None


def push_heading(stack: list[tuple[int, str]], lvl: int, text: str) -> None:
    while stack and stack[-1][0] >= lvl:
        stack.pop()
    stack.append((lvl, text))


def h8(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8")).hexdigest()[:8]


# ---------------------------------------------------------------- 정지문
def parse_true(paras: list[str], warn) -> tuple[list[dict], list[str]]:
    items, notes, stack, last = [], [], [], 0
    for idx, t in enumerate(paras):
        if not t:
            continue
        if idx < PREAMBLE_LINES:
            notes.append(t)
            continue
        if NOTE.match(t):
            notes.append(t)
            continue
        m = TRUE_ITEM.match(t)
        if m:
            n, body = int(m.group(1)), m.group(2).strip()
            looks_sentence = bool(SENTENCE_END.search(body)) and len(body) >= 8
            if looks_sentence and last < n <= last + MAX_GAP:
                if n != last + 1:
                    warn(f"[정지문] 번호 건너뜀: {last} 다음이 {n} (문단 {idx})")
                items.append({"no": n, "text": body, "section": [h for _, h in stack], "_para": idx})
                last = n
                continue
            if looks_sentence:
                warn(f"[정지문] 문장처럼 보이지만 번호 순서가 맞지 않아 항목에서 제외: 문단 {idx} (직전 {last}) {t[:60]!r}")
                continue
        lvl = heading_level(t)
        if lvl:
            push_heading(stack, lvl, t)
            continue
        warn(f"[정지문] 분류 불가 문단 무시: 문단 {idx} {t[:60]!r}")
    return items, notes


# ---------------------------------------------------------------- 오지문
def parse_false(paras: list[str], warn) -> tuple[list[dict], dict, list[str]]:
    wrongs, points, notes, stack = [], {}, [], []
    in_points = False
    for idx, t in enumerate(paras):
        if not t:
            continue
        if idx < PREAMBLE_LINES:
            notes.append(t)
            continue
        if POINTS_HEADER.match(t):
            in_points = True
            continue
        if NOTE.match(t):
            notes.append(t)
            continue
        if in_points:
            # 한 줄에 '｜' 로 여러 포인트가 있을 수 있음
            parts = [s.strip() for s in re.split(r"\s*[｜|]\s*", t) if s.strip()]
            matched = False
            for part in parts:
                pm = POINT_ITEM.match(part)
                if pm:
                    matched = True
                    key = f"{int(pm.group(1))}-{int(pm.group(2))}"
                    if key in points:
                        warn(f"[변형포인트] 중복 번호 {key}")
                    points[key] = {"type": pm.group(3).strip(), "change": pm.group(4).strip()}
            if not matched and not heading_level(t):
                warn(f"[변형포인트] 분류 불가 문단 무시: 문단 {idx} {t[:60]!r}")
            continue
        m = FALSE_ITEM.match(t)
        if m:
            wrongs.append({"parent": int(m.group(1)), "sub": int(m.group(2)), "text": m.group(3).strip(),
                           "section": [h for _, h in stack], "_para": idx})
            continue
        lvl = heading_level(t)
        if lvl:
            push_heading(stack, lvl, t)
            continue
        warn(f"[오지문] 분류 불가 문단 무시: 문단 {idx} {t[:60]!r}")
    return wrongs, points, notes


# ---------------------------------------------------------------- 빌드
def build_subject(cfg: dict, report: list[str], warnings: list[str]) -> dict:
    sid = cfg["id"]

    def warn(msg):
        warnings.append(f"({sid}) {msg}")

    tpath, fpath = ROOT / cfg["trueDocx"], ROOT / cfg["falseDocx"]
    tparas, fparas = read_paragraphs(tpath), read_paragraphs(fpath)
    trues, tnotes = parse_true(tparas, warn)
    wrongs, points, fnotes = parse_false(fparas, warn)

    # 중복 번호
    seen, dup_true = set(), []
    for it in trues:
        if it["no"] in seen:
            dup_true.append(it["no"])
        seen.add(it["no"])
    by_no = {it["no"]: it for it in trues}
    seen_w, dup_wrong = set(), []
    for w in wrongs:
        key = (w["parent"], w["sub"])
        if key in seen_w:
            dup_wrong.append(f"{key[0]}-{key[1]}")
        seen_w.add(key)

    orphans, identical, section_mismatch = [], [], []
    for w in wrongs:
        key = f"{w['parent']}-{w['sub']}"
        parent = by_no.get(w["parent"])
        if not parent:
            orphans.append(key)
            continue
        if f"{key}" in dup_wrong and any(x.get("no") == key for x in parent.setdefault("wrongs", [])):
            continue  # 중복은 첫 번째만 사용
        if w["text"] == parent["text"]:
            identical.append(key)
        if w["section"] != parent["section"]:
            section_mismatch.append(f"{key}: 오지문 {' > '.join(w['section'])} / 정지문 {' > '.join(parent['section'])}")
        wobj = {"id": f"{sid}-{w['parent']:04d}-{w['sub']}", "no": key, "text": w["text"], "hash": h8(w["text"])}
        if key in points:
            wobj["point"] = points[key]
        parent.setdefault("wrongs", []).append(wobj)

    wrong_keys = {f"{w['parent']}-{w['sub']}" for w in wrongs}
    points_orphan = sorted(set(points) - wrong_keys, key=lambda k: tuple(map(int, k.split("-"))))
    wrongs_no_point = sorted(wrong_keys - set(points), key=lambda k: tuple(map(int, k.split("-"))))

    items = []
    for it in trues:
        ws = sorted(it.get("wrongs", []), key=lambda x: int(x["no"].split("-")[1]))
        items.append({
            "id": f"{sid}-{it['no']:04d}",
            "no": it["no"],
            "section": it["section"],
            "answer": it["text"],
            "hash": h8(it["text"]),
            "wrongs": ws,
        })
    zero = [it["no"] for it in items if not it["wrongs"]]
    multi = sum(1 for it in items if len(it["wrongs"]) >= 2)
    nwrong_used = sum(len(it["wrongs"]) for it in items)

    def short(lst, k=30):
        lst = list(lst)
        return ", ".join(map(str, lst[:k])) + (f" … (+{len(lst)-k})" if len(lst) > k else "") if lst else "없음"

    report += [
        f"== {cfg['name']} ({sid}) ==",
        f"정지문 파일: {cfg['trueDocx']} (문단 {len(tparas)}개)",
        f"오지문 파일: {cfg['falseDocx']} (문단 {len(fparas)}개)",
        f"정지문 수: {len(items)}  (번호 범위 {items[0]['no'] if items else '-'}~{items[-1]['no'] if items else '-'})",
        f"오지문 수(파싱): {len(wrongs)}  / 연결됨: {nwrong_used}",
        f"오지문 2개 이상인 정지문: {multi}",
        f"오지문 0개인 정지문: {len(zero)}  [{short(zero)}]",
        f"고아 오지문(N에 해당하는 정지문 없음): {len(orphans)}  [{short(orphans)}]",
        f"중복 번호 - 정지문: {len(dup_true)} [{short(dup_true)}] / 오지문: {len(dup_wrong)} [{short(dup_wrong)}]",
        f"정지문과 글자가 완전히 같은 오지문: {len(identical)}  [{short(identical)}]",
        f"섹션 경로 불일치(오지문 문서 vs 정지문 문서): {len(section_mismatch)}",
        *[f"   - {s}" for s in section_mismatch[:20]],
        f"변형 포인트: {len(points)}개 / 포인트 없는 오지문 {len(wrongs_no_point)} [{short(wrongs_no_point)}] / 오지문 없는 포인트 {len(points_orphan)} [{short(points_orphan)}]",
        f"제외된 머리말·※ 줄: 정지문 {len(tnotes)} / 오지문 {len(fnotes)}",
        "",
    ]
    return {
        "id": sid,
        "name": cfg["name"],
        "title": tparas[0] if tparas else cfg["name"],
        "itemCount": len(items),
        "wrongCount": nwrong_used,
        "items": items,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(ROOT / "data/subjects.config.json"))
    ap.add_argument("--out", default=str(ROOT / "data/questions.json"))
    ap.add_argument("--report", default=str(ROOT / "data/build_report.txt"))
    ap.add_argument("--strict", action="store_true", help="경고가 있으면 실패(exit 1)")
    args = ap.parse_args()

    cfg = json.loads(Path(args.config).read_text(encoding="utf-8"))
    report: list[str] = []
    warnings: list[str] = []
    now = dt.datetime.now(dt.timezone.utc).astimezone().isoformat(timespec="seconds")
    subjects = [build_subject(s, report, warnings) for s in cfg["subjects"]]

    sources = []
    for s in cfg["subjects"]:
        for key in ("trueDocx", "falseDocx"):
            p = ROOT / s[key]
            sources.append({"subject": s["id"], "kind": "true" if key == "trueDocx" else "false",
                            "file": s[key], "sha1": hashlib.sha1(p.read_bytes()).hexdigest()[:12]})
    content_hash = h8(json.dumps([s["items"] for s in subjects], ensure_ascii=False, sort_keys=True))
    # 내용이 그대로면 generatedAt 도 유지 → 재빌드해도 git diff 가 생기지 않음
    try:
        prev = json.loads(Path(args.out).read_text(encoding="utf-8"))
        if prev.get("version") == content_hash:
            now = prev.get("generatedAt", now)
    except (OSError, ValueError):
        pass
    data = {
        "schemaVersion": SCHEMA_VERSION,
        "version": content_hash,
        "generatedAt": now,
        "sources": sources,
        "subjects": subjects,
    }
    Path(args.out).write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")

    head = [f"OX 퀴즈 데이터 빌드 리포트  ({now})", f"출력: {Path(args.out).relative_to(ROOT)}  version={content_hash}", ""]
    tail = [f"경고 {len(warnings)}건", *[f" - {w}" for w in warnings]] if warnings else ["경고 0건"]
    text = "\n".join(head + report + tail) + "\n"
    Path(args.report).write_text(text, encoding="utf-8")
    print(text)
    return 1 if (args.strict and warnings) else 0


if __name__ == "__main__":
    sys.exit(main())
