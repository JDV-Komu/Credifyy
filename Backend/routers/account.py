# routers/account.py
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel
from supabase import create_client
import os

router = APIRouter()

_supabase = None
def get_supabase():
    """Create the Supabase client on first use, so the app can still start
    (and /scan can still work) even if Supabase env vars aren't set yet."""
    global _supabase
    if _supabase is None:
        url = os.getenv("SUPABASE_URL")
        key = os.getenv("SUPABASE_SERVICE_KEY")
        if not url or not key:
            raise HTTPException(status_code=503,
                detail="Supabase is not configured on the server (.env missing SUPABASE_URL / SUPABASE_SERVICE_KEY)")
        _supabase = create_client(url, key)
    return _supabase

class EmailBody(BaseModel):
    email: str
    current_password: str

class PasswordBody(BaseModel):
    password: str
    current_password: str

class DeleteBody(BaseModel):
    current_password: str

def verify_password(email: str, password: str):
    supabase = get_supabase()
    try:
        supabase.auth.sign_in_with_password({"email": email, "password": password})
    except Exception:
        raise HTTPException(status_code=401, detail="Incorrect password")

@router.put("/account/email")
async def change_email(body: EmailBody, authorization: str = Header(alias="authorization")):
    token = authorization.replace("Bearer ", "")
    supabase = get_supabase()
    user = supabase.auth.get_user(token)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid token")
    verify_password(user.user.email, body.current_password)
    supabase.auth.admin.update_user_by_id(user.user.id, {"email": body.email})
    return {"message": "Email updated"}

@router.put("/account/password")
async def change_password(body: PasswordBody, authorization: str = Header(alias="authorization")):
    token = authorization.replace("Bearer ", "")
    supabase = get_supabase()
    user = supabase.auth.get_user(token)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid token")
    verify_password(user.user.email, body.current_password)
    supabase.auth.admin.update_user_by_id(user.user.id, {"password": body.password})
    return {"message": "Password updated"}

@router.delete("/account")
async def delete_account(body: DeleteBody, authorization: str = Header(alias="authorization")):
    token = authorization.replace("Bearer ", "")
    supabase = get_supabase()
    user = supabase.auth.get_user(token)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid token")
    verify_password(user.user.email, body.current_password)
    supabase.auth.admin.delete_user(user.user.id)
    return {"message": "Account deleted"}


## getting user stats (gyatt) ##
# ## this is where the change delete email stuff happens
# # @router.put("/account/email")
# # async def change_email(body: dict, authorization: str = Header(alias="authorization")):
# #     token = authorization.replace("Bearer ", "")
# #     supabase = get_supabase()
#     user = supabase.auth.get_user(token)
# #     if not user:
# #         raise HTTPException(status_code=401, detail="Invalid token")
# #     supabase.auth.admin.update_user_by_id(user.user.id, { "email": body["email"] })
# #     return { "message": "Email updated" }

# # @router.delete("/account")
# # async def delete_account(authorization: str = Header(alias="authorization")):
# #     token = authorization.replace("Bearer ", "")
# #     # Get user from token first
# #     supabase = get_supabase()
#     user = supabase.auth.get_user(token)
# #     if not user:
# #         raise HTTPException(status_code=401, detail="Invalid token")
    
# #     supabase.auth.admin.delete_user(user.user.id)
# #     return { "message": "Account deleted" }