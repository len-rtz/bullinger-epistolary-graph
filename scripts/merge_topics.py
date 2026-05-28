#!/usr/bin/env python3
"""
merge_topics.py
---------------
Merges FASTopic output into letters_index.json and generates topics_meta.json.

Inputs:
  theta_D_seeded_regest_K20_seed43.npy   — (n_letters, K) topic distributions
  theta_D_letter_ids.json                — ["file10708", "file10709", ...]
  topics_D_seeded_regest_K20_seed43.json — top words per topic (list of K strings)
  output/graph/letters_index.json        — existing letter index

Outputs:
  output/graph/letters_index.json        — updated in place with dominant_topic + topic_dist
  output/topics/topics_meta.json         — topic metadata for the frontend

"""

import json
import numpy as np
from pathlib import Path

# ── Configuration ─────────────────────────────────────────────────────────────

THETA_NPY      = Path("../bullinger-topic-modelling/results/theta_D_seeded_regest_K20_seed43.npy")
LETTER_IDS_JSON = Path("../bullinger-topic-modelling/results/theta_D_letter_ids.json")
TOPICS_JSON    = Path("../bullinger-topic-modelling/results/topics_D_seeded_regest_K20_seed43.json")
LETTERS_INDEX  = Path("../data/graph/letters_index.json")
TOPICS_META    = Path("../data/topics/topics_meta.json")

# Topics to treat as noise — dominant_topic set to null for these
# topic_dist still stored 
NOISE_TOPICS   = {9, 10}


# ── Load inputs ───────────────────────────────────────────────────────────────

theta = np.load(THETA_NPY)
print(f"  theta shape: {theta.shape}")

with open(LETTER_IDS_JSON, encoding="utf-8") as f:
    raw_ids = json.load(f)

# Strip "file" prefix
letter_ids = [s.replace("file", "") for s in raw_ids]
print(f"  letter IDs: {len(letter_ids)}")

with open(TOPICS_JSON, encoding="utf-8") as f:
    topic_words_raw = json.load(f)
# Each entry is a space-separated string of top words
topic_top_words = [entry.split() for entry in topic_words_raw]
K = len(topic_top_words)
print(f"  topics: {K}")

assert theta.shape == (len(letter_ids), K), \
    f"Shape mismatch: theta {theta.shape} vs {len(letter_ids)} letters × {K} topics"

with open(LETTERS_INDEX, encoding="utf-8") as f:
    letters = json.load(f)
print(f"  letters in index: {len(letters)}")

# ── Build lookup: letter_id → row index in theta ──────────────────────────────

id_to_row = {lid: i for i, lid in enumerate(letter_ids)}
print(f"  mapped {len(id_to_row)} letter IDs")

# ── Merge topic distributions into letters_index ──────────────────────────────

matched   = 0
unmatched = 0

for letter in letters:
    lid = str(letter["id"])
    if lid not in id_to_row:
        unmatched += 1
        letter["dominant_topic"] = None
        letter["topic_dist"]     = None
        continue

    row  = id_to_row[lid]
    dist = theta[row].tolist()

    # dominant topic = argmax, exclude noise topics
    scores_clean = [
        (i, v) for i, v in enumerate(dist)
        if i not in NOISE_TOPICS
    ]
    dominant = max(scores_clean, key=lambda x: x[1])[0] if scores_clean else None

    letter["dominant_topic"] = dominant
    letter["topic_dist"]     = [round(float(v), 6) for v in dist]
    matched += 1

print(f"  matched: {matched}, unmatched: {unmatched}")

# ── Write updated letters_index ───────────────────────────────────────────────

with open(LETTERS_INDEX, "w", encoding="utf-8") as f:
    json.dump(letters, f, ensure_ascii=False, indent=2)
print(f"  ✓ updated {LETTERS_INDEX}")

# ── Generate topics_meta.json ─────────────────────────────────────────────────

TOPICS_META.parent.mkdir(parents=True, exist_ok=True)

topics_meta = []
for i in range(K):
    is_noise = i in NOISE_TOPICS
    topics_meta.append({
        "id":        i,
        "label":     f"Topic {i + 1}",   # placeholder — edit in JSON before deploying
        "top_words": topic_top_words[i],
        "color":     f"Topic {i + 1}", # placeholder — colors assigned in json 
        "noise":     is_noise,
    })

with open(TOPICS_META, "w", encoding="utf-8") as f:
    json.dump({"topics": topics_meta}, f, ensure_ascii=False, indent=2)
print(f"  ✓ written {TOPICS_META}")

# ── Summary ───────────────────────────────────────────────────────────────────

print("\nTopic distribution summary:")
from collections import Counter
counts = Counter(
    l["dominant_topic"] for l in letters
    if l.get("dominant_topic") is not None
)
for tid in sorted(counts):
    noise_flag = " [noise]" if tid in NOISE_TOPICS else ""
    words = " ".join(topic_top_words[tid][:5])
    print(f"  Topic {tid:2d}{noise_flag}: {counts[tid]:5d} letters — {words}")
