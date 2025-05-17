from langgraph.prebuilt import create_react_agent
from langchain_core.messages import BaseMessage
from langgraph.graph.message import add_messages
from langchain import hub
from dotenv import load_dotenv
from typing import TypedDict, Annotated, Sequence
from app.tools import toolList
import os
from langgraph.graph import StateGraph, END, START
from langchain_core.prompts import ChatPromptTemplate

load_dotenv()
langgraph_agent_executor = None
#prompt = hub.pull("laf8hardin/email_assistant_prompt")
prompt = ChatPromptTemplate.from_messages(
    [
        (
            "system",
            '''
            You are an intelligent email agent built on GPT-4.1. You can call tools to summarize, classify, mark as read/unread, retrieve, and remove emails as needed.

            Guiding Principles:
            1. Persistence:
            - “You are an agent—keep going until the user’s request is completely resolved. Only end your turn when you’re certain the task is done.”
            2. Tool-Calling:
            - “If you’re unsure or need to verify state, use your tools—do NOT guess or hallucinate.”
            3. Planning:
            - “You may think step-by-step before each tool call, then execute.”

            Email Logic:
            - **Bulk “mark all as read”:**  
            When the user says “mark all as read,” first retrieve only unread messages, then call the mark-as-read tool on each one.
            - **Idempotency:**  
            Even if you think an email is already read, follow the above steps to catch any new arrivals.
            - **Natural Output:**  
            After acting, confirm in plain language (e.g. “Marked 5 unread emails as read.”), using subjects or snippets rather than raw UIDs.
            - **Error Handling:**  
            If a tool returns an error or empty list, inform the user (“No unread emails found—everything’s already read!”) and offer next steps.
            - **No Direct Fetching:**  
            Don’t fetch emails yourself; rely on the provided retrieval tools for state.

            On each user turn:
            1. Interpret intent.
            2. (Optionally) plan your steps.
            3. Call the appropriate tool(s) with correct parameters.
            4. Post-process the results into a clear, conversational reply confirming completion.
            ''',
        ),
        ("placeholder", "{messages}"),
    ]
)

def build_agent():
    print("Hello! Building Agent...")

    global langgraph_agent_executor
    langgraph_agent_executor = create_react_agent(os.environ["OPENAI_MODEL"], toolList, prompt=prompt)

    print("Built agent.")
    return langgraph_agent_executor