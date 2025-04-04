# test_prompt_agent.py

import asyncio
from app.agent import build_agent
from app.tools import updated_UIDs
from fastapi import status

# run with python -m app.testTheAgent


# Simulate the global chat history used in your API
chatHistory = []

# Build the agent graph
graph = build_agent()

async def test_prompt(user_input: str):
    print("TESTING PROMPT")
    global chatHistory
    global graph

    try:
        state = await graph.ainvoke({
            "messages": [("user", user_input)],
        })

        chatHistory = state["messages"]

        print("Last updated:", updated_UIDs)
        print("Message from Agent:", state["messages"][-1])

        return {
            "message": state["messages"][-1],
            "updated_UIDs": updated_UIDs
        }

    except Exception as e:
        import traceback
        error_trace = traceback.format_exc()

        return {
            "status_code" : status.HTTP_500_INTERNAL_SERVER_ERROR,
            "content" :{
                "error": str(e),
                "trace": error_trace
            }
        }

if __name__ == "__main__":
    # Replace this with any test prompt you'd like
    asyncio.run(test_prompt("summarize my emails"))