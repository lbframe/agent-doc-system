"""Ledger API process."""
import ledger_core
import ledger_proto
from fastapi import FastAPI
from sqlalchemy import create_engine
import redis
import boto3

app = FastAPI()
engine = create_engine("postgresql+psycopg://localhost/ledger")
cache = redis.Redis()
store = boto3.client("s3")
store.upload_fileobj(None, "uploads", "object")


@app.get("/health")
def health():
    return {"ok": True}


def main():
    return app
