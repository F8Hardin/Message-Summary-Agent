from fastapi import FastAPI, HTTPException, status, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from dotenv import load_dotenv
import os
from app.tools import fetch_emails, get_stored_emails, stored_emails, remove_email, classify_email, summarize_email, mark_as_read, unmark_as_read
from app.agent import build_agent
from langchain.schema import AIMessage
from typing import List

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

    try:
        state = await graph.ainvoke({
            "messages": chatHistory + [("user", request.user_input)],
        })

        chatHistory = state["messages"]

        msgs = state["messages"]

        last_calls = []
        for msg in reversed(state["messages"]):
            if isinstance(msg, AIMessage):
                tc = msg.additional_kwargs.get("tool_calls")
                if tc:
                    last_calls = tc
                    break

        print("API Agent State Response:", state)
        return {
            "agent_message": msgs[-1],
            "tool_calls" : last_calls
        }

    except Exception as e:
        import traceback
        error_trace = traceback.format_exc()

        print("API Error from agent:", e)

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
    return get_stored_emails()

@app.get("/getStoredEmailsWithUIDs")
async def get_stored_emails_with_uids(uids: List[int] = Query(..., description="One or more email UIDs to fetch, e.g. ?uids=101&uids=30558")):
    return [
        email_obj
        for uid, email_obj in stored_emails.items()
        if uid in uids
    ]

@app.get("/removeEmail")
async def trigger_remove_email(uid: int):
    return await remove_email.ainvoke({})

@app.get("/getEmailById") #not yet tested
async def get_email_by_id(uid: int):
    emails = get_stored_emails()
    for email_obj in emails:
        if email_obj.get("uid") == uid:
            return email_obj

    raise HTTPException(status_code=404, detail=f"No email found with UID {uid}")

@app.get("/classifyEmail")
async def trigger_classify_email(uid: int):
    return await classify_email.ainvoke({"uid": uid})

@app.get("/summarizeEmail")
async def trigger_summarize_email(uid: int):
    return await summarize_email.ainvoke({"uid": uid})

@app.get("/markAsRead")
async def trigger_mark_as_read(uid: int):
    return await mark_as_read.ainvoke({"uid": uid})

@app.get("/unmarkAsRead")
async def trigger_unmark_as_read(uid: int):
    return await unmark_as_read.ainvoke({"uid": uid})