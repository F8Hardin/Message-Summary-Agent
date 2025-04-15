#!/bin/bash

# Navigate to script directory
cd "$(dirname "$0")"

# Start FastAPI backend
echo "🔧 Starting FastAPI server..."
uvicorn app.main:app --reload --port 9119 &
FASTAPI_PID=$!

# Wait until FastAPI is responding
echo "⏳ Waiting for FastAPI to be ready..."
until curl -s http://localhost:9119/docs > /dev/null; do
  sleep 1
done
echo "✅ FastAPI is running!"

# # Wait for LM Studio to be online
# echo "⏳ Waiting for LM Studio to start..."
# until curl -s http://localhost:1234/v1/models > /dev/null; do
#   sleep 1
# done
# echo "✅ LM Studio API is live!"

# # Wait until a model is actually loaded
# echo "⏳ Waiting for a model to be loaded in LM Studio..."
# until [ "$(curl -s http://localhost:1234/v1/models | jq '.data | length')" -gt 0 ]; do
#   sleep 1
# done
# echo "✅ A model is loaded in LM Studio!"

# Start Electron app
echo "🚀 Launching Electron app..."
npm start

# Optional cleanup: kill FastAPI after Electron exits
echo "🧹 Shutting down FastAPI..."
kill $FASTAPI_PID
