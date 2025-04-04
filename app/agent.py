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
            '''You are a helpful email assistant for managing the inbox.

            After you are able to discern all the information, call the relevant tool.

            If you are unsure which email the user is referring too, ask the user to clarify which email they would like to act on, or specify all emails.
            ''',
        ),
        ("placeholder", "{messages}"),
    ]
)

class AgentState(TypedDict):
    messages: Annotated[Sequence[BaseMessage], add_messages]

def build_agent():
    print("Hello! Building Agent...")

    global langgraph_agent_executor
    langgraph_agent_executor = create_react_agent(os.environ["OPENAI_MODEL"], toolList, prompt=prompt)
    builder = StateGraph(AgentState)

    #define nodes
    builder.add_node("agentNode", langgraph_agent_executor)

    #define edges
    builder.add_edge(START, "agentNode")
    builder.add_edge("agentNode", END)

    print("Built agent.")
    return builder.compile()