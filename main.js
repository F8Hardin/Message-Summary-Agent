import dotenv from 'dotenv';
dotenv.config();
import { app, BrowserWindow, ipcMain } from 'electron';

let isAgentProcessing = false; // Global lock

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    minWidth: 1080,
    minHeight: 720,
    webPreferences: {
      nodeIntegration: true, // For quick development, use preload for prod
      contextIsolation: false,
      // preload: path.join(__dirname, 'preload.js'), // Uncomment if using a preload script
    },
  });
  mainWindow.loadFile('index.html');
  return mainWindow;
}

let mainWindow;

app.whenReady().then(async () => {
  mainWindow = createWindow();
  
  mainWindow.webContents.on('did-finish-load', async () => {
    showProcessingMessage("AI getting unread emails and processing...");
    await fetchProcessAndRenderEmails();
    removeProcessingMessage();

    setInterval(() => {
      if (!isAgentProcessing) {
        fetchProcessAndRenderEmails();
      } else {
        console.log("Skipping email fetch because agent processing is in progress.");
      }
    }, 300000); // 5 minutes
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});


async function fetchProcessAndRenderEmails() {
  try {
    console.log("📥 Fetching emails...");
    await fetch(`${process.env.PYAGENT_ENDPOINT}/fetchEmails`, {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });

    // Step 1: Get stored emails after fetch
    let res = await fetch(`${process.env.PYAGENT_ENDPOINT}/getStoredEmails`);
    let emails = await res.json();

    // Step 2: Summarize and classify each email
    for (const email of emails) {
      const uid = email.uid;

      const alreadySummarized = !!email.summary;
      const alreadyClassified = !!(email.classification?.priority && email.classification?.category);

      if (!alreadySummarized) {
        console.log(`📝 Summarizing email UID ${uid}`);
        try {
          await fetch(`${process.env.PYAGENT_ENDPOINT}/summarizeEmail?uid=${uid}`);
        } catch (err) {
          console.warn(`Failed to summarize UID ${uid}`, err);
        }
      }

      if (!alreadyClassified) {
        console.log(`🏷️ Classifying email UID ${uid}`);
        try {
          await fetch(`${process.env.PYAGENT_ENDPOINT}/classifyEmail?uid=${uid}`);
        } catch (err) {
          console.warn(`Failed to classify UID ${uid}`, err);
        }
      }
    }

    res = await fetch(`${process.env.PYAGENT_ENDPOINT}/getStoredEmails`);
    emails = await res.json();
    
    if (Array.isArray(emails)) {
      emails.forEach(email => showEmail(email));
    } else {
      console.warn("Unexpected response from getStoredEmails:", emails);
    }
  } catch (err) {
    console.error("Error during fetch/classify/summarize:", err);
    showChat({ role: "Agent", message: "An error occurred during startup processing. Try requesting fewer emails." });
  }
}

// Quit the app when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

function showEmail(data) {
  console.log("Sending email data to renderer.");
  BrowserWindow.getAllWindows().forEach(win => {
    win.webContents.send('showEmail', data);
  });
}

function removeEmail(data) {
  console.log("Removing email data from renderer.");
  BrowserWindow.getAllWindows().forEach(win => {
    win.webContents.send('removeEmail', data);
  });
}

function showChat(data) {
  console.log("Sending chat data to renderer.");
  BrowserWindow.getAllWindows().forEach(win => {
    win.webContents.send('showChat', data);
  });
}

function showProcessingMessage(message) {
  BrowserWindow.getAllWindows().forEach(win => {
    win.webContents.send("showProcessing", { message });
  });
}

function removeProcessingMessage() {
  BrowserWindow.getAllWindows().forEach(win => {
    win.webContents.send("removeProcessing", {});
  });
}

ipcMain.handle('submitPrompt', async (event, userInput) => {
  console.log("🔍 AI Agent processing prompt...");
  isAgentProcessing = true; // Lock: agent processing starts
  showProcessingMessage("Agent processing request:", userInput)

  try {
    // Send user input to the agent API
    const res = await fetch(process.env.PYAGENT_ENDPOINT + "/promptAgent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_input: userInput }),
    });
    const result = await res.json();

    if (res.status == 500){
      showChat({ role: "Agent", message: result.error});
      console.error("Server error:", result.error);
      console.error("Trace:", result.trace);
    }

    console.log("Agent Message:", result.agent_message.content);
    console.log("Tool Calls:", result.tool_calls);
    
    const updatedUIDs = new Set();
    const clearedUIDs = new Set();
    
    for (const call of result.tool_calls) {
      const toolName = call.function.name;
      let args;
      try {
        args = JSON.parse(call.function.arguments);
      } catch (e) {
        console.warn("Could not parse args for", toolName, call.function.arguments);
        continue;
      }
    
      const uid = args.uid;
      if (typeof uid !== "number") continue;
    
      switch (toolName) {
        case "remove_email":
          clearedUIDs.add(uid);
          break;
    
        default:
          updatedUIDs.add(uid);
          break;
      }
    }
    
    console.log("Updated UIDs:", updatedUIDs);
    console.log("Cleared UIDs:", clearedUIDs);

    //getting updates
    if (updatedUIDs.size > 0) {
      const params = new URLSearchParams();
      updatedUIDs.forEach(uid => params.append("uids", uid));
      const response = await fetch(
        `${process.env.PYAGENT_ENDPOINT}/getStoredEmailsWithUIDs?${params.toString()}`,
        {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
      
      if (!response.ok) {
        throw new Error(`Failed to fetch emails: ${response.statusText}`);
      }

      // render updated
      const emailsArray = await response.json();
      emailsArray.forEach(emailObj => showEmail(emailObj));
    }
    
    // remove cleared
    for (const uid of clearedUIDs) {
      removeEmail(uid);
    }

    showChat({ role: "Agent", message: result.agent_message.content });
    isAgentProcessing = false;
    removeProcessingMessage()
    return result.agent_message;
  } catch (err) {
    console.error("Agent processing failed:", err);
    showChat({ role: "Agent", message: "Agent processing error."});
    isAgentProcessing = false;
    removeProcessingMessage();
    return "An error occurred while processing your prompt.";
  }
});

ipcMain.handle("markAsRead", async (event, uid) => {
  const res = await fetch(`${process.env.PYAGENT_ENDPOINT}/markAsRead?uid=${uid}`);
  return await res.json();
});

ipcMain.handle("unmarkAsRead", async (event, uid) => {
  const res = await fetch(`${process.env.PYAGENT_ENDPOINT}/unmarkAsRead?uid=${uid}`);
  return await res.json();
});