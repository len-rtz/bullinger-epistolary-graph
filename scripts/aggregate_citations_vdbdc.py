import json
import pickle
import re
from collections import defaultdict
from pathlib import Path
import re

# ── Configuration ─────────────────────────────────────────────────────────────

BDC_RETRIEVAL_PKL = Path("../bullinger-patristic-detection/retrieval/data_BIG/candidates_top20.pkl") 
CE_RESULTS_JSON   = Path("../bullinger-patristic-detection/retrieval/VD/locisimiles-e5-phil-v2/results-locisimiles-e5-phil-v2.json")           
LETTERS_INDEX     = Path("../data/graph/letters_index.json")
PSC_INDEX         = Path("../data/graph/psc_index.json")
DETAIL_DIR        = Path("../data/citations/detail")
CITATIONS_INDEX   = Path("../data/citations/letter_citations_index.json")
BDC_CHUNKS_JSON = Path("../bullinger-patristic-detection/data_BIG/bdc_chunks_FULL.json")

BI_SCORE_FLOOR    = 0.2   # threshold
MIN_TOKENS        = 10    # minimum tokens in BDC chunk to be included
TOP_K_DETAIL      = 20     # max works in detail panel
TOP_K_INDEX       = 5      # max works in graph index

# ── Helpers ───────────────────────────────────────────────────────────────────

def source_to_work_id(source_id: str) -> str:
    return re.sub(r"_window_\d+$", "", source_id)

def chunk_to_letter_id(chunk_id: str) -> str:
    return chunk_id.split("_")[0]

def is_degenerate_chunk(chunk_id: str, bdc_chunk_tokens: dict, min_tokens: int = 3) -> bool:
    """Returns True if chunk should be excluded."""
    # Too short
    if bdc_chunk_tokens.get(chunk_id, 999) < min_tokens:
        return True
    return False

def is_degenerate_bdc_text(text: str) -> bool:
    """Returns True if chunk text is effectively empty or numbers-only."""
    if not text:
        return True
    # Strip punctuation and whitespace, check if only digits remain
    cleaned = re.sub(r"[\s\d\.\,\;\:\!\?\-\(\)\[\]\"\'\/\\]", "", text)
    if len(cleaned) < 5:   # fewer than 5 non-numeric, non-punctuation characters
        return True
    return False

# ── Load inputs ───────────────────────────────────────────────────────────────

with open(LETTERS_INDEX, encoding="utf-8") as f:
    letters_list = json.load(f)
letters_meta = {str(l["id"]): l for l in letters_list}
print(f"  {len(letters_meta)} letters in index")

with open(PSC_INDEX, encoding="utf-8") as f:
    psc_raw = json.load(f)
psc_index = {f["id"]: f for f in psc_raw.get("fathers", [])}

with open(BDC_CHUNKS_JSON, encoding="utf-8") as f:
    bdc_raw = json.load(f)
chunk_text = {c["chunk_id"]: c["text"] for c in bdc_raw["chunks"]}
bdc_chunk_tokens = {c["chunk_id"]: c.get("token_count", 999) for c in bdc_raw["chunks"]}

# reverse lookups
work_to_cf = {}
work_meta  = {}
for cf in psc_index.values():
    for w in cf.get("works", []):
        wid = w["work_id"]
        work_to_cf[wid] = cf["id"]
        work_meta[wid]  = {
            "title":      w.get("title", wid),
            "source_url": w.get("source_url"),
        }
print(f"  {len(work_to_cf)} works in reverse lookup")

# BDC chunk text lookup
chunk_text = {}
if BDC_CHUNKS_JSON.exists():
    with open(BDC_CHUNKS_JSON, encoding="utf-8") as f:
        raw = json.load(f)
    chunk_text = {c["chunk_id"]: c["text"] for c in raw["chunks"]}
    print(f"  {len(chunk_text)} BDC chunks loaded for text lookup")

# CE results for VD-BDC letters
ce_lookup = defaultdict(dict)   # chunk_id → source_id → judgment_score
if CE_RESULTS_JSON.exists():
    with open(CE_RESULTS_JSON, encoding="utf-8") as f:
        ce_results = json.load(f)
    for chunk_id, candidates in ce_results.items():
        if not isinstance(candidates, list):
            continue
        for cand in candidates:
            if not isinstance(cand, dict):
                continue
            ce_lookup[chunk_id][cand["source_id"]] = round(cand["judgment_score"], 6)
    print(f"  CE results loaded for {len(ce_lookup)} chunks")

# Full BDC retrieval pkl
print(f"  Loading {BDC_RETRIEVAL_PKL}...")
with open(BDC_RETRIEVAL_PKL, "rb") as f:
    retrieval = pickle.load(f)
print(f"  {len(retrieval)} chunks in retrieval pkl")

# ── Aggregate ─────────────────────────────────────────────────────────────────

# letter_id → work_id → {max_score, cf_id, evidence}
letter_work_data = defaultdict(lambda: defaultdict(lambda: {
    "max_score": 0.0,
    "cf_id":     None,
    "evidence":  [],
}))

unresolved = set()
skipped    = 0
included   = 0

for chunk_id, candidates in retrieval.items():
    letter_id = chunk_to_letter_id(chunk_id)

    # Skip short chunks
    if bdc_chunk_tokens.get(chunk_id, 999) < MIN_TOKENS:
        skipped += 1
        continue

    # Skip number-only or near-empty BDC chunks
    bdc_text_preview = chunk_text.get(chunk_id, "")
    if is_degenerate_bdc_text(bdc_text_preview):
        skipped += 1
        continue

    for cand in candidates:
        if hasattr(cand, "segment"):
            source_id = cand.segment.id
            bi_score  = round(float(cand.score), 6)
        else:
            source_id = cand["source_id"]
            bi_score  = round(float(cand["candidate_score"]), 6)

        if bi_score < BI_SCORE_FLOOR:
            skipped += 1
            continue

        work_id = source_to_work_id(source_id)
        cf_id   = work_to_cf.get(work_id)
        if not cf_id:
            unresolved.add(work_id)
            continue

        judgment_score = ce_lookup.get(chunk_id, {}).get(source_id)

        entry = letter_work_data[letter_id][work_id]
        entry["cf_id"] = cf_id

        evidence_item = {
            "bdc_chunk_id":    chunk_id,
            "bdc_text":        chunk_text.get(chunk_id, ""),
            "psc_chunk_id":    source_id,
            "psc_text":        "",
            "candidate_score": bi_score,
            "ce_score":        judgment_score,
        }
        entry["evidence"].append(evidence_item)

        if bi_score > entry["max_score"]:
            entry["max_score"] = bi_score

        included += 1

print(f"  Included: {included} candidates (bi >= {BI_SCORE_FLOOR})")
print(f"  Skipped:  {skipped} below threshold")
if unresolved:
    print(f"  Unresolved work IDs: {len(unresolved)}")
    for w in sorted(unresolved)[:5]:
        print(f"    {w}")
print(f"  {len(letter_work_data)} letters with at least one candidate")

# ── Write detail JSONs ────────────────────────────────────────────────────────

DETAIL_DIR.mkdir(parents=True, exist_ok=True)
citations_index = []

for letter_id, works in letter_work_data.items():
    meta = letters_meta.get(letter_id, {})

    sorted_works = sorted(
        works.items(),
        key=lambda x: x[1]["max_score"],
        reverse=True
    )[:TOP_K_DETAIL]

    citations = []
    for rank, (work_id, entry) in enumerate(sorted_works, 1):
        evidence = sorted(
            entry["evidence"],
            key=lambda e: e["candidate_score"],
            reverse=True
        )
        # Flag whether CE confirmation is available
        has_ce = any(e["ce_score"] is not None for e in evidence)
        citations.append({
            "rank":       rank,
            "cf_id":      entry["cf_id"],
            "work_id":    work_id,
            "max_score":  entry["max_score"],
            "ce_confirmed": has_ce,
            "evidence":   evidence,
        })

    detail = {
        "letter_id":      letter_id,
        "bd_url":         meta.get("bd_url", f"https://bullinger-digital.ch/letter/{letter_id}"),
        "dominant_topic": meta.get("dominant_topic"),
        "topic_dist":     meta.get("topic_dist"),
        "citations":      citations,
        "biblical_hits":  [],
    }

    out_path = DETAIL_DIR / f"{letter_id}.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(detail, f, ensure_ascii=False, indent=2)

    top5 = [
        {
            "cf_id":    entry["cf_id"],
            "work_id":  work_id,
            "ce_score": entry["max_score"],
            "ce_confirmed": any(e["ce_score"] is not None for e in entry["evidence"]),
        }
        for work_id, entry in sorted_works[:TOP_K_INDEX]
    ]
    citations_index.append({
        "letter_id":      letter_id,
        "citation_count": len(sorted_works),
        "top_citations":  top5,
    })

CITATIONS_INDEX.parent.mkdir(parents=True, exist_ok=True)
with open(CITATIONS_INDEX, "w", encoding="utf-8") as f:
    json.dump(citations_index, f, ensure_ascii=False, indent=2)

# ── Summary ───────────────────────────────────────────────────────────────────

total_works = sum(len(w) for w in letter_work_data.values())
vdbdc_count = sum(
    1 for letter_id in letter_work_data
    if any(
        any(e["ce_score"] is not None for e in entry["evidence"])
        for entry in letter_work_data[letter_id].values()
    )
)

print(f"\n✓ {len(letter_work_data)} detail files → {DETAIL_DIR}")
print(f"✓ citations index → {CITATIONS_INDEX}")
print(f"\nSummary:")
print(f"  Letters with citations:       {len(letter_work_data)}")
print(f"  — with CE confirmation:       {vdbdc_count}")
print(f"  — bi-encoder only:            {len(letter_work_data) - vdbdc_count}")
print(f"  Total work citations:         {total_works}")
print(f"  Avg works per letter:         {total_works / len(letter_work_data):.1f}")

cf_counts = defaultdict(int)
for works in letter_work_data.values():
    seen = set()
    for entry in works.values():
        cf_id = entry["cf_id"]
        if cf_id and cf_id not in seen:
            cf_counts[psc_index[cf_id]["name"]] += 1
            seen.add(cf_id)

print(f"\nTop church fathers by letter coverage:")
for name, count in sorted(cf_counts.items(), key=lambda x: -x[1])[:10]:
    print(f"  {count:4d}  {name}")
