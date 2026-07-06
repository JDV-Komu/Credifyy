import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

load_dotenv()

print("URL:", os.getenv("SUPABASE_URL"))
print("KEY:", os.getenv("SUPABASE_SERVICE_KEY"))

#note to self: this should load AFTER load_dotenv function()
from routers import account, scan
app = FastAPI()
app.include_router(account.router)
app.include_router(scan.router)  # /scan credibility endpoint

# This allows your HTML file to talk to Python
# Without this, the browser will block every request
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten this in production
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(account.router)  # register it