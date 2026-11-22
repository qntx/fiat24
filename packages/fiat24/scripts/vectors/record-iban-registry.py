#!/usr/bin/env python3
"""Record the raw oracle inputs of vectors/core/iban-registry.json: for every country in the
SDK's IBAN_CODE_LENGTHS table, the SWIFT IBAN Registry electronic example plus a
broken-check-digits and a truncated copy, each with two verdicts — `valid` from schwifty
(independent of the SDK) and `docCheck` from the docs' generic check (uppercase, strip
non-alphanumerics, ^[A-Z]{2}[0-9]{2}[A-Z0-9]+$, per-country length, ISO 7064 mod-97 of the
rearranged digits equals 1) recomputed here in Python.
Usage: <python with schwifty> record-iban-registry.py <registry-lengths.tsv> <src/core/iban.ts>
"""
import importlib.metadata
import json
import re
import sys

from schwifty import IBAN

TSV, SDK = sys.argv[1], sys.argv[2]

examples = {}
for line in open(TSV):
    parts = line.rstrip("\n").split("\t")
    if len(parts) >= 3:
        examples[parts[0]] = (int(parts[1]), parts[2])

src = open(SDK).read()
block = re.search(r"IBAN_CODE_LENGTHS[^=]*=\s*\{(.*?)\};", src, re.S).group(1)
table = {c: int(n) for c, n in re.findall(r"(\w{2}):\s*(\d+),", block)}

def verdict(iban):
    try:
        IBAN(iban)
        return True, None
    except Exception as e:
        return False, type(e).__name__

def doc_check(candidate):
    text = re.sub(r"[^A-Z0-9]", "", candidate.upper())
    m = re.match(r"^([A-Z]{2})([0-9]{2})([A-Z0-9]+)$", text)
    if not m or examples.get(m.group(1), (None,))[0] != len(text):
        return False
    rearranged = text[4:] + text[:4]
    digits = "".join(str(ord(ch) - 55) if ch.isalpha() else ch for ch in rearranged)
    return int(digits) % 97 == 1

cases = []
for country in sorted(table):
    length, iban = examples[country]
    check = int(iban[2:4])
    altered = f"{iban[:2]}{(check + 1) % 97:02d}{iban[4:]}"
    for variant, candidate in (("registry", iban), ("check-digits", altered),
                               ("truncated", iban[:-1])):
        valid, error = verdict(candidate)
        case = {"country": country, "variant": variant, "iban": candidate,
                "valid": valid, "docCheck": doc_check(candidate)}
        if error is not None:
            case["error"] = error
        cases.append(case)

out = {
    "lengths": {c: examples[c][0] for c in sorted(table)},
    "provenance": {
        "registry": "SWIFT IBAN Registry",
        "version": "Release 103 (Sep 2026)",
        "url": "https://www.swift.com/swift-resource/9606/download?language=en",
        "input": "registry-103-lengths.tsv (country, length, electronic example)",
        "countries": "every entry of IBAN_CODE_LENGTHS (78 incl. LY)",
        "validator": f"schwifty {importlib.metadata.version('schwifty')}",
        "docCheck": "docs' generic check recomputed by this script (see module docstring)",
        "command": " ".join(sys.argv),
        "date": "2026-11-22",
    },
    "cases": cases,
}
json.dump(out, sys.stdout, indent=2)
print()
