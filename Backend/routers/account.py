# routers/account.py
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel
from supabase import create_client
import os

router = APIRouter()
supabase = create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_SERVICE_KEY"))

class EmailBody(BaseModel):
    email: str

class PasswordBody(BaseModel):
    password: str

@router.put("/account/email")
async def change_email(body: EmailBody, authorization: str = Header(alias="authorization")):
    token = authorization.replace("Bearer ", "")
    user = supabase.auth.get_user(token)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid token")
    supabase.auth.admin.update_user_by_id(user.user.id, { "email": body.email })
    return { "message": "Email updated" }

@router.put("/account/password")
async def change_password(body: PasswordBody, authorization: str = Header(alias="authorization")):
    token = authorization.replace("Bearer ", "")
    user = supabase.auth.get_user(token)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid token")
    supabase.auth.admin.update_user_by_id(user.user.id, { "password": body.password })
    return { "message": "Password updated" }

@router.delete("/account")
async def delete_account(authorization: str = Header(alias="authorization")):
    token = authorization.replace("Bearer ", "")
    user = supabase.auth.get_user(token)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid token")
    supabase.auth.admin.delete_user(user.user.id)
    return { "message": "Account deleted" }


## this is where the change delete email stuff happens
# @router.put("/account/email")
# async def change_email(body: dict, authorization: str = Header(alias="authorization")):
#     token = authorization.replace("Bearer ", "")
#     user = supabase.auth.get_user(token)
#     if not user:
#         raise HTTPException(status_code=401, detail="Invalid token")
#     supabase.auth.admin.update_user_by_id(user.user.id, { "email": body["email"] })
#     return { "message": "Email updated" }

# @router.delete("/account")
# async def delete_account(authorization: str = Header(alias="authorization")):
#     token = authorization.replace("Bearer ", "")
#     # Get user from token first
#     user = supabase.auth.get_user(token)
#     if not user:
#         raise HTTPException(status_code=401, detail="Invalid token")
    
#     supabase.auth.admin.delete_user(user.user.id)
#     return { "message": "Account deleted" }