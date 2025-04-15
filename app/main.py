from fastapi import FastAPI, HTTPException, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from dotenv import load_dotenv
import os
from app.tools import fetch_emails, get_stored_emails, updated_UIDs, remove_email, cleared_UIDs, classify_email, summarize_email, mark_as_read, unmark_as_read
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
    global cleared_UIDs

    cleared_UIDs.clear()
    updated_UIDs.clear()

    try:
        state = await graph.ainvoke({
            "messages": chatHistory + [("user", request.user_input)],
        })

        print("State", state)
        chatHistory = state["messages"]

        # print("Last updated:", lastUpdatedEmails)
        # print("Message from Agent:", state["messages"][-1])
        updated = updated_UIDs.copy() #tracking updated data
        cleared = cleared_UIDs.copy() #tracking deleted data


        print("API Returning Agent Message:", state["messages"][-1])
        print("API Returning Updated UIDs:", updated)
        print("API Returning Cleared UIDs:", cleared)
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
    return get_stored_emails()

@app.get("/removeEmail")
async def trigger_get_stored_emails(uid: int):
    return await remove_email.ainvoke({})

@app.get("/getEmailById")
async def get_email_by_id(uid: int):
    emails = get_stored_emails()
    email = emails.get(uid)
    if not email:
        raise HTTPException(status_code=404, detail="Email not found.")
    return email

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