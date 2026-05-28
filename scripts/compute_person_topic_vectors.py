#!/usr/bin/env python3
import json
import numpy as np
from collections import defaultdict
from pathlib import Path

LETTERS_INDEX  = Path("../data/graph/letters_index.json")
OUTPUT         = Path("../data/graph/person_topic_vectors.json")

with open(LETTERS_INDEX, encoding="utf-8") as f:
    letters = json.load(f)

# Collect topic_dist per person (as sender or recipient)
person_dists = defaultdict(list)
skipped = 0

for letter in letters:
    dist = letter.get("topic_dist")
    if not dist:
        skipped += 1
        continue

    persons = set()
    if letter.get("sender_id"):
        persons.add(letter["sender_id"])
    for r in letter.get("recipient_ids") or []:
        if r:
            persons.add(r)

    for pid in persons:
        person_dists[pid].append(dist)

print(f"  {skipped} letters skipped (no topic_dist)")
print(f"  {len(person_dists)} persons with at least one letter")

# Compute mean topic vector per person
result = {}
for pid, dists in person_dists.items():
    arr = np.array(dists)
    result[pid] = np.mean(arr, axis=0).round(6).tolist()

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
with open(OUTPUT, "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)

size_kb = OUTPUT.stat().st_size / 1024
print(f"\n✓ {OUTPUT} ({size_kb:.1f} KB)")
print(f"  {len(result)} person vectors written")
