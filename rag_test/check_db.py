"""Quick check of expediente statuses and data availability."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))

from lib.mongo_client import get_client, get_db

client = get_client()
db = get_db(client)

# Check distinct statuses
print("Distinct status values:")
statuses = db.expedientes.distinct("status")
print(f"  {statuses}")

# Count docs with pdfText
has_pdf = db.expedientes.count_documents({"pdfText": {"$exists": True, "$ne": ""}})
print(f"\nDocs with pdfText: {has_pdf}")

# Count total
total = db.expedientes.count_documents({})
print(f"Total docs: {total}")

# Sample one doc to see fields
sample = db.expedientes.find_one({}, {"status": 1, "pdfText": {"$slice": 100} if False else 1, "aiSummary": 1, "aiTags": 1, "numero": 1, "titulo": 1, "tipo": 1, "expedienteId": 1})
if sample:
    print(f"\nSample doc fields:")
    for k, v in sample.items():
        if k == "pdfText":
            print(f"  {k}: {'[' + str(len(v)) + ' chars]' if v else 'EMPTY'}")
        else:
            print(f"  {k}: {v}")

client.close()
