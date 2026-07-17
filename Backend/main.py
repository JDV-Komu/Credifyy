import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

load_dotenv()  # must run BEFORE importing routers that read env vars

from routers import scan, account

app = FastAPI()
ALLOWED_ORIGINS = [
    "https://credify-project.netlify.app",  # production frontend
    "http://localhost:5500",          # local dev (Live Server)
    "http://127.0.0.1:5500",          # local dev (Live Server)
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(scan.router)     # /scan credibility endpoint
app.include_router(account.router)  # /account endpoints