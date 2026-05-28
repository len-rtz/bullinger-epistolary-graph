#!/usr/bin/env python3
"""
patch_full_corpus_texts.py
---------------------------
Joins BDC and PSC chunk texts into all detail JSONs.
Handles both VD-BDC and full-corpus detail files.

"""

import json
from pathlib import Path

BDC_CHUNKS_JSON = Path("../bullinger-patristic-detection/data_BIG/bdc_chunks_FULL.json")
PSC_CHUNKS_JSON = Path("../bullinger-patristic-detection/data_BIG/psc_chunks_with_chapters.json")
DETAIL_DIR      = Path("../data/citations/detail")

# ── Load text lookups ───────────────────────────────────────────────────

with open(BDC_CHUNKS_JSON, encoding="utf-8") as f:
    bdc_raw = json.load(f)
bdc_text = {c["chunk_id"]: c["text"] for c in bdc_raw["chunks"]}
print(f"  {len(bdc_text):,} BDC chunks loaded")

with open(PSC_CHUNKS_JSON, encoding="utf-8") as f:
    psc_raw = json.load(f)
psc_text = {c["chunk_id"]: c["text"] for c in psc_raw["chunks"]}
print(f"  {len(psc_text):,} PSC chunks loaded")

# ── Patch detail files ────────────────────────────────────────────────────────

detail_files = list(DETAIL_DIR.glob("*.json"))
print(f"\nPatching {len(detail_files)} detail files...")

bdc_filled = 0
psc_filled = 0
bdc_missing = 0
psc_missing = 0
files_changed = 0

for path in detail_files:
    with open(path, encoding="utf-8") as f:
        detail = json.load(f)

    changed = False

    for citation in detail.get("citations", []):
        for ev in citation.get("evidence", []):

            # BDC text
            if not ev.get("bdc_text"):
                text = bdc_text.get(ev["bdc_chunk_id"], "")
                if text:
                    ev["bdc_text"] = text
                    bdc_filled += 1
                    changed = True
                else:
                    bdc_missing += 1

            # PSC text
            if not ev.get("psc_text"):
                text = psc_text.get(ev["psc_chunk_id"], "")
                if text:
                    ev["psc_text"] = text
                    psc_filled += 1
                    changed = True
                else:
                    psc_missing += 1

    if changed:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(detail, f, ensure_ascii=False, indent=2)
        files_changed += 1

print(f"\n✓ {files_changed} files updated")
print(f"\n  BDC text: {bdc_filled} filled, {bdc_missing} still missing")
print(f"  PSC text: {psc_filled} filled, {psc_missing} still missing")

if bdc_missing > 0:
    print(f"\n  [WARN] {bdc_missing} BDC chunk IDs not found in {BDC_CHUNKS_JSON}")
    print(f"         Check that bdc_chunks.json covers the full corpus, not just VD-BDC")
if psc_missing > 0:
    print(f"\n  [WARN] {psc_missing} PSC chunk IDs not found in {PSC_CHUNKS_JSON}")