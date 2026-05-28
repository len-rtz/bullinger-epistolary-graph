#!/usr/bin/env python3
"""
Merges letter_citations_index.json into letters_index.json,
updating citation_count and top_citations fields.

Run after aggregate_citations_vdbdc.py.
"""

import json
from pathlib import Path

LETTERS_INDEX    = Path("../data/graph/letters_index.json")
CITATIONS_INDEX  = Path("../data/citations/letter_citations_index.json")

with open(LETTERS_INDEX, encoding="utf-8") as f:
    letters = json.load(f)

with open(CITATIONS_INDEX, encoding="utf-8") as f:
    citations = json.load(f)

cit_lookup = {str(c["letter_id"]): c for c in citations}
print(f"  {len(cit_lookup)} letters with citations")

updated = 0
for letter in letters:
    lid = str(letter["id"])
    if lid in cit_lookup:
        letter["citation_count"] = cit_lookup[lid]["citation_count"]
        letter["top_citations"]  = cit_lookup[lid]["top_citations"]
        updated += 1

with open(LETTERS_INDEX, "w", encoding="utf-8") as f:
    json.dump(letters, f, ensure_ascii=False, indent=2)

print(f"  Updated {updated} letters in {LETTERS_INDEX}")
