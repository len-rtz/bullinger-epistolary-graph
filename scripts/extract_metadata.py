#!/usr/bin/env python3
"""
extract_metadata.py
-------------------
Parses Bullinger Digital TEI-XML files to produce graph index files.

Outputs:
  letters_index.json     — one entry per letter
  persons_index.json     — one entry per person
  places_index.json      — one entry per place
  person_edges.json      — directed person→person edges (letter volume)
  location_arcs.json     — directed place→place arcs (sending location → receiving)

TEI sources (BULLINGER DIGITAL!):
  {BASE_DIR}/letters/   
  {BASE_DIR}/index/persons.xml
  {BASE_DIR}/index/localities.xml

"""

import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path
from lxml import etree

# ── Configuration ─────────────────────────────────────────────────────────────

BASE_DIR    = Path("../data")
LETTERS_DIR = BASE_DIR / "letters"
INDEX_DIR   = BASE_DIR / "index"
OUT_DIR     = Path("../graph")

# TEI namespace
NS = {"tei": "http://www.tei-c.org/ns/1.0"}

# Bullinger's person ID 
BULLINGER_ID = "p495"

# Portrait base URL (raw GitHub content)
PORTRAIT_BASE = (
    "https://raw.githubusercontent.com/stazh/bullinger-korpus-tei"
    "/main/data/portraits/"
)

# ── Helpers ───────────────────────────────────────────────────────────────────

def normalise_person_id(raw: str) -> str:
    return raw.strip().lstrip("#").lower()


def normalise_place_id(raw: str) -> str:
    return raw.strip().lstrip("#").lower()


def parse_date(when: str | None) -> str | None:
    """
    Return ISO date string padded to YYYY-MM-DD, or None if unparseable.
    """
    if not when:
        return None
    when = when.strip()
    if re.fullmatch(r"\d{4}", when):
        return f"{when}-01-01"
    if re.fullmatch(r"\d{4}-\d{2}", when):
        return f"{when}-01"
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", when):
        return when
    return None


# ── Step 1: Parse persons index ───────────────────────────────────────────────

def parse_persons(path: Path) -> dict:
    """
    Returns dict: person_id (lowercase) → {
        id, name, gnd, wiki, portrait, letter_count, dominant_topic
    }
    """
    print(f"  Parsing: {path}")
    tree = etree.parse(str(path))
    root = tree.getroot()

    persons = {}
    entries = root.findall(".//tei:person", NS)
    print(f"  Found {len(entries)} person entries")

    for person in entries:
        # xml:id on <person> is uppercase e.g. "P1"
        #  normalise everything to lowercase
        raw_id = person.get("{http://www.w3.org/XML/1998/namespace}id", "")
        pid = normalise_person_id(raw_id)
        if not pid:
            continue

        #  name from first <persName type="main">
        main_name = person.find('tei:persName[@type="main"]', NS)
        if main_name is not None:
            surname  = main_name.findtext("tei:surname",  default="", namespaces=NS).strip()
            forename = main_name.findtext("tei:forename", default="", namespaces=NS).strip()
            name = f"{forename} {surname}".strip() if forename else surname
        else:
            name = pid  # fallback

        gnd      = None
        wiki     = None
        portrait = None

        for idno in person.findall("tei:idno", NS):
            subtype = idno.get("subtype", "")
            text    = (idno.text or "").strip()
            if not text:
                continue
            if subtype == "gnd":
                gnd = text
            elif subtype == "wiki":
                wiki = text
            elif subtype == "portrait":
                portrait = PORTRAIT_BASE + text

        persons[pid] = {
            "id":             pid,
            "name":           name,
            "gnd":            gnd,
            "wiki":           wiki,
            "portrait":       portrait,
            "letter_count":   0,     # filled during letter pass
            "dominant_topic": None,  # filled after topic merge
        }

    return persons


# ── Step 2: Parse localities index ────────────────────────────────────────────

def parse_places(path: Path) -> dict:
    """
    Returns dict: place_id (lowercase) → {
        id, name, district, country, lat, lon, geonames, letter_count
    }
    """
    print(f"  Parsing: {path}")
    tree = etree.parse(str(path))
    root = tree.getroot()

    places = {}
    entries = root.findall(".//tei:place", NS)
    print(f"  Found {len(entries)} place entries")

    for place in entries:
        raw_id = place.get("{http://www.w3.org/XML/1998/namespace}id", "")
        plid = normalise_place_id(raw_id)
        if not plid:
            continue

        settlement = place.findtext("tei:settlement", default="", namespaces=NS).strip()
        district   = place.findtext("tei:district",   default="", namespaces=NS).strip()
        country    = place.findtext("tei:country",    default="", namespaces=NS).strip()

        geo_text = place.findtext(".//tei:geo", default="", namespaces=NS).strip()
        lat = lon = None
        if geo_text:
            parts = geo_text.split()
            if len(parts) == 2:
                try:
                    lat, lon = float(parts[0]), float(parts[1])
                except ValueError:
                    pass

        geonames = None
        for idno in place.findall("tei:idno", NS):
            if idno.get("subtype") == "geonames":
                geonames = (idno.text or "").strip()

        places[plid] = {
            "id":           plid,
            "name":         settlement or plid,
            "district":     district or None,
            "country":      country or None,
            "lat":          lat,
            "lon":          lon,
            "geonames":     geonames,
            "letter_count": 0,
        }

    return places


# ── Step 3: Parse all letter XMLs ─────────────────────────────────────────────

def parse_letters(
    letters_dir: Path,
    persons: dict,
    places:  dict,
) -> tuple[list, list, list]:
    """
    Iterates all letter XMLs and returns:
      letters        — list of letter index dicts
      person_edges   — list of {source, target, weight}
      location_arcs  — list of {source_place, target_place, weight, letter_ids}
    """
    xml_files = sorted(
        letters_dir.glob("*.xml"),
        key=lambda p: int(p.stem) if p.stem.isdigit() else 0,
    )
    total = len(xml_files)
    print(f"  Found {total} letter XML files")

    letters = []
    person_pair_counts  = defaultdict(int)
    location_arc_counts = defaultdict(int)
    location_arc_letters = defaultdict(list)
    errors = 0

    for i, xml_path in enumerate(xml_files):
        if i % 1000 == 0:
            print(f"    {i}/{total} letters processed...")

        try:
            tree = etree.parse(str(xml_path))
        except etree.XMLSyntaxError as e:
            print(f"    [WARN] Skipping {xml_path.name}: {e}")
            errors += 1
            continue

        root      = tree.getroot()
        letter_id = xml_path.stem

        # ── BD deep-link URL (use url already in TEI) ──
        bd_url = None
        for idno in root.findall(".//tei:idno[@subtype='url']", NS):
            if idno.get("resp") == "icl":
                bd_url = (idno.text or "").strip()
                break
        if not bd_url:
            bd_url = f"https://bullinger-digital.ch/letter/{letter_id}"

        # ── correspAction parsing ────────────────────────────────────────────
        sent_action = root.find('.//tei:correspAction[@type="sent"]',     NS)
        recv_action = root.find('.//tei:correspAction[@type="received"]', NS)

        sender_ids = []
        if sent_action is not None:
            for pn in sent_action.findall("tei:persName", NS):
                ref = pn.get("ref", "").strip()
                if ref:
                    sender_ids.append(normalise_person_id(ref))

        recipient_ids = []
        if recv_action is not None:
            for pn in recv_action.findall("tei:persName", NS):
                ref = pn.get("ref", "").strip()
                if ref:
                    recipient_ids.append(normalise_person_id(ref))

        sender_id = sender_ids[0] if sender_ids else None

        place_id = None
        if sent_action is not None:
            pl = sent_action.find("tei:placeName", NS)
            if pl is not None:
                ref = pl.get("ref", "").strip()
                if ref:
                    place_id = normalise_place_id(ref)

        date_str = None
        if sent_action is not None:
            de = sent_action.find("tei:date", NS)
            if de is not None:
                date_str = parse_date(de.get("when"))

        # ── Letter record ────────────────────────────────────────────────────
        record = {
            "id":             letter_id,
            "date":           date_str,
            "sender_id":      sender_id,
            "recipient_ids":  recipient_ids,
            "place_id":       place_id,
            "bd_url":         bd_url,
            # PLACEHOLDER 
            "dominant_topic": None,
            "citation_count": 0,
            "top_citations":  [],
        }
        letters.append(record)

        # ── Increment letter counts ──────────────────────────────────────────
        for pid in set(sender_ids + recipient_ids):
            if pid in persons:
                persons[pid]["letter_count"] += 1

        if place_id and place_id in places:
            places[place_id]["letter_count"] += 1

        # ── Person edges: sender → each recipient ────────────────────────────
        if sender_id:
            for rid in recipient_ids:
                if rid and rid != sender_id:
                    person_pair_counts[(sender_id, rid)] += 1

        # ── Location arcs: sending place → receiving place ───────────────────
        if place_id:
            recv_place_id = None
            if recv_action is not None:
                rp = recv_action.find("tei:placeName", NS)
                if rp is not None:
                    ref = rp.get("ref", "").strip()
                    if ref:
                        recv_place_id = normalise_place_id(ref)
            arc_key = (place_id, recv_place_id or "unknown")
            location_arc_counts[arc_key] += 1
            location_arc_letters[arc_key].append(letter_id)

    print(f"  Parsed {len(letters)} letters ({errors} errors skipped)")

    person_edges = [
        {"source": src, "target": tgt, "weight": w}
        for (src, tgt), w in sorted(person_pair_counts.items(), key=lambda x: -x[1])
    ]

    location_arcs = [
        {
            "source_place": src,
            "target_place": tgt,
            "weight":       w,
            "letter_ids":   location_arc_letters[(src, tgt)],
        }
        for (src, tgt), w in sorted(location_arc_counts.items(), key=lambda x: -x[1])
    ]

    return letters, person_edges, location_arcs


# ── Step 4: Write JSON outputs ────────────────────────────────────────────────

def write_json(path: Path, data, label: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    size_kb = path.stat().st_size / 1024
    count   = len(data)
    print(f"  ✓  {label}: {count} entries → {path.name} ({size_kb:.1f} KB)")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():

    for check, label in [
        (LETTERS_DIR,              "letters directory"),
        (INDEX_DIR / "persons.xml",    "persons index"),
        (INDEX_DIR / "localities.xml", "localities index"),
    ]:
        if not Path(check).exists():
            sys.exit(f"[ERROR] {label} not found: {check}")

    print("\n[1/4] Parsing persons index...")
    persons = parse_persons(INDEX_DIR / "persons.xml")

    print("\n[2/4] Parsing localities index...")
    places  = parse_places(INDEX_DIR / "localities.xml")

    print("\n[3/4] Parsing letter XMLs...")
    letters, person_edges, location_arcs = parse_letters(LETTERS_DIR, persons, places)

    print("\n[4/4] Writing output files...")
    write_json(OUT_DIR / "letters_index.json",  letters,               "letters_index")
    write_json(OUT_DIR / "persons_index.json",  list(persons.values()), "persons_index")
    write_json(OUT_DIR / "places_index.json",   list(places.values()),  "places_index")
    write_json(OUT_DIR / "person_edges.json",   person_edges,           "person_edges")
    write_json(OUT_DIR / "location_arcs.json",  location_arcs,          "location_arcs")

    print(f"\nAll outputs written to: {OUT_DIR.resolve()}")
    
if __name__ == "__main__":
    main()
