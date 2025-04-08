from fastapi import FastAPI, HTTPException, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from dotenv import load_dotenv
import os
from app.tools import fetch_emails, get_stored_emails, updated_UIDs, remove_email, cleared_UIDs
from app.agent import build_agent

#run with uvicorn app.main:app --reload --port 9119

load_dotenv()

app = FastAPI()
graph = build_agent()
chatHistory = []

def print_stream(stream):
    for s in stream:
        message = s["messages"][-1]
        if isinstance(message, tuple):
            print(message)
        else:
            message.pretty_print()

class AgentPrompt(BaseModel):
    user_input: str

@app.post("/promptAgent")
async def prompt_agent(request: AgentPrompt):
    global chatHistory
    global graph
    global updated_UIDs

    try:
        state = await graph.ainvoke({
            "messages": chatHistory + [("user", request.user_input)],
        })

        chatHistory = state["messages"]

        # print("Last updated:", lastUpdatedEmails)
        # print("Message from Agent:", state["messages"][-1])
        updated = updated_UIDs.copy() #tracking updated data
        updated_UIDs.clear()

        cleared = cleared_UIDs.copy() #tracking deleted data
        cleared_UIDs.clear()
        return {
            "agent_message": state["messages"][-1],
            "updated_UIDs": updated,
            "cleared_UIDs" : cleared
        }

    except Exception as e:
        import traceback
        error_trace = traceback.format_exc()

        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={
                "error": str(e),
                "trace": error_trace
            }
        )

@app.post("/fetchEmails")
async def trigger_fetch_emails():
    return await fetch_emails.ainvoke({})

@app.get("/getStoredEmails")
async def trigger_get_stored_emails():
    return await get_stored_emails.ainvoke({})

@app.get("/removeEmail")
async def trigger_get_stored_emails(uid: int):
    return await remove_email.ainvoke({})

@app.get("/getEmailById")
async def get_email_by_id(uid: int):
    emails = await get_stored_emails.ainvoke({})
    email = emails.get(uid)
    if not email:
        raise HTTPException(status_code=404, detail="Email not found.")
    return email