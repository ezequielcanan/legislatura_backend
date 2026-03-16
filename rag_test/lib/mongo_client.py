"""
MongoDB client - connects to the existing legislatura database
and extracts expediente data for reprocessing.
"""
from typing import List, Dict, Optional
from pymongo import MongoClient
from config import Config


def get_client() -> MongoClient:
    return MongoClient(Config.MONGODB_URI)


def get_db(client: MongoClient):
    return client[Config.MONGODB_DB]


def fetch_completed_expedientes(
    limit: int = Config.MAX_EXPEDIENTES,
    skip: int = 0,
) -> List[Dict]:
    """
    Fetch expedientes that have been fully processed (COMPLETED status)
    and have pdfText available.  Returns lean documents with only the
    fields we need for the RAG pipeline.
    """
    client = get_client()
    db = get_db(client)

    pipeline = [
        {
            "$match": {
                "status": "completed",
                "pdfText": {"$exists": True, "$ne": ""},
            }
        },
        {"$sort": {"fechaIngresoDate": -1}},
        {"$skip": skip},
        {"$limit": limit},
        {
            "$project": {
                "_id": 1,
                "expedienteId": 1,
                "numero": 1,
                "titulo": 1,
                "sumario": 1,
                "tipo": 1,
                "estado": 1,
                "fechaIngreso": 1,
                "fechaIngresoDate": 1,
                "autor": 1,
                "coautores": 1,
                "pdfText": 1,
                "aiSummary": 1,
                "aiTags": 1,
                "aiCategory": 1,
                "libros": 1,
                "baeSource": 1,
            }
        },
    ]

    expedientes = list(db.expedientes.aggregate(pipeline))
    client.close()
    return expedientes


def fetch_expediente_pdf_urls(limit: int = Config.MAX_EXPEDIENTES) -> List[Dict]:
    """
    Fetch expedientes that still need PDF processing.
    Returns expedienteId + pdf URLs from libros array.
    """
    client = get_client()
    db = get_db(client)

    pipeline = [
        {
            "$match": {
                "libros": {"$exists": True, "$not": {"$size": 0}},
            }
        },
        {"$sort": {"fechaIngresoDate": -1}},
        {"$limit": limit},
        {
            "$project": {
                "expedienteId": 1,
                "numero": 1,
                "titulo": 1,
                "tipo": 1,
                "autor": 1,
                "fechaIngreso": 1,
                "aiSummary": 1,
                "aiTags": 1,
                "aiCategory": 1,
                "pdfText": 1,
                "libros": 1,
                "baeSource": 1,
            }
        },
    ]

    expedientes = list(db.expedientes.aggregate(pipeline))
    client.close()
    return expedientes


def count_expedientes(status: Optional[str] = None) -> int:
    client = get_client()
    db = get_db(client)
    query = {}
    if status:
        query["status"] = status
    count = db.expedientes.count_documents(query)
    client.close()
    return count
